/**
 * dsh-llm-manage — out-of-process verification.
 *
 * Runs the real `index.js` against the real DSH modules (the Tool registry and
 * its JSON-Schema validator), with `DSH_HOME` redirected to a throwaway
 * directory so the user's own overlay is untouched.
 *
 * Two modes, selected automatically:
 *
 *   real       This machine has a profile whose first provider route resolves,
 *              plus that route's credential. The settings under test are then
 *              the deployed ones and the gateway is read live. This is the mode
 *              that catches a fixture agreeing with a wrong assumption.
 *   synthetic  Otherwise. A stubbed fetch serves a synthetic catalogue, so every
 *              code path still runs — offline, deterministically, and without a
 *              credential or an internal endpoint. This is the mode that lets
 *              anyone run the suite.
 *
 *   node verify.mjs
 *   LLMM_VERIFY_MODE=synthetic node verify.mjs    # force one mode
 *
 * Exits non-zero on the first failed expectation. This is a development
 * artifact; it is not part of the installed runtime surface.
 */
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  apiKey as API_KEY,
  at,
  checkoutRootOrExit,
  displayName as DISPLAY_NAME,
  installSyntheticGateway,
  mode,
  models as MODELS,
  profileFields as REAL_PROFILE_FIELDS,
  route as ROUTE,
  settings as SETTINGS,
  settingsNs as SETTINGS_NS,
} from './verify-env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// The environment (checkout, mode, route, models, profile fields) lives in one
// shared module so this suite and the browser suite cannot disagree about which
// world they are running in.
const DH = checkoutRootOrExit(join('packages', 'core', 'tools', 'lib', 'index.js'))
const TOOLS = join(DH, 'packages/core/tools/lib/index.js')

// Redirect the plugin's durable storage before importing it. Importing
// ./verify-env.mjs above has already located the real profile and credential
// store, which is why the redirect can happen here.
const HOME = mkdtempSync(join(tmpdir(), 'llmm-verify-'))
process.env.DSH_HOME = HOME

const tools = await import(TOOLS)
const plugin = await import(join(HERE, 'index.js'))

// In synthetic mode the gateway is served locally, so the directory read and the
// probes still run real plugin code without a credential or a network.
installSyntheticGateway()

const listeners = {}
const registered = []
let routes = []
const connection = { fetch: { register: (r) => { routes.push(r); return () => {} } } }

/** A Cordis scope stand-in exposing only what this plugin uses. */
function mkScope() {
  return guard({
    tools: { register: (d) => { registered.push(d); return () => {} } },
    on: (name, cb) => { (listeners[name] ??= []).push(cb); return () => {} },
    effect: (fn) => { const d = typeof fn === 'function' ? fn() : undefined; return typeof d === 'function' ? d : () => {} },
    get: (k) => (k === 'connection' ? connection : hostGet(k)),
  }, true)
}
// The real settings service has NO getter: it publishes one descriptor per
// active profile entry through describe(), keyed by entry id. Modelling that
// exactly is what catches a plugin that assumes a getter exists.
const settingsService = {
  describe: () => [{
    ns: SETTINGS_NS,
    autoGenerate: true,
    schema: {},
    revision: 1,
    applies: 'live',
    value: SETTINGS,
    base: SETTINGS,
    user: SETTINGS,
  }],
}
const hostGet = (k) => {
  if (k === 'connection') return connection
  if (k === 'settings') return settingsService
  if (k === 'credentials') return { resolve: async () => ({ value: API_KEY, source: 'test' }) }
  if (k === 'llm') return llmService
  return undefined
}
const llmService = {
  listProviders: () => [{ id: ROUTE, name: DISPLAY_NAME }],
  // settingsPath is the directory's own path from the section root to this
  // provider's profile; llm-pi-ai declares ['providers', provider].
  listConfigurableProviders: () => [{ provider: ROUTE, displayName: DISPLAY_NAME, settingsNs: SETTINGS_NS, settingsPath: ['providers', ROUTE] }],
  listModels: async () => MODELS.map(id => ({ id, name: id })),
}

/**
 * Install Cordis's inject guard for `llm` on a context object.
 *
 * Assigning (rather than spreading) matters: a getter must stay lazy, so the
 * throw happens at the offending read, not while the test builds its fixture.
 *
 * @param {object} target - the context to guard.
 * @param {boolean} injected - whether this scope declared `llm`.
 * @returns {object} the same target.
 */
