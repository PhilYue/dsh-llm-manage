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
import { spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
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
  syntheticGatewayFetch,
} from './verify-env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// A second route that serves the same first two models. It is what makes the
// model-first view testable at all: one model, two routes, one entry. Named to
// sort after ROUTE so `groups[0]` keeps meaning the primary route.
const MIRROR_ROUTE = `${ROUTE}-mirror`
const MIRRORED = MODELS.slice(0, 2)

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
// A settings service that can be WRITTEN, because declaring measured levels goes
// through the same path the settings UI uses rather than editing the file.
let settingsValue = SETTINGS
const settingsWrites = []
const settingsService = {
  describe: () => [{
    ns: SETTINGS_NS,
    autoGenerate: true,
    schema: {},
    revision: 1 + settingsWrites.length,
    applies: 'live',
    value: settingsValue,
    base: SETTINGS,
    user: settingsValue,
  }],
  replace: async (ns, section, revision) => {
    settingsWrites.push({ ns, section: structuredClone(section), revision })
    settingsValue = section
  },
}
/**
 * The historical-scan fixture behind `ctx.get('sessionQuery')`.
 *
 * `seedUsage()` resolves this service when it runs, so the suite can start it
 * empty — the automatic pass at `apply()` then finds nothing and cannot perturb
 * the counts under test — and fill it in later to drive the backfill explicitly.
 * @type {{ listSessions: () => Promise<object[]>, readSession: (id: string) => Promise<object> }}
 */
let sessionQueryFixture = { listSessions: async () => [], readSession: async () => ({ events: [] }) }
/**
 * Records what the fallback asks the Session to become, and what it does to the
 * saved default. Both are real Host services; the suite supplies them so the
 * switch itself — not just the record of it — is observable.
 */
const sessionCalls = []
const savedDefaults = []
const sessionController = {
  selectModel: async (request) => {
    sessionCalls.push({ ...request })
    return { selected: { provider: request.provider, model: request.model } }
  },
}
const agentDefaultModel = {
  currentSelection: () => savedDefaults.at(-1) ?? { provider: ROUTE, model: at(0) },
  saveSelection: async (next) => { savedDefaults.push({ ...next }) },
}
const hostGet = (k) => {
  if (k === 'connection') return connection
  if (k === 'settings') return settingsService
  if (k === 'credentials') return { resolve: async () => ({ value: API_KEY, source: 'test' }) }
  if (k === 'llm') return llmService
  if (k === 'sessionQuery') return sessionQueryFixture
  if (k === 'sessionController') return sessionController
  if (k === 'agentDefaultModel') return agentDefaultModel
  return undefined
}
// What the catalog currently OFFERS for a model. Mutable because the declaration gate
// is defined in terms of it: a model the platform already covers must not be written
// to, and the only way to prove that is to make the platform's answer move.
let effectiveEfforts = ['low', 'high']
const llmService = {
  listProviders: () => [{ id: ROUTE, name: DISPLAY_NAME }, { id: MIRROR_ROUTE, name: MIRROR_ROUTE }],
  // settingsPath is the directory's own path from the section root to this
  // provider's profile; llm-pi-ai declares ['providers', provider].
  listConfigurableProviders: () => [{ provider: ROUTE, displayName: DISPLAY_NAME, settingsNs: SETTINGS_NS, settingsPath: ['providers', ROUTE] }],
  listModels: async (id) => (id === MIRROR_ROUTE ? MIRRORED : MODELS).map(model => ({ id: model, name: model })),
  // The declaration gate reads the model's EFFECTIVE levels: what the catalog and its
  // declaration together offer right now.
  resolveModelInfo: async (provider, model) => ({
    provider, id: model, name: model,
    reasoning: {
      efforts: effectiveEfforts.map(id => ({ id, name: id })),
      defaultEffort: 'high',
    },
  }),
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
check('the request, request-error and claim listeners are mounted',
  (listeners['agent/request'] ?? []).length >= 1
    && (listeners['agent/request-error'] ?? []).length === 1
    && (listeners['agent/inbox/claimed'] ?? []).length === 1)
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

/**
 * Run the request waterfall and report the model it settles on.
 *
 * The waterfall is applied in order, so the last decision is the one the loop
 * would actually send — which is what makes this a direct observation of a switch
 * rather than an inference from a counter.
 *
 * @param {object} target - the agent to dispatch for.
 * @param {string} model - the model the caller asked for.
 * @returns {Promise<string>} the model the loop would use.
 */
async function observeAndRead(target, model, turn = 1) {
  let decision = { provider: ROUTE, model }
  for (const l of listeners['agent/request'] ?? []) {
    decision = await l.call({}, { agent: target, turn, step: 1, signal: new AbortController().signal },
      () => Promise.resolve(decision))
  }
  return decision.model
}

/**
 * Fire one `agent/request-error` and return what the loop was told to do.
 * @param {object} target - the agent whose request failed.
 * @param {object} failure - the failure the harness reported.
 * @returns {Promise<unknown>} the waterfall's action.
 */
async function fireError(target, failure) {
  const payload = {
    agent: target, turn: 1, step: 1, provider: ROUTE, failure,
    retryPolicy: { mode: 'normal', maxRetries: 3, retryableCodes: ['RATE_LIMIT'] },
    signal: new AbortController().signal,
  }
  let action
  for (const l of listeners['agent/request-error'] ?? []) {
    action = await l.call({}, payload, () => Promise.resolve(action))
  }
  return action
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
  const before = sessionCalls.length
  const action = await fireError(caseAgent, { message: c.message, code: c.code, status: c.status })
  const moved = sessionCalls.slice(before)
  // 0.2.2 froze the step's selection and a retry replays it, so a switch can only be
  // a Session move for the NEXT message. Asking for a retry here re-sent the model
  // that had just failed and then died on the request-time mismatch check.
  const switched = moved.length === 1 && moved[0].model !== c.model
  check(c.label, switched === c.retry && action === undefined,
    `moved=${moved.map(m => m.model).join(',') || 'none'} action=${action?.kind ?? 'none'}`)
}


// ── a probe is not a routing event ──────────────────────────────────────────
// The two are easy to conflate because both end in a verdict of "unusable", but
// only one moves the session. A probe is an explicit question the user asked
// about a model; treating its answer as a reason to move the live conversation
// would switch models behind the user's back, which is exactly the silent
// substitution the design forbids.
//
// The model is switched IN THE FIXTURE only — the synthetic gateway answers 200 to
// every completion so the happy path can run, and a probe cannot fail against it.
// Rejecting just the completion call is what makes "the probe failed" a real event.
{
  const probeAgent = AGENT_FOR(90)
  await observe(probeAgent, at(2))
  const healthyGateway = globalThis.fetch
  globalThis.fetch = async (url, init) => String(url).includes('/chat/completions')
    ? new Response(JSON.stringify({ error: { code: 2007, message: 'quota exhausted' } }),
        { status: 429, headers: { 'content-type': 'application/json' } })
    : healthyGateway(url, init)
  const failedProbe = await call({ action: 'probe', route: ROUTE, model: at(2) })
  globalThis.fetch = healthyGateway
  check('a probe against a rejecting gateway really fails', failedProbe.body?.ok === true
    && /quota/i.test(String(failedProbe.body?.value?.detail ?? '')), String(failedProbe.body?.value?.detail ?? '').slice(0, 60))

  // The session that was using that very model must stay on it.
  const afterProbe = await observeAndRead(probeAgent, at(2))
  check('a failing probe does NOT switch the session\'s model', afterProbe === at(2),
    `${at(2)} -> ${afterProbe}`)
  check('a failing probe produces no fallback banner',
    (await call({ action: 'fallbackLog', sessionId: probeAgent.id })).body?.value === null)

  // It is still remembered: the verdict must steer the NEXT real switch away.
  const laterAgent = AGENT_FOR(91)
  await observe(laterAgent, at(3))
  await fireError(laterAgent, { message: JSON.stringify({ error: { code: 4010, message: 'model not found' } }), code: 'INVALID_REQUEST', status: 400 })
  const chosen = await observeAndRead(laterAgent, at(3))
  check('a probed-unusable model is skipped by a later chain', chosen !== at(2),
    `avoided ${at(2)}, chose ${chosen}`)
}

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

// ── the proficiency ledger ──────────────────────────────────────────────────
// Which models the user actually works with, counted from committed assistant
// messages rather than from clicks on the menu. The shape below is the real one
// the session service emits: `(session, event)` after the durable append.
//
// The distinction that matters is `assistant/message` versus `assistant/attempt`.
// A retried request produces the latter, and a counting scheme that ignored the
// difference would multiply a flaky gateway's retries into fake proficiency —
// which is exactly why `llm/stream` is not the source: its contract wraps every
// call including retries.
const NOW = Date.now()
const DAY = 86400000
const emit = (name, ...args) => { for (const cb of listeners[name] ?? []) cb(...args) }
const assistantMessage = (seq, model, time, usage) => ({
  type: 'assistant/message',
  seq,
  time,
  data: {
    turn: 1,
    step: 1,
    message: { role: 'assistant', source: { kind: 'model', provider: ROUTE, model } },
    stream: [],
    usage,
  },
})
const SESSION = { id: 'sess-usage' }
emit('session/event', SESSION, assistantMessage(1, at(0), NOW - 2 * DAY, { inputTokens: 100, outputTokens: 20 }))
emit('session/event', SESSION, assistantMessage(2, at(0), NOW - 1000, { inputTokens: 50, outputTokens: 10 }))
// A resumed session replays its own tail, so the same seq arrives twice.
emit('session/event', SESSION, assistantMessage(2, at(0), NOW - 1000, { inputTokens: 50, outputTokens: 10 }))
emit('session/event', SESSION, assistantMessage(3, at(1), NOW - DAY, { inputTokens: 7, outputTokens: 3 }))
// A retry is an attempt, not a use.
emit('session/event', SESSION, { type: 'assistant/attempt', seq: 4, time: NOW, data: { turn: 1, step: 1, stream: [] } })
// A malformed event must be ignored rather than crash the listener.
emit('session/event', SESSION, { type: 'assistant/message', seq: 5, time: NOW, data: {} })

const usageOut = JSON.parse(await def.execute({ action: 'usage' }))
const usageRow = (model) => usageOut.models.find(entry => entry.model === model)
check('a committed assistant message counts as one use',
  usageRow(at(0))?.uses === 2, `uses=${usageRow(at(0))?.uses}`)
check('a replayed session seq does not double count',
  usageRow(at(0))?.uses === 2 && usageRow(at(1))?.uses === 1,
  `${at(0)}=${usageRow(at(0))?.uses} ${at(1)}=${usageRow(at(1))?.uses}`)
check('a retried request is not counted as a use', usageRow(at(1))?.uses === 1)
check('an event with no model is ignored',
  usageOut.totals.uses === 3 && usageOut.models.every(entry => typeof entry.model === 'string' && entry.model !== ''),
  `uses=${usageOut.totals.uses} models=${usageOut.models.length}`)
check('token usage is recorded alongside the count',
  usageRow(at(0))?.inputTokens === 150 && usageRow(at(0))?.outputTokens === 30,
  `in=${usageRow(at(0))?.inputTokens} out=${usageRow(at(0))?.outputTokens}`)
check('proficiency level rises with the lifetime count',
  usageRow(at(0))?.level === 1 && usageRow(at(0))?.nextAt === 10,
  `level=${usageRow(at(0))?.level} nextAt=${usageRow(at(0))?.nextAt}`)
check('the more recently used model ranks first', usageOut.models[0]?.model === at(0),
  `first=${usageOut.models[0]?.model}`)
check('the ledger totals span the profile',
  usageOut.totals.uses === 3 && usageOut.totals.inputTokens === 157,
  `uses=${usageOut.totals.uses} in=${usageOut.totals.inputTokens}`)

// A failed call is not a use — it must not inflate proficiency — but it is the
// one honest "attempts" signal the host offers. The earlier failure cases in
// this suite already went through the same listener, so the expectation is a
// delta of exactly one rather than an absolute number: an absolute number would
// silently pass for the wrong reason if the listener stopped recording entirely.
const beforeFail = JSON.parse(await def.execute({ action: 'usage' }))
const attemptsBefore = beforeFail.models.find(entry => entry.model === at(2))?.attempts ?? 0
const failAgent = { id: 'sess-usage-fail', session: { id: 'sess-usage-fail' } }
for (const l of listeners['agent/request'] ?? []) {
  await l.call({}, { agent: failAgent, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ provider: ROUTE, model: at(2) }))
}
for (const l of listeners['agent/request-error'] ?? []) {
  await l.call({}, {
    agent: failAgent,
    turn: 1,
    step: 1,
    provider: ROUTE,
    // Account-wide rate limiting is not switchable, so the listener records and
    // defers instead of running the fallback chain.
    failure: { code: 'RATE_LIMIT', message: 'slow down' },
    retryPolicy: undefined,
    signal: new AbortController().signal,
  }, () => Promise.resolve({ kind: 'retry' }))
}
const afterFail = JSON.parse(await def.execute({ action: 'usage' }))
const failRow = afterFail.models.find(entry => entry.model === at(2))
check('a failed call is recorded as an attempt, never as a use',
  failRow?.attempts === attemptsBefore + 1 && failRow?.uses === 0,
  `attempts=${attemptsBefore}→${failRow?.attempts} uses=${failRow?.uses}`)

