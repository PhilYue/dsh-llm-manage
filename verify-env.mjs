/**
 * dsh-llm-manage — the shared environment both Node suites run in.
 *
 * Decides whether the suites run against a real deployment (`real`) or a
 * synthetic catalogue (`synthetic`), and hands back the route, model list and
 * profile fields to use.
 *
 * This is one module on purpose. `verify.mjs` (Host half) and
 * `verify-client.mjs` (browser half) must not be able to disagree about which
 * world they are in — the same class of bug as the two plugin halves disagreeing
 * about a field name, which is exactly what the client suite exists to catch.
 *
 * Import order matters: the profile and credential store are located here, at
 * import time, from the caller's original `DSH_HOME`. ESM hoists imports above
 * the importing file's own statements, so importing this module first is enough
 * — the caller may redirect `DSH_HOME` afterwards.
 *
 * @module verify-env
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Settings namespace the LLM provider plugin owns. */
export const settingsNs = 'llm-pi-ai'

/** Where the DSH checkout might be, most specific first. */
export const checkoutCandidates = [
  process.env.DSH_CHECKOUT,
  join(HERE, '..', 'deepseek-harness'),
  join(homedir(), 'deepseek-harness'),
].filter(candidate => typeof candidate === 'string' && candidate !== '')

/**
 * Locate the DSH checkout, or explain how to point at it.
 *
 * The checkout holds the real modules these suites exercise (the Tool registry,
 * React, jsdom) and is not vendored here, so a missing one is an environment
 * problem rather than a test failure — hence exit 2, not 1.
 *
 * @param {string} probe - a path inside the checkout that must exist.
 * @returns {string} the checkout root.
 */
export function checkoutRootOrExit(probe = 'package.json') {
  const hit = checkoutCandidates.find(candidate => existsSync(join(candidate, probe)))
  if (hit !== undefined) return hit
  console.error(
    'dsh-llm-manage verification: cannot find the DSH checkout.\n' +
    `Looked for ${probe} under:\n${checkoutCandidates.map(c => `  ${c}`).join('\n')}\n` +
    'Point DSH_CHECKOUT at the deepseek-harness checkout root, e.g.\n' +
    '  DSH_CHECKOUT=/path/to/deepseek-harness node verify.mjs',
  )
  process.exit(2)
}

// ── the real deployment, if this machine has one ────────────────────────────
const realDshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
export const profilePatchPath = join(realDshHome, 'profiles', process.env.DSH_PROFILE ?? 'web', 'cordis.patch.yml')
export const credentialsPath = join(realDshHome, '.credentials.yaml')

/**
 * Read one credential by the name the profile declares for it.
 *
 * The name comes from the profile's `apiKeyEnv`, so these suites name no
 * particular gateway and work where a differently-named key is stored.
 *
 * @param {string} path - credentials file.
 * @param {string} name - credential key.
 * @returns {string | undefined} the value, or undefined when it is absent.
 */
function readCredential(path, name) {
  if (!existsSync(path)) return undefined
  const text = readFileSync(path, 'utf8')
  const match = new RegExp(`^\\s*${name}\\s*:\\s*["']?([A-Za-z0-9_-]+)`, 'm').exec(text)
  return match === null ? undefined : match[1]
}

/**
 * The fields a profile declares directly for one provider route.
 *
 * Only fields at the route's own child indent are read: anything deeper belongs
 * to a nested block such as its `models:` list.
 *
 * @param {string} text - profile patch contents.
 * @param {string} route - provider route key.
 * @returns {Record<string, string>} the profile's own fields.
 */
function readRouteFields(text, route) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => new RegExp(`^\\s+${route}:\\s*$`).test(line))
  if (start === -1) return {}
  const indent = lines[start].search(/\S/)
  const fields = {}
  let childIndent
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const own = line.search(/\S/)
    if (own <= indent) break
    if (childIndent === undefined) childIndent = own
    if (own !== childIndent) continue
    const field = /^\s*([A-Za-z][A-Za-z0-9_]*):\s*(\S.*)$/.exec(line)
    if (field === null) continue
    fields[field[1]] = field[2].trim().replace(/^["']|["']$/g, '')
  }
  return fields
}

/**
 * Provider route keys declared under the profile's `providers:` block.
 * @param {string} text - profile patch contents.
 * @returns {string[]} route keys in declaration order.
 */
function readRoutes(text) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => /^\s*providers:\s*$/.test(line))
  if (start === -1) return []
  const indent = lines[start].search(/\S/)
  const routes = []
  let childIndent
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const own = line.search(/\S/)
    if (own <= indent) break
    if (childIndent === undefined) childIndent = own
    if (own !== childIndent) continue
    const key = /^\s*([A-Za-z0-9._-]+):\s*$/.exec(line)
    if (key !== null) routes.push(key[1])
  }
  return routes
}

/**
 * The model ids a profile declares for one route, from its `models:` list.
 * @param {string} text - profile patch contents.
 * @param {string} route - provider route key.
 * @returns {string[]} declared model ids.
 */