function guard(target, injected) {
  Object.defineProperty(target, 'llm', {
    configurable: true,
    get() {
      if (!injected) throw new Error('cannot get property "llm" without inject')
      return llmService
    },
  })
  return target
}
const ctx = guard({
  inject: (_names, cb) => { cb(mkScope()) },
  on: (name, cb) => { (listeners[name] ??= []).push(cb); return () => {} },
  effect: (fn) => { const d = typeof fn === 'function' ? fn() : undefined; return typeof d === 'function' ? d : () => {} },
  get: hostGet,
}, false)

const results = []
console.log(`mode: ${mode} (route ${ROUTE}, ${MODELS.length} models)\n`)

// ── publish gate ────────────────────────────────────────────────────────────
// The runtime surface must contain no employer identifier. This runs first
// because it is the one check whose failure means "do not publish", not
// "something is broken": a leak that reaches a public git history cannot be
// taken back, whereas a bug can be fixed in the next commit.
//
// `scan-company-info.mjs` is a maintainer tool and is not part of the published
// package — its rule patterns necessarily quote the identifiers it looks for. So
// this gate runs only where that tool exists, and says so when it does not, rather
// than reporting a pass it did not actually perform.
{
  const scanner = join(HERE, 'scan-company-info.mjs')
  if (!existsSync(scanner)) {
    console.log('note: scan-company-info.mjs is absent (published package), so the company-information gate is skipped.\n')
  } else {
    const { execFileSync } = await import('node:child_process')
    const scanned = ['index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'icon.svg']
    let output = ''
    let clean = true
    try {
      output = execFileSync(process.execPath, [scanner, '--quiet', '--only', scanned.join(',')], {
        cwd: HERE, encoding: 'utf8',
      })
    } catch (error) {
      clean = false
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`
    }
    check('the runtime surface names no employer or internal service', clean, output.trim().split('\n').slice(-2).join(' | '))
  }
}

function check(label, passed, detail = '') {
  results.push({ label, passed })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

plugin.apply(ctx, undefined)

// ── the real Tool registry contract ─────────────────────────────────────────
const def = registered.find(d => d.name === 'llm_models')
check('apply() registers the llm_models tool', def !== undefined)
check('agent/request and agent/request-error listeners mounted',
  (listeners['agent/request'] ?? []).length >= 1 && (listeners['agent/request-error'] ?? []).length === 1)
check('HTTP route mounted', routes.some(r => r.path === '/api/llm-manage'))

// ToolRuntime.register throws a TypeError unless `output.render` is a function,
// so this call is the difference between a visible tool and a silent no-op.
const fakeThis = { layers: { effect: (_c, run) => { run({ tools: { insert: () => {} } }); return () => {} } }, ctx: {} }
try {
  tools.ToolRuntime.prototype.register.call(fakeThis, def)
  check('real ToolRuntime.register() accepts the definition', true)
} catch (e) { check('real ToolRuntime.register() accepts the definition', false, e.message) }
try { tools.assertSupportedJsonSchema(def.parameters); check('parameter schema passes the real validator', true) }
catch (e) { check('parameter schema passes the real validator', false, e.message) }

// Actually executing the tool is what proves the closures can reach their
// services. A definition that registers cleanly but throws on its first call
// passes every check above and still fails the agent live.
try {
  const out = await def.execute({ action: 'diagnostics' })
  check('the tool executes: snapshot/diagnostics reach the services', typeof out === 'string' && out.includes('startedAt'),
    `bytes=${typeof out === 'string' ? out.length : 0}`)
} catch (e) { check('the tool executes: snapshot/diagnostics reach the services', false, e.message) }
try {
  const out = await def.execute({ action: 'snapshot', route: ROUTE })
  check('the tool snapshot executes and lists models', typeof out === 'string' && out.includes(at(0)))
} catch (e) { check('the tool snapshot executes and lists models', false, e.message) }

const handler = routes.find(r => r.path === '/api/llm-manage')
const call = async (body) => {
  const r = await handler.fetch(new Request('http://x/api/llm-manage', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
  return { status: r.status, body: await r.json() }
}

// ── the free gateway directory read ─────────────────────────────────────────
const sync = await call({ action: 'sync', route: ROUTE })
check('gateway directory sync reads the real model list', sync.body?.value?.count > 0,
  `count=${sync.body?.value?.count ?? sync.body?.message}`)

// ── the mutation contract the browser half relies on ────────────────────────
// Every mutating action must return the resulting state under a top-level
// `snapshot`, because that is the key the panel folds back in. Returning the
// same state under `value` instead is invisible to a Host-only test and made
// pin/favorite/hide appear to do nothing until the user reloaded by hand.
//
// Only `toggle` is exercised: it is local and free, whereas `probe` would spend
// real gateway rate budget. The pin is removed again so the ordering checks
// below still start from a clean overlay.
const pinnedRow = (snapshot, model) =>
  (snapshot?.groups?.[0]?.rows ?? []).find(row => row.model === model)?.pinned
const onResult = await call({ action: 'toggle', route: ROUTE, model: at(0), list: 'pins', on: true })
check('action "toggle" returns a top-level snapshot', onResult.body?.snapshot != null)
check('action "toggle"\'s snapshot reflects the pin', pinnedRow(onResult.body?.snapshot, at(0)) === true)
const offResult = await call({ action: 'toggle', route: ROUTE, model: at(0), list: 'pins', on: false })
check('action "toggle"\'s snapshot reflects the unpin', pinnedRow(offResult.body?.snapshot, at(0)) === false)

// A directory entry that omits `settingsPath` must still resolve the profile
// through the conventional `providers[route]` shape, so a directory change
// degrades to "found it anyway" rather than to a bogus baseURL.
const withPath = llmService.listConfigurableProviders
llmService.listConfigurableProviders = () => [
  { provider: ROUTE, displayName: DISPLAY_NAME, settingsNs: SETTINGS_NS },
]
const syncNoPath = await call({ action: 'sync', route: ROUTE })
check('a directory entry without settingsPath still resolves the profile',
  syncNoPath.body?.value?.count > 0, `count=${syncNoPath.body?.value?.count ?? syncNoPath.body?.message}`)
llmService.listConfigurableProviders = withPath

// ── passive learning and fallback, driven by real recorded gateway bodies ────
// Each case gets its own session. The fallback budget is keyed by
// `agent.id` + turn (MAX_FALLBACKS_PER_TURN), so one shared agent would spend it
// on the first three switching cases and silently stop switching after that —
// which would look like a classifier bug rather than a spent budget.
const AGENT_FOR = (n) => ({ id: `sess-${n}`, session: { id: `sess-${n}` } })
const agent = AGENT_FOR(1)
async function observe(target, model) {
  for (const l of listeners['agent/request'] ?? []) {
    await l.call({}, { agent: target, turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ provider: ROUTE, model }))
  }
}

// Error bodies are constructed here rather than pasted from one deployment's
// capture: the classifier keys on a numeric code and on the wording, so the
// suite supplies exactly those and nothing that fingerprints a specific gateway.
const gatewayBody = (code, message) => JSON.stringify({ error: { code, message } })

const CASES = [
  // A failure scoped to one model switches, because another model can serve the
  // turn. A failure scoped to the whole API key never switches, because every
  // model shares that key and moving would only hide the real problem.
  { label: 'retired-model code switches (model-scoped)', model: at(0), code: 'INVALID_REQUEST', status: 400, message: gatewayBody(4010, 'model not found'), retry: true },
  { label: 'protocol mismatch switches (model-scoped)', model: at(3), code: 'INVALID_REQUEST', status: 404, message: gatewayBody(404, 'model not support'), retry: true },
  { label: 'key-wide limit code does NOT switch (account-scoped)', model: at(2), code: 'RATE_LIMIT', status: 429, message: gatewayBody(2008, 'api key rate limit exceeded'), retry: false },
  { label: 'model quota code switches (model-scoped)', model: at(2), code: 'RATE_LIMIT', status: 429, message: gatewayBody(2007, 'quota exhausted'), retry: true },
  // No numeric code at all: the classifier must still recognise the wording.
  { label: 'quota wording without a code switches (model-scoped)', model: at(MODELS.length - 1), code: 'INVALID_REQUEST', status: 400, message: gatewayBody(undefined, '配额已用尽'), retry: true },
]
for (const [index, c] of CASES.entries()) {
  const caseAgent = AGENT_FOR(index + 1)
  await observe(caseAgent, c.model)
  const payload = {
    agent: caseAgent, turn: 1, step: 1, provider: ROUTE,
    failure: { message: c.message, code: c.code, status: c.status },
    retryPolicy: { mode: 'normal', maxRetries: 3, retryableCodes: ['RATE_LIMIT'] },
    signal: new AbortController().signal,
  }
  let retry = false
  for (const l of listeners['agent/request-error'] ?? []) {
    const action = await l.call({}, payload, () => Promise.resolve(undefined))
    if (action && action.kind === 'retry') retry = true
  }
  check(c.label, retry === c.retry, `retry=${retry}`)
}

// ── a switch must be visible to the conversation it happened in ─────────────
const log = await call({ action: 'fallbackLog', sessionId: 'sess-1' })
check('fallback banner data is scoped to the switched session',
  log.body?.value?.from?.model !== undefined && log.body?.value?.to?.model !== undefined)
check('an unrelated session gets no banner', (await call({ action: 'fallbackLog', sessionId: 'sess-never-used' })).body?.value === null)

// ── pins / favorites / hidden persist and reorder ───────────────────────────
for (const [model, list, on] of [[at(1), 'pins', true], [at(0), 'favorites', true], [at(2), 'hidden', true]]) {
  await call({ action: 'toggle', route: ROUTE, model, list, on })
}
const rows = (await call({ action: 'snapshot' })).body?.value?.groups?.[0]?.rows ?? []
check('snapshot returns every advertised model as a row', rows.length === MODELS.length, `${rows.length} rows`)
check('pinned model sorts first', rows[0]?.model === at(1),
  rows.map(r => `${r.model}${r.pinned ? '*' : ''}${r.hidden ? '#' : ''}`).join(' '))
check('hidden model is flagged, not dropped', rows.some(r => r.model === at(2) && r.hidden === true))
check('a classified model carries a reason and its source',
  rows.some(r => r.model === at(0) && r.status !== 'ok' && r.reason !== '' && r.source !== ''))

const storeFile = join(HOME, 'storages', 'llm-manage', `${ROUTE}.json`)
check('overlay is persisted to disk', existsSync(storeFile), storeFile)
const beforeRace = JSON.parse(readFileSync(storeFile, 'utf8'))

// ── lost-update race ────────────────────────────────────────────────────────
// Health recording is fire-and-forget from the listener while a UI toggle is
// awaited, so both can be in flight against the same file at once.
await Promise.all([
  call({ action: 'toggle', route: ROUTE, model: at(1), list: 'favorites', on: true }),
  call({ action: 'toggle', route: ROUTE, model: at(0), list: 'favorites', on: false }),
  call({ action: 'toggle', route: ROUTE, model: at(3), list: 'pins', on: true }),
  call({ action: 'toggle', route: ROUTE, model: at(3), list: 'hidden', on: true }),
])
const raced = JSON.parse(readFileSync(storeFile, 'utf8'))
check('concurrent read-modify-write loses no mutation',
  raced.pins.some(p => p.model === at(3))
  && raced.hidden.some(p => p.model === at(3))
  && !raced.favorites.some(p => p.model === at(0))
  // One health entry per distinct failed model, so the expectation follows the
  // case table instead of a number that has to be remembered.
  && Object.keys(raced.health).length === new Set(CASES.map(c => c.model)).size,
  `pins=${raced.pins.length} hidden=${raced.hidden.length} favorites=${raced.favorites.length} health=${Object.keys(raced.health).length}`)
check('passively learned health survived the race',
  Object.values(raced.health).some(h => h.source === 'passive'))
check('pre-race overlay kept every list',
  beforeRace.pins.length === 1 && beforeRace.favorites.length === 1 && beforeRace.hidden.length === 1)

// ── restart durability: a fresh apply() must read the same overlay ──────────
writeFileSync(storeFile, JSON.stringify({ ...raced, pins: [{ route: ROUTE, model: at(0) }] }))
routes = []
plugin.apply({
  inject: (_names, cb) => cb({
    tools: { register: () => () => {} },
    on: () => () => {},
    effect: (fn) => { const d = typeof fn === 'function' ? fn() : undefined; return typeof d === 'function' ? d : () => {} },
    get: (k) => {
      if (k === 'connection') return { fetch: { register: (r) => { routes.push(r); return () => {} } } }
      return hostGet(k)
    },
  }),
  on: () => () => {},
  effect: (fn) => { const d = typeof fn === 'function' ? fn() : undefined; return typeof d === 'function' ? d : () => {} },
  get: hostGet,
}, undefined)
const snap2 = await (await routes.find(r => r.path === '/api/llm-manage').fetch(new Request('http://x/api/llm-manage', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'snapshot' }),
}))).json()
const rows2 = snap2?.value?.groups?.[0]?.rows ?? []
check('overlay survives a fresh apply() (survives restart)',
  rows2.some(r => r.model === at(0) && r.pinned === true),
  `pinned now: ${rows2.filter(r => r.pinned).map(r => r.model).join(',')}`)

rmSync(HOME, { recursive: true, force: true })
const failed = results.filter(r => !r.passed)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('FAILED:', failed.map(f => f.label).join('; '))
  process.exit(1)
}