const persisted = JSON.parse(readFileSync(storeFile, 'utf8'))
check('the ledger is persisted to disk, not only in memory', persisted.usage?.[at(0)]?.uses === 2,
  `stored=${persisted.usage?.[at(0)]?.uses}`)

// ── historical backfill ─────────────────────────────────────────────────────
// A fresh install must not report level 1 on every model while the user's own
// logs say otherwise, so existing session logs are scanned once. The watermark
// makes a second pass a no-op instead of a double count.
sessionQueryFixture = {
  listSessions: async () => [{ header: { id: 'sess-hist' } }],
  readSession: async () => ({
    header: { id: 'sess-hist' },
    events: [
      assistantMessage(1, at(3), NOW - 3 * DAY, { inputTokens: 5, outputTokens: 1 }),
      assistantMessage(2, at(3), NOW - 3 * DAY, { inputTokens: 5, outputTokens: 1 }),
      // A backfilled session may itself contain a replayed seq.
      assistantMessage(2, at(3), NOW - 3 * DAY, { inputTokens: 5, outputTokens: 1 }),
    ],
  }),
}
const seeded = JSON.parse(await def.execute({ action: 'seed-usage' }))
check('the backfill counts existing session logs', seeded.ok === true && seeded.counted === 2,
  `ok=${seeded.ok} counted=${seeded.counted} reason=${seeded.reason ?? ''}`)
const afterSeed = JSON.parse(await def.execute({ action: 'usage' }))
check('a backfilled model appears with its whole history',
  afterSeed.models.find(entry => entry.model === at(3))?.uses === 2,
  `uses=${afterSeed.models.find(entry => entry.model === at(3))?.uses}`)
check('a backfilled model is marked as seeded',
  afterSeed.models.find(entry => entry.model === at(3))?.seeded === true)
const seededAgain = JSON.parse(await def.execute({ action: 'seed-usage' }))
const afterSeed2 = JSON.parse(await def.execute({ action: 'usage' }))
check('the backfill resumes from its watermark instead of recounting',
  seededAgain.counted === 0 && afterSeed2.models.find(entry => entry.model === at(3))?.uses === 2,
  `second pass counted=${seededAgain.counted}`)