function readRouteModels(text, route) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => new RegExp(`^\\s+${route}:\\s*$`).test(line))
  if (start === -1) return []
  const routeIndent = lines[start].search(/\S/)
  // Bound the search to this route's own block, so a later route's `models:`
  // cannot be read as this one's.
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (line.search(/\S/) <= routeIndent) { end = i; break }
  }
  const modelsAt = lines.findIndex((line, i) => i > start && i < end && /^\s*models:\s*$/.test(line))
  if (modelsAt === -1) return []
  const modelsIndent = lines[modelsAt].search(/\S/)
  const ids = []
  for (let i = modelsAt + 1; i < end; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (line.search(/\S/) <= modelsIndent) break
    const id = /^\s*-\s*id:\s*(\S+)/.exec(line)
    if (id !== null) ids.push(id[1].replace(/^["']|["']$/g, ''))
  }
  return ids
}

// ── the synthetic world ─────────────────────────────────────────────────────
const SYNTHETIC_ROUTE = 'example-route'
const SYNTHETIC_MODELS = ['model-alpha', 'model-beta', 'model-gamma', 'model-delta', 'model-epsilon']
const SYNTHETIC_FIELDS = {
  displayName: 'Example Gateway',
  apiKeyEnv: 'EXAMPLE_GATEWAY_API_KEY',
  api: 'openai-completions',
  // A reserved TLD: if a stub is ever missed, the request fails to resolve
  // instead of reaching something real.
  baseURL: 'http://example-gateway.invalid/v1',
}

const profileText = existsSync(profilePatchPath) ? readFileSync(profilePatchPath, 'utf8') : undefined
const foundRoute = profileText === undefined ? undefined : readRoutes(profileText)[0]
const foundFields = foundRoute === undefined || profileText === undefined
  ? undefined
  : readRouteFields(profileText, foundRoute)
const foundModels = foundRoute === undefined || profileText === undefined
  ? []
  : readRouteModels(profileText, foundRoute)
const foundKey = foundFields?.apiKeyEnv === undefined
  ? undefined
  : readCredential(credentialsPath, foundFields.apiKeyEnv)

const usableReal = foundFields?.baseURL !== undefined && foundKey !== undefined && foundModels.length > 0

/**
 * `real` when this machine has a usable deployment, else `synthetic`.
 * `LLMM_VERIFY_MODE` forces one, and asking for `real` without one is an error
 * rather than a silent downgrade.
 */
export const mode = process.env.LLMM_VERIFY_MODE ?? (usableReal ? 'real' : 'synthetic')
if (mode !== 'real' && mode !== 'synthetic') {
  throw new Error(`LLMM_VERIFY_MODE must be "real" or "synthetic", not "${mode}"`)
}
if (mode === 'real' && !usableReal) {
  throw new Error(
    `LLMM_VERIFY_MODE=real was requested, but no usable profile was found at ${profilePatchPath}` +
    ` (route=${foundRoute ?? 'none'} key=${foundKey === undefined ? 'missing' : 'present'} models=${foundModels.length})`,
  )
}

/** Provider route under test. */
export const route = mode === 'real' ? foundRoute : SYNTHETIC_ROUTE
/** Models the route advertises, in the order the profile lists them. */
export const models = mode === 'real' ? foundModels : SYNTHETIC_MODELS
/** The route's own profile fields, as `settings.describe()` would project them. */
export const profileFields = mode === 'real' ? foundFields : SYNTHETIC_FIELDS
/** Credential value the plugin will present, if any. */
export const apiKey = mode === 'real' ? foundKey : 'synthetic-not-a-real-key'
/** Human-facing route name. */
export const displayName = profileFields.displayName ?? route

/**
 * Fixture models are addressed by position, never by name, so the suites carry
 * no real model id and still work against a catalogue of any size.
 * @param {number} index - position.
 * @returns {string} a model id.
 */
export const at = (index) => models[index % models.length]

/** The route's config as `settings.describe()` would project it. */
export const settings = { providers: { [route]: { ...profileFields, models } } }

/**
 * Serve the gateway locally.
 *
 * The plugin calls the global `fetch` for its directory read and its probes.
 * Stubbing it keeps that code under test while making the run hermetic: no
 * credential, no network, same result every time.
 *
 * @param {string | URL} url - request target.
 * @returns {Promise<Response>} a synthetic gateway response.
 */
export async function syntheticGatewayFetch(url) {
  const href = String(url)
  const json = (body) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  if (href.includes('/models')) return json({ data: models.map(id => ({ id, name: id })) })
  if (href.includes('/chat/completions')) {
    return json({ choices: [{ message: { role: 'assistant', content: 'pong' } }] })
  }
  throw new Error(`synthetic mode has no route for ${href}`)
}

/**
 * Install {@link syntheticGatewayFetch} as the global fetch, in synthetic mode.
 * @returns {boolean} whether it was installed.
 */
export function installSyntheticGateway() {
  if (mode !== 'synthetic') return false
  globalThis.fetch = syntheticGatewayFetch
  return true
}