// ── restart durability: a fresh apply() must read the same overlay ──────────
// The usage counters ride in the same document as the pins, so this also proves
// proficiency survives a restart rather than resetting to zero.
const beforeRestart = JSON.parse(readFileSync(storeFile, 'utf8'))
writeFileSync(storeFile, JSON.stringify({ ...beforeRestart, pins: [{ route: ROUTE, model: at(0) }] }))
let pendingSeed
const injectNames = []
routes = []
plugin.apply({
  inject: (names, cb) => {
    injectNames.push(...names)
    // This host has not registered its query backend yet. A plugin that wants a
    // backfill has to ask to be told when it appears; sampling `ctx.get` here
    // would see nothing and silently skip the pass forever.
    if (names.includes('sessionQuery')) { pendingSeed = cb; return }
    cb({
      tools: { register: () => () => {} },
      on: () => () => {},
      effect: (fn) => { const d = typeof fn === 'function' ? fn() : undefined; return typeof d === 'function' ? d : () => {} },
      get: (k) => {
        if (k === 'connection') return { fetch: { register: (r) => { routes.push(r); return () => {} } } }
        return hostGet(k)
      },
    })
  },
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
check('proficiency survives a fresh apply()',
  rows2.find(r => r.model === at(0))?.usage?.uses === 2,
  `uses now: ${rows2.find(r => r.model === at(0))?.usage?.uses}`)

// The restart's own HTTP route is used from here on, because the second apply()
// registers no tool definition.
const call2 = async (body) => {
  const r = await routes.find(route => route.path === '/api/llm-manage').fetch(new Request('http://x/api/llm-manage', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
  return { status: r.status, body: await r.json() }
}

// Deleting the counters is a privacy affordance, so it must be reachable from
// the panel and must actually clear what it says it cleared.
const cleared = await call2({ action: 'reset-usage', route: ROUTE, model: at(0) })
check('reset-usage clears one model and returns the new snapshot',
  cleared.body?.value?.cleared?.includes(`${ROUTE}/${at(0)}`)
  && (cleared.body?.snapshot?.groups?.[0]?.rows ?? []).find(r => r.model === at(0))?.usage?.uses === 0,
  `cleared=${JSON.stringify(cleared.body?.value?.cleared)}`)
const stillThere = await call2({ action: 'usage' })
check('reset-usage leaves other models alone',
  stillThere.body?.value?.models?.some(entry => entry.model === at(1)),
  `models=${stillThere.body?.value?.models?.map(entry => entry.model).join(',')}`)
const clearedAll = await call2({ action: 'reset-usage' })
check('reset-usage with no route clears every counter',
  clearedAll.body?.value?.ok === true
  && (await call2({ action: 'usage' })).body?.value?.models?.length === 0,
  `cleared=${clearedAll.body?.value?.cleared?.length ?? 0} route(s)`)

// ── a query backend that registers after this plugin ────────────────────────
// The startup backfill is the only thing standing between a fresh profile and an
// empty roster, and registration order is not guaranteed. Subscribing to the
// dependency is what makes the pass order-independent; sampling it during `apply`
// produced a silent no-op that looked exactly like an empty history.
check('the backfill subscribes to the query service instead of sampling it during apply',
  pendingSeed !== undefined,
  `injections requested: ${injectNames.join(', ')}`)
if (pendingSeed !== undefined) {
  pendingSeed({
    sessionQuery: {
      listSessions: async () => [{ header: { id: 'sess-late' } }],
      readSession: async () => ({
        header: { id: 'sess-late' },
        events: [assistantMessage(1, 'late-model', NOW, { inputTokens: 3, outputTokens: 1 })],
      }),
    },
  })
  await new Promise(resolve => setTimeout(resolve, 100))
}
const lateLedger = await call2({ action: 'usage' })
check('a backend that appears after apply still gets its logs counted',
  lateLedger.body?.value?.models?.find(entry => entry.model === 'late-model')?.uses === 1,
  `models=${lateLedger.body?.value?.models?.map(e => `${e.model}:${e.uses}`).join(',')}`)

// ── a switch is reported only once the model that answered is known ─────────
// The banner used to be written when the switch was DECIDED, so it described an
// intention: a retry that failed, was aborted, or ran on a third route produced
// the same "switched automatically" text either way. That is the report this
// suite now refuses to accept, because it is the one the user could not
// reproduce in the conversation.
const emitSession = (sessionId, event) => {
  for (const cb of listeners['session/event'] ?? []) cb({ id: sessionId }, event)
}
const messageEvent = (model, turn = 1, provider = ROUTE) => ({
  type: 'assistant/message',
  seq: 1,
  time: Date.now(),
  data: { turn, step: 1, message: { role: 'assistant', source: { kind: 'model', provider, model } }, stream: [] },
})
/** Fail one model on a fresh session, exactly as the loop would. */
const decideSwitch = async (n, failedModel) => {
  const target = AGENT_FOR(n)
  await observe(target, failedModel)
  await fireError(target, { code: 'RATE_LIMIT', status: 429, message: gatewayBody(2007, 'quota exhausted') })
  return target
}
const logFor = async (sessionId) => (await call({ action: 'fallbackLog', sessionId })).body?.value ?? null

const undecided = await decideSwitch(30, at(2))
check('a decided switch is not reported before anything proves it',
  await logFor('sess-30') === null, String(await logFor('sess-30')))

emitSession('sess-30', { type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 1, reason: { kind: 'error', error: { message: 'quota exhausted', code: 'RATE_LIMIT' } } } })
const unreached = await logFor('sess-30')
check('a turn that ends without a committed message reports the switch as unreached',
  unreached?.outcome === 'unreached' && unreached?.to?.model !== undefined,
  JSON.stringify(unreached?.outcome ?? null))
// The target is deterministic for a given failure, so the same scenario twice
// resolves to the same model — which the reached case below relies on.
const target = unreached?.to

// The message that answers names a DIFFERENT model: the state the old code could
// not distinguish from a successful switch, because it never looked.
await decideSwitch(31, at(2))
emitSession('sess-31', messageEvent(at(2)))
const elsewhere = await logFor('sess-31')
check('a switch that did not take effect is reported as not taking effect',
  elsewhere?.outcome === 'ran-elsewhere' && elsewhere?.ran?.model === at(2),
  `outcome=${elsewhere?.outcome} ran=${elsewhere?.ran?.model ?? 'null'}`)

// And the honest success case still reports success.
await decideSwitch(32, at(2))
emitSession('sess-32', messageEvent(target.model))
const reached = await logFor('sess-32')
check('a switch the answering model confirms is reported as reached',
  reached?.outcome === 'reached' && reached?.to?.model === target.model,
  `outcome=${reached?.outcome} to=${reached?.to?.model ?? 'null'} asked=${target.model}`)
check('an unrelated session gets no banner', (await call({ action: 'fallbackLog', sessionId: 'sess-never-used' })).body?.value === null)

// ── a repair is not allowed to end the conversation ─────────────────────────
// Switching the model used to be the end of the story: the session moved, the turn
// had failed, and the person had to type something to find out whether the new model
// could finish the work. A repair that stops mid-task is a repair the person has to
// supervise, so the controller now queues the continuation turn itself — and says so
// in the record instead of leaving the interval unexplained.
const repairedAgent = (n) => ({
  id: `sess-${n}`,
  session: { id: `sess-${n}` },
  status: 'idle',
  inbox: { nextStep: [], nextTurn: [] },
  followed: [],
  followup(message) { this.followed.push(message) },
})
const turnEnd = (sessionId, turn = 1) => emitSession(sessionId, {
  type: 'turn/end',
  seq: 2,
  time: Date.now(),
  data: { turn, reason: { kind: 'error', error: { message: 'quota exhausted', code: 'RATE_LIMIT' } } },
})
const settle = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms))
const textOf = (message) => (Array.isArray(message?.content) ? message.content : [])
  .filter(part => part?.type === 'text').map(part => part.text).join('\n')

{
  const a = repairedAgent(50)
  await observe(a, at(2))
  await fireError(a, { code: 'RATE_LIMIT', status: 429, message: gatewayBody(2007, 'quota exhausted') })
  check('a decided repair has queued nothing before the turn boundary',
    a.followed.length === 0, `queued=${a.followed.length}`)
  turnEnd('sess-50')
  await settle()
  check('an unrecovered repair queues the continuation turn itself',
    a.followed.length === 1, `queued=${a.followed.length}`)
  const continuation = a.followed[0]
  check('the continuation is addressed as a repair, not as the person speaking',
    continuation?.role === 'user' && continuation?.source?.kind === 'llm-manage-repair'
    && typeof continuation?.id === 'string' && continuation.id !== '',
    `role=${continuation?.role ?? 'none'} source=${continuation?.source?.kind ?? 'none'}`)
  const text = textOf(continuation)
  check('the continuation tells the model to check the real state before going on',
    /check the actual state/i.test(text) && /do not repeat/i.test(text) && text.includes('/'),
    text.slice(0, 90).replace(/\n/g, ' '))
  const reported = await logFor('sess-50')
  check('the record says whether the work was picked back up',
    reported?.continued === true && reported?.continueRefused === undefined,
    `continued=${reported?.continued} refused=${reported?.continueRefused ?? 'none'}`)
}

{
  // Someone else's message is already waiting, and it will be answered by the new
  // model. Queueing a second turn would interleave two replies to one interruption.
  const b = repairedAgent(51)
  b.inbox.nextTurn.push({ id: 'waiting' })
  await observe(b, at(2))
  await fireError(b, { code: 'RATE_LIMIT', status: 429, message: gatewayBody(2007, 'quota exhausted') })
  turnEnd('sess-51')
  await settle()
  const refused = await logFor('sess-51')
  check('a message already waiting is left to the new model rather than duplicated',
    b.followed.length === 0 && /already waiting/i.test(String(refused?.continueRefused ?? '')),
    `queued=${b.followed.length} refused=${String(refused?.continueRefused ?? 'none')}`)
}

{
  // Two repairs per request is the budget: enough to survive a second bad model,
  // few enough that a permanently broken route stops instead of looping.
  const c = repairedAgent(52)
  const round = async () => {
    await observe(c, at(2))
    await fireError(c, { code: 'RATE_LIMIT', status: 429, message: gatewayBody(2007, 'quota exhausted') })
    turnEnd('sess-52')
    await settle()
  }
  await round()
  await round()
  await round()
  const spent = await logFor('sess-52')
  check('the continuation budget stops a repair loop at two turns',
    c.followed.length === 2, `queued=${c.followed.length} refused=${String(spent?.continueRefused ?? 'none')}`)
  check('a spent budget is reported as a refusal rather than silence',
    /already continued/i.test(String(spent?.continueRefused ?? '')), String(spent?.continueRefused ?? 'none'))
}

{
  // A person speaking again is a new request, so the budget starts over. Without the
  // reset, one long conversation would permanently lose its ability to recover.
  const d = repairedAgent(53)
  d.inbox.nextTurn.push({ id: 'fresh-question', source: { kind: 'user' } })
  for (const l of listeners['agent/inbox/claimed'] ?? []) {
    l({ agent: d, message: { id: 'fresh-question', source: { kind: 'user' } } })
  }
  d.inbox.nextTurn.length = 0
  const round = async () => {
    await observe(d, at(2))
    await fireError(d, { code: 'RATE_LIMIT', status: 429, message: gatewayBody(2007, 'quota exhausted') })
    turnEnd('sess-53')
    await settle()
  }
  await round()
  await round()
  await round()
  check('a person speaking again restores the continuation budget',
    d.followed.length === 2, `queued=${d.followed.length}`)
}

{
  // The five-second blip: the shipped policy retries on the same model, and taking the
  // model away on the first failure is what makes a transient outage expensive.
  const e = AGENT_FOR(54)
  await observe(e, at(2))
  const before = sessionCalls.length
  let action
  for (const l of listeners['agent/request-error'] ?? []) {
    action = await l.call({}, {
      agent: e,
      turn: 1,
      step: 1,
      provider: ROUTE,
      failure: { status: 503, message: gatewayBody(503, '模型服务异常') },
      retryPolicy: { mode: 'normal', maxRetries: 2, retryableCodes: ['SERVER_ERROR'] },
      signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'retry' }))
  }
  check('a transient failure is handed to the shipped retry policy before any switch',
    action?.kind === 'retry' && sessionCalls.length === before,
    `action=${action?.kind ?? 'none'} moves=${sessionCalls.length - before}`)
  check('a transient failure leaves no repair debt behind',
    (await logFor('sess-54')) === null, String(await logFor('sess-54')))
}

{
  // Context overflow and bad parameters fail the same way on every route, so a switch
  // would spend the chain to re-learn one fact and bury the error worth reading.
  const f = AGENT_FOR(55)
  await observe(f, at(2))
  const before = sessionCalls.length
  const action = await fireError(f, {
    code: 'INVALID_REQUEST',
    status: 400,
    message: JSON.stringify({ error: { code: 'invalid_request', message: 'invalid parameter: max_tokens' } }),
  })
  check('a malformed request is never blamed on the model',
    sessionCalls.length === before && action === undefined,
    `moves=${sessionCalls.length - before} action=${action?.kind ?? 'none'}`)
}

{
  // A level repair is the same interruption with a different cause: the model stays,
  // the selection is cleared, and the work still has to be picked back up.
  const g = repairedAgent(56)
  await observe(g, at(0))
  await fireError(g, {
    code: 'UNSUPPORTED_REASONING_EFFORT',
    status: 400,
    message: `provider "${ROUTE}" model "${at(0)}" does not support reasoning effort "High"`,
  })
  turnEnd('sess-56')
  await settle()
  check('a level repair also continues the work instead of asking the person',
    g.followed.length === 1 && g.followed[0]?.source?.clearedEffort === true,
    `queued=${g.followed.length} cleared=${String(g.followed[0]?.source?.clearedEffort)}`)
}

// ── the switch history outlives the session that produced it ────────────────
// The banner answers "what happened in this turn" and is gone at the next reload.
// "Which model keeps costing me a retry" is a question about the profile, and it
// can only be answered by records that survive the page — that is the whole point
// of a second document rather than a longer in-memory list.
{
  // The history is written from the event handler, which cannot be awaited by the
  // emitter — the harness dispatches the event and moves on. Waiting here is the
  // honest form of "the write had a chance to land", not a way to hide a missing one.
  await new Promise(resolve => setTimeout(resolve, 120))
  const history = (await call({ action: 'failoverHistory' })).body?.value
  const records = history?.records ?? []
  check('every proven switch is appended to a history that outlives the session',
    records.length >= 3 && records.some(record => record.outcome === 'reached'),
    `${records.length} record(s)`)
  check('a history record names both ends of the switch',
    records.every(record => record.from?.model !== undefined && record.to?.model !== undefined),
    JSON.stringify(records[0] ?? null).slice(0, 120))
  const culprit = (history?.models ?? []).find(entry => entry.model === at(2))
  check('the history counts the model that kept failing',
    culprit?.switches >= 3 && culprit.reached >= 1 && culprit.unreached >= 1 && culprit.sessions >= 3,
    JSON.stringify(culprit ?? null))
  check('the history ranks the worst offender first',
    (history?.models ?? [])[0]?.model === at(2),
    (history?.models ?? []).map(entry => `${entry.model}:${entry.switches}`).join(' '))
  // Statistics that cannot be reset would only ever describe a machine that no
  // longer exists, which is why clearing is part of the action rather than a file edit.
  await call({ action: 'clearFailover' })
  const emptied = (await call({ action: 'failoverHistory' })).body?.value
  check('the switch history can be cleared',
    Array.isArray(emptied?.records) && emptied.records.length === 0, `${emptied?.records?.length ?? 'null'} left`)
}

// ── a provider-level fault must not blacklist the model ─────────────────────
// "No adapter registered for provider" says nothing about any model on the route:
// every model there would fail the same way. Recording it against the selected
// model put it in UNUSABLE_REASONS, and unlike QUOTA that verdict has no
// staleness escape, so one route misconfiguration removed a model from every
// later fallback chain permanently.
{
  const providerAgent = AGENT_FOR(33)
  await observe(providerAgent, at(1))
  const healthOf = async () => (await call({ action: 'snapshot' })).body?.value?.groups
    ?.flatMap(g => g.rows).find(r => r.model === at(1))?.status
  const before = await healthOf()
  const beforeMoves = sessionCalls.length
  const action = await fireError(providerAgent, {
    code: 'NO_ADAPTER', status: 400, message: 'no adapter registered for provider "example-route"',
  })
  const providerMoves = sessionCalls.slice(beforeMoves)
  check('a route with no adapter still moves the Session',
    providerMoves.length === 1 && action === undefined,
    `moves=${providerMoves.map(m => m.model).join(',') || 'none'} action=${action?.kind ?? 'none'}`)
  // The assertion has to be "the record did not change", not "it is not error":
  // the fault now carries its own reason, so a status comparison against one
  // value passes whether or not the model was written to. What matters is that a
  // provider-scope fault leaves no mark on a model the provider never reached.
  const after = await healthOf()
  check('a route with no adapter leaves the model record untouched', after === before,
    `before=${before ?? 'none'} after=${after ?? 'none'}`)
}

// ── the switch is real, and it does not take the default with it ────────────
// A turn-scoped override alone recovers the retry and changes nothing durable,
// which is why a banner could claim a switch the session never made. The Session
// itself has to move — and an automatic recovery must not rewrite the model new
// sessions start on.
{
  const before = sessionCalls.length
  const defaultsBefore = savedDefaults.length
  const durable = AGENT_FOR(35)
  await observe(durable, at(2))
  await fireError(durable, { code: 'RATE_LIMIT', status: 429, message: gatewayBody(2007, 'quota exhausted') })
  const asked = sessionCalls.slice(before)
  check('the session itself is moved, not just the retried request',
    asked.length === 1 && asked[0].sessionId === 'sess-35' && asked[0].model !== at(2),
    asked.map(c => `${c.sessionId}:${c.model}`).join(',') || 'no session call')
  const restored = savedDefaults.slice(defaultsBefore)
  check('an automatic switch puts the saved default model back',
    restored.length >= 1 && restored[restored.length - 1].model === at(0),
    restored.map(d => `${d.provider}/${d.model}`).join(',') || 'default never restored')
}

// ── a repair may move the Session, never the frozen request ──────────────────
// `agent/request` is deprecated precisely for this: a replacement "must keep the
// provider, model, and reasoning effort selection", and the loop throws
// `agent/request proposed … after step preparation fixed …` when it does not. The
// old recovery rewrote the model there, which is why a quota error surfaced as an
// UNKNOWN turn failure instead of a switch.
{
  const leakAgent = AGENT_FOR(34)
  await observe(leakAgent, at(2))
  await fireError(leakAgent, { code: 'RATE_LIMIT', status: 429, message: gatewayBody(2007, 'quota exhausted') })
  const sameStep = await observeAndRead(leakAgent, at(2), 1)
  check('a repair does not rewrite the frozen request',
    sameStep === at(2), `request asked for ${sameStep}`)
}

// ── a level the model does not declare is repaired, not switched away from ──
// This is the failure the user hit as `does not support reasoning effort "High"`: a
// stale selection, not a sick model. Switching models would hide it, and recording it
// against the model would blacklist one that works. The repair is a CLEAR now that the
// harness gives "no explicit level" its own meaning: the request falls back to the
// adapter default, which the harness has validated against the declaration.
{
  const target = AGENT_FOR(41)
  const requestDecision = async (agent, turn) => {
    let decision = { provider: ROUTE, model: at(0), reasoningEffort: 'High' }
    for (const l of listeners['agent/request'] ?? []) {
      decision = await l.call({}, { agent, turn, step: 1, signal: new AbortController().signal },
        () => Promise.resolve(decision))
    }
    return decision
  }
  await observe(target, at(0))
  const healed = await fireError(target, {
    code: 'UNSUPPORTED_REASONING_EFFORT',
    status: 400,
    message: `provider "${ROUTE}" model "${at(0)}" does not support reasoning effort "High"`,
  })
  check('an unsupported level repairs the Session instead of asking for a retry',
    healed === undefined, JSON.stringify(healed ?? null))

  // The request still carries whatever the step froze — rewriting it is what the
  // loop rejects — so what has to be true is that the repair reaches the SELECTION.
  const decision = await requestDecision(target, 1)
  check('the repair leaves the frozen request alone',
    decision.reasoningEffort === 'High' && decision.model === at(0), JSON.stringify(decision))
  const sessionCall = sessionCalls.at(-1)
  check('the Session is moved to the cleared level',
    sessionCall?.model === at(0) && sessionCall?.reasoningEffort === undefined,
    JSON.stringify(sessionCall ?? null))
  const modelHealth = (await call({ action: 'snapshot' })).body?.value?.groups
    ?.flatMap(group => group.rows).find(row => row.model === at(0))?.status
  check('a level repair is not recorded against the model health',
    modelHealth !== 'error', `model health=${modelHealth ?? 'none'}`)

  // The same failure twice in one turn must not loop: the second pass declines.
  const beforeRepeat = sessionCalls.length
  const repeated = await fireError(target, {
    code: 'UNSUPPORTED_REASONING_EFFORT',
    status: 400,
    message: 'does not support reasoning effort "High"',
  })
  check('a repeated level failure in the same turn does not loop',
    repeated === undefined && sessionCalls.length === beforeRepeat,
    `${JSON.stringify(repeated ?? null)} moves=${sessionCalls.length - beforeRepeat}`)
}

// ── the repair is finished at claim time when the Session did not adopt it ───
// `agent/inbox/claimed` fires synchronously inside step preparation, after the
// message is claimed and BEFORE the step reads `model.current()` — the last moment a
// selection change still applies to the step about to run. A controller call can be
// refused; without this the step would start on the selection we already know is bad.
{
  /** Dispatch one claim to the plugin and report the selections it made. */
  function claimWith(agent) {
    const selects = []
    const claimed = {
      ...agent,
      model: {
        current: () => agent.selection,
        select: (selection) => { selects.push(selection) },
      },
    }
    for (const l of listeners['agent/inbox/claimed'] ?? []) l.call({}, { agent: claimed, message: {}, turn: 9 })
    return selects
  }

  // A switch the Session kept: the claim finishes it with the chain head.
  const switchAgent = AGENT_FOR(42)
  await observe(switchAgent, at(2))
  await fireError(switchAgent, { code: 'RATE_LIMIT', status: 429, message: gatewayBody(2007, 'quota exhausted') })
  const finished = claimWith({ ...switchAgent, selection: { provider: ROUTE, model: at(2) } })
  check('a switch the Session kept is finished at claim time',
    finished.length === 1 && finished[0].model !== at(2), JSON.stringify(finished))

  // A model someone else already picked is never overruled.
  const spokeAgent = AGENT_FOR(43)
  await observe(spokeAgent, at(2))
  await fireError(spokeAgent, { code: 'RATE_LIMIT', status: 429, message: gatewayBody(2007, 'quota exhausted') })
  const untouched = claimWith({ ...spokeAgent, selection: { provider: ROUTE, model: at(0) } })
  check('a claim never overrules a selection that is no longer the broken one',
    untouched.length === 0, JSON.stringify(untouched))

  // A level the Session kept: the claim clears it, which is the whole repair.
  const levelAgent = AGENT_FOR(44)
  await observe(levelAgent, at(0))
  await fireError(levelAgent, {
    code: 'UNSUPPORTED_REASONING_EFFORT',
    status: 400,
    message: `provider "${ROUTE}" model "${at(0)}" does not support reasoning effort "High"`,
  })
  const cleared = claimWith({ ...levelAgent, selection: { provider: ROUTE, model: at(0), reasoningEffort: 'High' } })
  check('a level the Session kept is cleared at claim time',
    cleared.length === 1 && cleared[0].reasoningEffort === undefined,
    JSON.stringify(cleared))
}

// ── a probe measures the levels, not just the health ───────────────────────
// Declaring a level the gateway refuses is a configuration mistake that surfaces as a
// failed turn, so the probe answers it directly instead of leaving it to guesswork.
{
  // The answer depends on the gateway, so this block swaps in the synthetic one for
  // the duration: in real mode the same sweep would ask a live gateway about a level
  // set that belongs to its own models, and the assertion would only be testing the
  // network. What is being proven here is the sweep's shape, not one vendor's answer.
  const target = at(2)
  const realFetch = globalThis.fetch
  globalThis.fetch = syntheticGatewayFetch
  let probed
  try {
    probed = await call({ action: 'probe', route: ROUTE, model: target })
  } finally {
    globalThis.fetch = realFetch
  }
  const levels = probed.body?.value?.levels
  check('a probe measures which reasoning levels the gateway accepts',
    (levels?.accepted ?? []).join(',') === 'low,high,max',
    JSON.stringify(levels?.accepted ?? null))
  check('a probe keeps the refused levels instead of dropping them',
    (levels?.rejected ?? []).map(entry => entry.level).join(',') === 'minimal,medium,xhigh',
    JSON.stringify((levels?.rejected ?? []).map(entry => entry.level)))
  const measuredRow = (probed.body?.snapshot?.groups ?? [])
    .flatMap(group => group.rows).find(row => row.model === target)
  check('the measured levels reach the snapshot row',
    (measuredRow?.levels?.accepted ?? []).join(',') === 'low,high,max',
    JSON.stringify(measuredRow?.levels ?? null))
  // The probe is the only moment the measurement exists, so the declaration is
  // written right there: the two-fact split cost the user a click they could not
  // discover, and a measured level that stays undeclared is offered by nobody.
  const autoDeclared = probed.body?.value?.declared
  check('a probe that measures levels declares them in the same call',
    (autoDeclared?.levels ?? []).join(',') === 'low,high,max',
    JSON.stringify(autoDeclared ?? null))
  const autoWrite = settingsWrites.at(-1)
  const autoModel = autoWrite?.section?.providers?.[ROUTE]?.models?.find(
    entry => (typeof entry === 'string' ? entry : entry?.id) === target,
  )
  check('the automatic declaration reaches the settings service',
    autoWrite?.ns === SETTINGS_NS
      && Object.keys(autoModel?.reasoningEfforts ?? {}).join(',') === 'low,high,max',
    JSON.stringify(autoModel ?? null))
}

// ── a measured level becomes a declared one, through the settings service ───
// Measurement alone unlocks nothing: the harness validates a level against the model's
// DECLARATION, so a level the gateway accepts but the config omits is offered by nobody.
{
  const declared = await call({ action: 'declareLevels', route: ROUTE, model: at(2) })
  check('declaring measured levels reports the levels it wrote',
    declared.body?.ok === true && (declared.body?.value?.levels ?? []).join(',') === 'low,high,max',
    JSON.stringify(declared.body?.value ?? declared.body))
  const write = settingsWrites.at(-1)
  const written = write?.section?.providers?.[ROUTE]?.models?.find(
    entry => (typeof entry === 'string' ? entry : entry?.id) === at(2),
  )
  check('the declaration is written where the harness reads levels from',
    written !== undefined && typeof written === 'object'
      && Object.keys(written.reasoningEfforts ?? {}).join(',') === 'low,high,max',
    JSON.stringify(written ?? null))
  check('the declaration goes through the settings service, not a file edit',
    write?.ns === SETTINGS_NS, write?.ns ?? 'no write')

  // A model nobody probed has nothing to declare, and must not write an empty field.
  const before = settingsWrites.length
  const refused = await call({ action: 'declareLevels', route: ROUTE, model: at(9) })
  check('an unprobed model is refused instead of declaring nothing',
    refused.body?.ok !== true && settingsWrites.length === before,
    JSON.stringify(refused.body ?? null))
}

// ── a declaration is merged into what the model already declares ────────────
// pi-ai reads a declaration as CLOSED: a level the dict does not name is pinned to
// null — "this model does not support it". Replacing the dict wholesale therefore
// deletes facts this plugin never measured: the official Off level, a wire spelling
// that is not the level id, another editor's rows. Only missing levels are added.
{
  const target = at(2)                    // measured low,high,max by the probe above
  const saved = settingsValue
  const seeded = structuredClone(saved)
  const models = seeded.providers?.[ROUTE]?.models
  const index = models.findIndex(entry => (typeof entry === 'string' ? entry : entry?.id) === target)
  const existing = index === -1 ? undefined : models[index]
  const declared = { off: null, high: 'High', medium: 'medium' }
  models[index === -1 ? models.length : index] = {
    ...(typeof existing === 'string' ? { id: existing, name: existing } : existing ?? { id: target, name: target }),
    reasoningEfforts: declared,
  }
  // A hand-edited config, written the way a profile would carry it — not through the
  // settings service, which is the path under test.
  settingsValue = seeded
  const before = settingsWrites.length
  const merged = await call({ action: 'declareLevels', route: ROUTE, model: target })
  const write = settingsWrites.length === before ? undefined : settingsWrites.at(-1)
  const written = write?.section?.providers?.[ROUTE]?.models?.find(
    entry => (typeof entry === 'string' ? entry : entry?.id) === target,
  )?.reasoningEfforts
  check('a declaration adds the missing levels instead of replacing the dict',
    merged.body?.ok === true
      && Object.keys(written ?? {}).join(',') === 'off,high,medium,low,max',
    JSON.stringify(written ?? merged.body ?? null))
  check('the declaration leaves the keys it did not measure untouched',
    written?.off === null && written?.high === 'High' && written?.medium === 'medium'
      && written?.low === 'low' && written?.max === 'max',
    JSON.stringify(written ?? null))
  settingsValue = saved
}

// ── a model the platform already covers is not written to ───────────────────
// The probe declares automatically, which is only safe while it cannot overwrite a
// still-wider declaration the platform already produces. The gate is the model's
// EFFECTIVE levels, and it has to hold for the manual path too.
{
  const target = at(2)
  // Strip the model's own entry first: without it the merge path would REFUSE (there is
  // nowhere to write), so an `ok` answer here can only come from the gate answering
  // before the settings are ever read.
  const saved = settingsValue
  const stripped = structuredClone(saved)
  stripped.providers[ROUTE].models = stripped.providers[ROUTE].models.filter(
    entry => (typeof entry === 'string' ? entry : entry?.id) !== target,
  )
  settingsValue = stripped
  effectiveEfforts = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const before = settingsWrites.length
  const again = await call({ action: 'declareLevels', route: ROUTE, model: target })
  const value = again.body?.value
  check('a declaration is skipped when the model already offers every measured level',
    again.body?.ok === true && value?.already === true && settingsWrites.length === before,
    `${JSON.stringify(value ?? again.body ?? null)} writes=${settingsWrites.length - before}`)
  settingsValue = saved

  // …and the automatic declaration that rides on a probe obeys the same gate: put the
  // fetched order back, because the synthetic gateway is only fetched by the probe.
  const probeTarget = at(3)
  const realFetch = globalThis.fetch
  globalThis.fetch = syntheticGatewayFetch
  let probed
  try {
    probed = await call({ action: 'probe', route: ROUTE, model: probeTarget })
  } finally {
    globalThis.fetch = realFetch
    effectiveEfforts = ['low', 'high']
  }
  check('a probe does not rewrite a declaration the model already satisfies',
    probed.body?.value?.declared?.already === true && settingsWrites.length === before,
    `${JSON.stringify(probed.body?.value?.declared ?? null)} writes=${settingsWrites.length - before}`)
}

// ── the level list is the platform's, not our memory of it ──────────────────
// The probe sweeps a literal list. If the platform's gate gains a level, a stale copy
// would silently stop measuring it — the failure is invisible, so it is pinned here.
{
  const ourSource = readFileSync(join(HERE, 'index.js'), 'utf8')
  const ourLiteral = ourSource.match(/const REASONING_LEVELS = (\[[^\]]*\])/)?.[1] ?? '[]'
  const ours = JSON.parse(ourLiteral.replace(/'/g, '"'))
  const checkout = process.env.DSH_CHECKOUT ?? join(HERE, '..', '..', '..', 'deepseek-harness')
  const catalog = readFileSync(join(checkout, 'packages/llm/llm-pi-ai/src/catalog.ts'), 'utf8')
  const gateStart = catalog.indexOf('const THINKING_LEVEL_GATE')
  const gateBody = gateStart === -1 ? '' : catalog.slice(gateStart, catalog.indexOf('}', gateStart))
  const theirs = [...gateBody.matchAll(/^\s*([a-z]+): true,/gm)].map(match => match[1])
  check('the measured levels mirror the platform thinking-level gate',
    theirs.length > 0 && ours.join(',') === theirs.join(','),
    `${ours.join(',') || 'none'} vs ${theirs.join(',') || 'none'}`)
  const derived = /REASONING_PROBE_LEVELS = REASONING_LEVELS\.filter\(level => level !== 'off'\)/.test(ourSource)
  check('the probe sweeps that gate minus off', derived,
    derived ? 'derived from the gate' : 'a hard-coded copy')
}

// ── the marks the shipped picker's label needs, in one cheap answer ─────────
// The label renders for every picker row before anything is expanded, so the answer
// has to come from the overlay alone — a directory read per row would be a stampede.
{
  const badges = await call({ action: 'badges' })
  const rows = badges.body?.value
  check('the badges action answers one row per catalog model',
    Array.isArray(rows) && rows.length > 0
      && rows.every(row => typeof row.route === 'string' && typeof row.model === 'string'
        && typeof row.status === 'string'),
    Array.isArray(rows) ? `${rows.length} row(s)` : JSON.stringify(badges.body ?? null))
  const graded = (rows ?? []).filter(row => typeof row.level === 'number' && row.level >= 1)
  check('a badge carries the level and the use count, not just health',
    graded.length > 0 && typeof graded[0].uses === 'number',
    JSON.stringify(graded[0] ?? null))
  check('the badges answer does not drag a snapshot with it',
    badges.body?.snapshot === undefined, Object.keys(badges.body ?? {}).join(','))
}

// ── the policy and the log the manager dialog edits ─────────────────────────
// The dialog owns two things the Loader row cannot: the fallback order the user
// arranges, and the record of what each probe actually saw. Both are stored in
// the plugin's own documents, so the answers below also prove the normalizer
// carries them through a read-modify-write instead of erasing them.
{
  const initial = await call({ action: 'fallbackConfig' })
  check('the fallback policy is readable before anything is saved',
    initial.body?.ok === true
      && typeof initial.body.value?.enabled === 'boolean'
      && Array.isArray(initial.body.value?.chain),
    JSON.stringify(initial.body?.value ?? null))

  const bad = await call({ action: 'setFallback', chain: ['not-a-pair'] })
  check('a chain entry that is not a route/model pair is refused',
    bad.status === 400 && /not a route\/model pair/.test(bad.body?.message ?? ''),
    `${bad.status} ${bad.body?.message ?? ''}`)

  const saved = await call({
    action: 'setFallback',
    enabled: false,
    chain: [`${ROUTE}/${at(3)}`, `${ROUTE}/${at(3)}`, `${ROUTE}/${at(4)}`],
  })
  check('a saved policy drops duplicates and keeps the order',
    JSON.stringify(saved.body?.value?.chain) === JSON.stringify([`${ROUTE}/${at(3)}`, `${ROUTE}/${at(4)}`]),
    JSON.stringify(saved.body?.value ?? null))
  check('a saved policy flips the switch the snapshot reports',
    saved.body?.snapshot?.fallbackEnabled === false,
    String(saved.body?.snapshot?.fallbackEnabled))

  const restored = await call({ action: 'setFallback', enabled: true, chain: [] })
  check('the policy can be put back',
    restored.body?.value?.enabled === true && (restored.body?.value?.chain ?? []).length === 0,
    JSON.stringify(restored.body?.value ?? null))
}

// ── the recovery policy the same dialog exposes ──────────────────────────────
// Both halves default to on, and both are overridable without editing the profile
// the plugin was loaded from.
{
  const initial = await call({ action: 'recoveryConfig' })
  check('the recovery policy is readable and defaults to doing the work',
    initial.body?.ok === true
      && initial.body.value?.retryFirst === true
      && initial.body.value?.autoContinue === true,
    JSON.stringify(initial.body?.value ?? null))

  const refused = await call({ action: 'setRecovery' })
  check('a recovery write with neither switch is refused',
    refused.status === 400 && /setRecovery needs/.test(refused.body?.message ?? refused.body?.error ?? ''),
    `${refused.status} ${refused.body?.message ?? refused.body?.error ?? ''}`)

  const saved = await call({ action: 'setRecovery', autoContinue: false, retryFirst: false })
  check('a saved recovery policy comes back from the same place',
    saved.body?.value?.autoContinue === false && saved.body?.value?.retryFirst === false,
    JSON.stringify(saved.body?.value ?? null))

  const fresh = await call({ action: 'snapshot' })
  check('a saved recovery policy is what the manager renders',
    fresh.body?.value?.recovery?.autoContinue === false && fresh.body?.value?.recovery?.retryFirst === false,
    JSON.stringify(fresh.body?.value?.recovery ?? null))

  const back = await call({ action: 'setRecovery', autoContinue: true, retryFirst: true })
  check('the recovery policy can be put back',
    back.body?.value?.autoContinue === true && back.body?.value?.retryFirst === true,
    JSON.stringify(back.body?.value ?? null))
}

// The probe log answers "what happened", which the per-model health record cannot.
{
  const realFetch = globalThis.fetch
  globalThis.fetch = syntheticGatewayFetch
  let probe
  try {
    probe = await call({ action: 'probe', route: ROUTE, model: at(2) })
  } finally { globalThis.fetch = realFetch }
  const log = await call({ action: 'probeRecords' })
  const records = log.body?.value?.records ?? []
  check('a probe leaves a record behind',
    records.length > 0
      && records[0].model === at(2)
      && records[0].status === probe.body?.value?.reason
      && Array.isArray(records[0].levels) && records[0].levels.length > 0,
    JSON.stringify(records[0] ?? null))
  check('the probe log is newest first',
    records.every((row, index) => index === 0 || records[index - 1].at >= row.at),
    records.slice(0, 3).map(row => row.at).join(','))
}

// Proficiency is derived from the ledger, but the user may know better. A manual
// level must win without erasing the counters, which is what `manual` reports.
{
  const target = at(1)
  const usageOf = snapshot => (snapshot?.models ?? []).find(model => model.model === target)?.usage
  const set = await call({ action: 'setLevel', model: target, level: 6 })
  check('a manual level is stored and reported',
    usageOf(set.body?.snapshot)?.level === 6 && usageOf(set.body?.snapshot)?.manual === true,
    JSON.stringify(usageOf(set.body?.snapshot) ?? null))
  const cleared = await call({ action: 'setLevel', model: target, level: null })
  check('clearing the manual level returns to the derived one',
    usageOf(cleared.body?.snapshot)?.manual === false,
    JSON.stringify(usageOf(cleared.body?.snapshot) ?? null))
  const refused = await call({ action: 'setLevel', model: target, level: 9 })
  check('a level outside the ladder is refused', refused.status === 400,
    `${refused.status} ${refused.body?.message ?? ''}`)
}

// ── the mode the client half has to ask for ─────────────────────────────────
// The client runtime gives a plugin no Loader row config, so the picker's mode can
// only arrive from here. A missing or misnamed action would leave the client
// guessing, which is how `selector.mode` was inert in the first place.
{
  const response = await call({ action: 'selectorMode' })
  const value = response.body?.value
  // One model entry, ours: the picker in the composer carries the shipped capabilities
  // plus levels, probes and the manager, so it owns the seat unless the row asks for
  // `native`. Two entries (the shipped picker and a rail beside it) is the state the
  // user rejected as "太怪异".
  check('the selectorMode action reports the configured mode',
    value?.selectorMode === 'managed', `got ${JSON.stringify(value ?? response.body)}`)
  // One enum is the whole point: it must not drag a model listing along with it.
  check('the selectorMode action answers without a snapshot',
    response.body?.snapshot === undefined && value !== undefined,
    Object.keys(response.body ?? {}).join(','))
}

// ── the model-first view ────────────────────────────────────────────────────
// The list's key is the MODEL, not the transport. Two routes serving one model id
// are one entry carrying two routes, which is what stops a wrapper route (a vision
// twin today, anything tomorrow) from listing the same model again.
{
  const snapshot = (await call({ action: 'snapshot' })).body?.value
  const models = snapshot?.models ?? []
  const rows = (snapshot?.groups ?? []).flatMap(group => group.rows)
  check('the snapshot carries a model-first view', Array.isArray(snapshot?.models) && models.length > 0,
    `${models.length} model(s)`)
  check('the model view has one entry per model id, not one per route',
    models.length < rows.length && new Set(models.map(entry => entry.model)).size === models.length,
    `${models.length} model(s) vs ${rows.length} route row(s)`)

  const shared = models.find(entry => entry.model === at(0))
  const sharedRoutes = shared?.routes.map(entry => entry.route).sort().join(',') ?? ''
  check('a model reachable through two routes is one entry carrying both',
    shared?.routes.length === 2 && sharedRoutes === [ROUTE, MIRROR_ROUTE].sort().join(','),
    sharedRoutes || 'no shared model')
  check('a single-route model carries exactly its own route',
    (models.find(entry => entry.model === at(3))?.routes ?? []).length === 1,
    `${(models.find(entry => entry.model === at(3))?.routes ?? []).length} route(s)`)

  const summed = (shared?.routes ?? []).reduce((sum, route) => sum + route.usage.uses, 0)
  check('usage is summed across a model routes rather than split per route',
    shared?.usage.uses === summed, `model ${shared?.usage.uses} vs routes ${summed}`)

  // A pin is a statement about the model the user wants, so it must survive being
  // written on whichever route the row happened to select. Both routes start clear
  // and only the NON-primary one is pinned: if the model-level flag were resolved
  // from the primary route alone, this would read as unpinned — which is exactly the
  // bug a per-route flag would produce.
  for (const route of [ROUTE, MIRROR_ROUTE]) {
    await call({ action: 'toggle', route, model: at(1), list: 'pins', on: false })
  }
  await call({ action: 'toggle', route: MIRROR_ROUTE, model: at(1), list: 'pins', on: true })
  const pinned = (await call({ action: 'snapshot' })).body?.value?.models?.find(entry => entry.model === at(1))
  const primaryRoute = (pinned?.routes ?? []).find(route => route.route === pinned?.primary)
  check('a pin written on a non-primary route still marks the model pinned',
    pinned?.pinned === true && primaryRoute?.pinned === false,
    `model pinned=${pinned?.pinned} primary(${pinned?.primary}).pinned=${primaryRoute?.pinned}`)
  // Primary is decided by history, not by catalog order — otherwise the tie-break
  // would be the only thing the earlier assertion tested. Give the mirror route more
  // recorded use than the base route for one model and the row must follow it.
  for (let n = 0; n < 5; n += 1) {
    emit('session/event', { id: 'sess-model-first' }, {
      type: 'assistant/message',
      seq: 9000 + n,
      time: Date.now(),
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', source: { kind: 'model', provider: MIRROR_ROUTE, model: at(0) } },
        stream: [],
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    })
  }
  const flipped = (await call({ action: 'snapshot' })).body?.value?.models?.find(entry => entry.model === at(0))
  check('the primary route follows recorded use rather than catalog order',
    flipped?.primary === MIRROR_ROUTE, `primary=${flipped?.primary}`)
  const acrossRoutes = (flipped?.routes ?? []).reduce((sum, route) => sum + route.usage.uses, 0)
  check('a model used on two routes reports one level over both',
    flipped?.usage.uses === acrossRoutes && acrossRoutes > (flipped?.routes ?? []).reduce(
      (best, route) => Math.max(best, route.usage.uses), 0),
    `model ${flipped?.usage.uses} vs routes ${acrossRoutes}`)
}

// ── taking a model out of the catalogue ─────────────────────────────────────
// A gateway retires models, and a list that can only ever grow stops describing
// what is available. The removal is a local decision (the plugin cannot
// unregister a model upstream), so it must be reversible and must not leave the
// model reachable through the one path that would contradict the list: routing.
{
  const doomed = at(4)
  const before = (await call({ action: 'snapshot' })).body?.value
  const listedBefore = (before?.models ?? []).some(entry => entry.model === doomed)
  const removal = await call({ action: 'removeModel', route: ROUTE, model: doomed })
  const after = removal.body?.value
  check('removing a model takes it out of the catalogue view',
    listedBefore && after !== undefined && !(after.models ?? []).some(entry => entry.model === doomed),
    `${(after?.models ?? []).map(entry => entry.model).join(',')}`)
  check('a removed model is listed separately so it can be restored',
    (after?.removed ?? []).some(entry => entry.model === doomed && entry.listed === true),
    JSON.stringify(after?.removed ?? null))

  // The chain names the removed model first. If removal only filtered the view,
  // the very next failure would route into a model the user had just taken away.
  await call({ action: 'setFallback', enabled: true, chain: [`${ROUTE}/${doomed}`] })
  const survivor = AGENT_FOR(70)
  await observe(survivor, at(0))
  const beforeMove = sessionCalls.length
  await fireError(survivor, { code: 'RATE_LIMIT', status: 429, message: gatewayBody(2007, 'quota exhausted') })
  const landedOn = sessionCalls.slice(beforeMove).map(entry => entry.model).join(',')
  check('a removed model is never chosen as a fallback target', landedOn !== doomed,
    `landed on ${landedOn || 'none'}`)
  await call({ action: 'setFallback', enabled: true, chain: [] })

  const restored = (await call({ action: 'restoreModel', route: ROUTE, model: doomed })).body?.value
  check('a restored model comes back and leaves the removed list',
    (restored?.models ?? []).some(entry => entry.model === doomed)
      && !(restored?.removed ?? []).some(entry => entry.model === doomed))
  const incomplete = await call({ action: 'removeModel', route: ROUTE })
  check('removing without a model is refused', incomplete.status === 400,
    `${incomplete.status} ${incomplete.body?.message ?? ''}`)
}

// ── the host range this build was verified against ──────────────────────────
// A host that cannot satisfy the contract this plugin leans on would install and
// then silently lose rows — the failure mode that opened a colleague's picker
// without the teamwork row. `engines.dsh` turns that into an install-time refusal,
// so the range has to exist, be a real range, and admit the host running the suite.
{
  const manifest = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
  const range = manifest.engines?.dsh
  const checkout = process.env.DSH_CHECKOUT ?? join(HERE, '..', '..', '..', 'deepseek-harness')
  const runtime = JSON.parse(readFileSync(join(checkout, 'packages/boot/app-boot/package.json'), 'utf8')).version
  let admits = false
  let why = typeof range === 'string' ? range : 'no engines.dsh declared'
  if (typeof range === 'string' && range !== '') {
    try {
      const semver = createRequire(join(checkout, 'package.json'))('semver')
      admits = semver.satisfies(runtime, range, { includePrerelease: true })
      why = `host ${runtime} against ${range}`
    } catch (error) { why = `unreadable range: ${error.message}` }
  }
  check('the manifest declares the host range it was verified against', admits, why)
}

// ── the recovery budgets are policy, not constants ───────────────────────────
// How many models may be tried, how many times the work may be picked back up and
// how long a session is given to go idle are the three numbers a bad week makes
// someone want to raise. They are numbers on the same stored policy as the two
// switches, so they have to survive a write and actually bound the work.
{
  const numeric = await call({ action: 'setRecovery', maxSwitches: 1, maxContinuations: 0, idleWaitMs: 250 })
  check('the recovery budgets can be read and written as numbers',
    numeric.body?.value?.maxSwitches === 1
      && numeric.body?.value?.maxContinuations === 0
      && numeric.body?.value?.idleWaitMs === 250,
    JSON.stringify(numeric.body?.value ?? null))

  const tooMany = await call({ action: 'setRecovery', maxSwitches: 99 })
  // Range refusals answer with `message`; a body with nothing to write answers with `error`.
  const tooManyWhy = tooMany.body?.message ?? tooMany.body?.error ?? ''
  check('a switch budget outside the allowed range is refused',
    tooMany.status === 400 && /integer from 0 to 10/.test(tooManyWhy),
    `${tooMany.status} ${tooManyWhy}`)

  const tooFast = await call({ action: 'setRecovery', idleWaitMs: 10 })
  const tooFastWhy = tooFast.body?.message ?? tooFast.body?.error ?? ''
  check('an idle wait outside the allowed range is refused',
    tooFast.status === 400 && /idleWaitMs must be an integer from 50 to 60000/.test(tooFastWhy),
    `${tooFast.status} ${tooFastWhy}`)

  // The wait is stated in milliseconds and has to become attempts, not a literal.
  const source = readFileSync(join(HERE, 'index.js'), 'utf8')
  check('the idle wait is turned into attempts rather than hard-coded',
    /const attempts = Math\.max\(1, Math\.ceil\(idleWaitMs \/ 50\)\)/.test(source),
    'a literal attempt count would ignore the number the dialog shows')

  const capped = repairedAgent(58)
  await observe(capped, at(2))
  // The budget is a count of moves, so the count of moves is what gets asserted; the
  // refusal text is internal bookkeeping and reading it would only test my own plumbing.
  const movesBefore = sessionCalls.length
  await fireError(capped, { code: 'RATE_LIMIT', status: 429, message: gatewayBody(2007, 'quota exhausted') })
  await fireError(capped, { code: 'RATE_LIMIT', status: 429, message: gatewayBody(2007, 'quota exhausted') })
  const moves = sessionCalls.slice(movesBefore).map(entry => entry.model)
  check('the switch budget stops a second switch in the same turn',
    moves.length === 1,
    `${moves.length} move(s): ${moves.join(' | ')}`)

  turnEnd('sess-58')
  await settle()
  const cappedLog = await logFor('sess-58')
  check('a continuation budget of zero stops the pickup and says so',
    cappedLog?.continued === false && /already continued 0 time/.test(cappedLog?.continueRefused ?? ''),
    `continued=${cappedLog?.continued} refused=${cappedLog?.continueRefused ?? 'none'}`)

  const restored = await call({ action: 'setRecovery', maxSwitches: 3, maxContinuations: 2, idleWaitMs: 1000 })
  check('the budgets can be put back to their defaults',
    restored.body?.value?.maxSwitches === 3
      && restored.body?.value?.maxContinuations === 2
      && restored.body?.value?.idleWaitMs === 1000,
    JSON.stringify(restored.body?.value ?? null))
}


// ── a switch is corrected once the next turn proves it ──────────────────────
// The turn that fails cannot know whether the new model will answer; the next turn
// can. The record therefore starts as unreached and is corrected, instead of staying
// wrong forever — which is what made the old "recovered" column always zero.
{
  const a = repairedAgent(60)
  await observe(a, at(2))
  await fireError(a, { code: 'RATE_LIMIT', status: 429, message: gatewayBody(2007, 'quota exhausted') })
  turnEnd('sess-60', 1)
  await settle(400)
  const first = (await call({ action: 'failoverHistory' })).body?.value?.records
    ?.find(record => record.sessionId === 'sess-60')
  check('a switch is recorded with an id it can be corrected by',
    typeof first?.id === 'string' && first?.outcome === 'unreached',
    `id=${typeof first?.id} outcome=${first?.outcome}`)
  const promised = first?.to
  emitSession('sess-60', messageEvent(promised?.model, 2, promised?.route))
  await settle(300)
  const corrected = (await call({ action: 'failoverHistory' })).body?.value?.records
    ?.find(record => record.sessionId === 'sess-60')
  check('the next turn on the new model turns the report into reached',
    corrected?.outcome === 'reached' && typeof corrected?.reachedAt === 'number',
    `outcome=${corrected?.outcome} at=${typeof corrected?.reachedAt} continued=${first?.continued} refused=${first?.continueRefused ?? 'none'}`)
  check('a record written before ids existed is marked as beyond correction',
    (await call({ action: 'failoverHistory' })).body?.value?.records
      ?.some(record => record.legacy === false), 'no record without a legacy flag')
}

// ── failures a model switch cannot fix ──────────────────────────────────────
// "Needs GitHub authorization" and "the host does not resolve" are both facts no
// other model changes. Switching there burns the budget and moves the session for
// nothing, so the answer is to stand still — and the second one is not even a fact
// about the model.
{
  const before = sessionCalls.length
  const a = repairedAgent(61)
  await observe(a, at(2))
  await fireError(a, {
    code: 'UNAUTHORIZED',
    status: 403,
    message: '需要 GitHub 授权并 star 仓库后使用 EAC 模型',
  })
  check('a model that needs authorization is not swapped for another',
    sessionCalls.length === before,
    `moved ${sessionCalls.length - before} time(s)`)
  const b = repairedAgent(62)
  await observe(b, at(2))
  await fireError(b, { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND gateway.invalid' })
  check('a route that does not resolve is not read as a model failure',
    sessionCalls.length === before,
    `moved ${sessionCalls.length - before} time(s)`)
}

// ── clearing the history is not the same as destroying it ───────────────────
{
  await call({ action: 'clearFailover' })
  const cleared = (await call({ action: 'failoverHistory' })).body?.value?.records
  const undo = await call({ action: 'undoClearFailover' })
  const restored = (await call({ action: 'failoverHistory' })).body?.value?.records
  check('clearing the history can be taken back',
    cleared.length === 0 && undo.status === 200 && restored.length > 0,
    `cleared=${cleared.length} undo=${undo.status} restored=${restored.length}`)
  const again = await call({ action: 'undoClearFailover' })
  check('there is nothing to take back once the restore has happened',
    again.status === 400, `${again.status}`)
}

// ── the default model is a fact worth checking, and changing ────────────────
{
  const before = (await call({ action: 'defaultModel' })).body?.value
  check('the host can report the model a new session would start on',
    before?.known === true && before?.route === ROUTE && before?.model === at(0),
    JSON.stringify({ known: before?.known, route: before?.route, model: before?.model }))
  const pick = at(1)
  const saved = await call({ action: 'setDefaultModel', route: ROUTE, model: pick })
  const after = (await call({ action: 'defaultModel' })).body?.value
  check('the default model can be moved, and the move reads back',
    saved.status === 200 && after?.model === pick
      && savedDefaults.some(entry => entry.model === pick),
    `status=${saved.status} model=${after?.model} saved=${JSON.stringify(savedDefaults.at(-1) ?? null)}`)
  const refused = await call({ action: 'setDefaultModel', model: pick })
  check('a default model without a route is refused',
    refused.status === 400, `${refused.status}`)
  await call({ action: 'setDefaultModel', route: ROUTE, model: at(0) })
}

// The seats this plugin takes over keep growing upstream, and a replacement
// cannot inherit the rows the shipped entry appends to them (the slot table
// refuses a second declaration of the same child key). So the comparison runs
// here, as a check, rather than as something a person has to remember.
if (existsSync(join(HERE, 'docs/upstream-parity.json'))) {
  const parity = spawnSync(process.execPath, [join(HERE, 'tools/check-upstream.mjs')], {
    cwd: HERE,
    encoding: 'utf8',
    env: process.env,
  })
  const refused = (parity.stdout ?? '').split('\n').filter(line => line.startsWith('FAIL'))
  check('every upstream row in the seats we took over is accounted for',
    parity.status === 0,
    refused.slice(0, 3).map(line => line.replace(/^FAIL\s+/, '')).join(' | ').slice(0, 380))
}

rmSync(HOME, { recursive: true, force: true })
const failed = results.filter(r => !r.passed)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('FAILED:', failed.map(f => f.label).join('; '))
  process.exit(1)
}
