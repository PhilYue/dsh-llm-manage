/**
 * dsh-llm-manage — browser-half verification.
 *
 * Renders the REAL `client.js` panel in jsdom and drives it against the REAL
 * Host route registered by `index.js`. Nothing about the request/response
 * contract is stubbed: a click issues a real `fetch` to the Host handler, and
 * the assertion reads the resulting DOM.
 *
 * This exists because the two halves can agree on every type and still disagree
 * on a field name. The panel once folded `data.snapshot` while the Host returned
 * the same state under `value`, so `pin`/`favorite`/`hide` updated nothing until
 * the user reloaded by hand — invisible to a Host-only test.
 *
 * The environment comes from ./verify-env.mjs, the same module `verify.mjs`
 * uses, so the two suites cannot disagree about route, models or mode.
 *
 *   node verify-client.mjs
 *   LLMM_VERIFY_MODE=synthetic node verify-client.mjs   # force one mode
 *
 * Exits non-zero when a check fails.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  apiKey as API_KEY,
  at,
  checkoutRootOrExit,
  displayName as DISPLAY_NAME,
  mode,
  models as MODELS,
  route as ROUTE,
  settings as SETTINGS,
  settingsNs as SETTINGS_NS,
  syntheticGatewayFetch,
} from './verify-env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// React and jsdom resolve from the checkout's own install, not from this plugin.
const DH = checkoutRootOrExit(join('apps', 'web', 'package.json'))
const fromWeb = createRequire(join(DH, 'apps/web/package.json'))
const fromRoot = createRequire(join(DH, 'package.json'))

// Importing ./verify-env.mjs above already located the real profile, so the
// redirect below cannot hide it.
const HOME = mkdtempSync(join(tmpdir(), 'llmm-client-'))
process.env.DSH_HOME = HOME
// The automatic-switch history is written by the Host only once a switch is
// proven, and no headless run can prove one. Seeding the document states the
// fact instead of pretending the panel invented it.
{
  const dir = join(HOME, 'storages', 'llm-manage')
  mkdirSync(dir, { recursive: true })
  const now = Date.now()
  writeFileSync(join(dir, '__failover__.json'), JSON.stringify({
    records: [
      // The continuation outcome is part of the record now, so one seeded row states
      // each answer: picked back up, never picked up, and a level repair that did.
      { at: now - 3000, sessionId: 'sess-seed-a', from: { route: 'seed-gateway', model: 'seeded-flaky' }, to: { route: 'seed-gateway', model: 'seeded-ok' }, reason: 'quota', detail: '', outcome: 'unreached', continued: true },
      { at: now - 2000, sessionId: 'sess-seed-b', from: { route: 'seed-gateway', model: 'seeded-flaky' }, to: { route: 'seed-gateway', model: 'seeded-ok' }, reason: 'quota', detail: '', outcome: 'reached', continued: false, continueRefused: 'already continued 2 time(s) for this request' },
      { at: now - 1000, sessionId: 'sess-seed-c', from: { route: 'seed-gateway', model: 'seeded-other' }, to: { route: 'seed-gateway', model: 'seeded-ok' }, reason: 'error', detail: '', outcome: 'ran-elsewhere', continued: true },
      // The same Session failing again 30s later: one incident, two rows. Without this
      // the grouping would collapse nothing and the assertion below would prove nothing.
      { at: now - 500, sessionId: 'sess-seed-c', from: { route: 'seed-gateway', model: 'seeded-flaky2' }, to: { route: 'seed-gateway', model: 'seeded-ok2' }, reason: 'error', detail: '', outcome: 'reached', continued: true },
    ],
  }), 'utf8')
}

const registered = []
const listeners = {}
let routes = []

// ── jsdom, installed before either half is imported ─────────────────────────
const { JSDOM } = fromRoot('jsdom')
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: 'http://127.0.0.1:3080/',
  pretendToBeVisual: true,
})
const { window } = dom
// `AbortController` is deliberately NOT borrowed from jsdom: the Host half calls
// Node's `fetch`, and undici rejects a signal built by another realm
// ("Expected signal to be an instance of AbortSignal"). Borrowing it made every
// forced gateway directory read fail here while working in production — a test
// artefact that reads like a product bug. Node's own pair is the consistent one.
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'CustomEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver']) {
  if (window[key] === undefined) continue
  // Node 26 defines some of these (navigator, AbortController) as getter-only
  // globals, so an assignment throws; defineProperty overrides them instead.
  try {
    globalThis[key] = window[key]
  } catch {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: window[key] })
  }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = fromWeb('react')
const { createRoot } = fromWeb('react-dom/client')
const { act } = React

// ── the real Host half, behind a fetch the panel will really call ───────────
// A second route serving some of the SAME model ids. Real gateways do this, and
// it is why a row lifted out of its route group has to keep naming its route:
// one model id on two routes is two different selections.
const SECOND_ROUTE = `${ROUTE}-mirror`
const MIRRORED = MODELS.slice(0, 2)

const connection = { fetch: { register: (r) => { routes.push(r); return () => {} } } }
const llmService = {
  listProviders: () => [{ id: ROUTE, name: DISPLAY_NAME }, { id: SECOND_ROUTE, name: 'Mirror' }],
  listConfigurableProviders: () => [{ provider: ROUTE, displayName: DISPLAY_NAME, settingsNs: SETTINGS_NS, settingsPath: ['providers', ROUTE] }],
  listModels: async (id) => (id === SECOND_ROUTE ? MIRRORED : MODELS).map(model => ({ id: model, name: model })),
}
/** Settings section as last written through the host, plus the writes themselves. */
let settingsValue = SETTINGS
const settingsWrites = []
const hostGet = (k) => {
  if (k === 'connection') return connection
  if (k === 'llm') return llmService
  if (k === 'settings') {
    // Writable, because declaring measured levels goes through the same path the
    // settings UI uses. The writes are recorded so a click can be verified.
    return {
      describe: () => [{
        ns: SETTINGS_NS, autoInitialize: false, schema: {}, revision: 1 + settingsWrites.length,
        applies: 'live', value: settingsValue, base: SETTINGS, user: settingsValue,
      }],
      replace: async (ns, section) => { settingsWrites.push({ ns, section: structuredClone(section) }); settingsValue = section },
    }
  }
  if (k === 'credentials') return { resolve: async () => ({ value: API_KEY, source: 'test' }) }
  return undefined
}

/**
 * Install Cordis's inject guard for `llm`.
 * @param {object} target - the context.
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
const hostCtx = guard({
  inject: (_names, cb) => { cb(hostScope()) },
  on: (name, cb) => { (listeners[name] ??= []).push(cb); return () => {} },
  effect: (fn) => { const d = typeof fn === 'function' ? fn() : undefined; return typeof d === 'function' ? d : () => {} },
  get: hostGet,
}, false)
function hostScope() {
  return guard({
    tools: { register: (d) => { registered.push(d); return () => {} } },
    on: (name, cb) => { (listeners[name] ??= []).push(cb); return () => {} },
    effect: (fn) => { const d = typeof fn === 'function' ? fn() : undefined; return typeof d === 'function' ? d : () => {} },
    get: (k) => (k === 'connection' ? connection : hostGet(k)),
  }, true)
}

const host = await import(join(HERE, 'index.js'))
host.apply(hostCtx, undefined)
const handler = routes.find(r => r.path === '/api/llm-manage')
if (handler === undefined) throw new Error('the Host half registered no /api/llm-manage route')

// jsdom implements no fetch/Request/Response, so those come from Node itself —
// which is also what the Host half used to build its responses.
// One bridge for both directions. The panel's own calls target /api/llm-manage
// and must reach the Host handler; the Host handler's own gateway calls must NOT
// come back through it, or a directory read would be answered by the Host route
// instead of the gateway. So only the plugin's API path is intercepted.
const gatewayFetch = mode === 'synthetic' ? syntheticGatewayFetch : globalThis.fetch
globalThis.fetch = async (url, init) => {
  const href = new URL(String(url), 'http://127.0.0.1:3080').href
  if (new URL(href).pathname === '/api/llm-manage') return handler.fetch(new Request(href, init))
  return gatewayFetch(href, init)
}

// ── the real Client half ────────────────────────────────────────────────────
// The loader's require can only hand back modules the platform SEEDS (see
// web/src/seed.ts). This suite used to mock a hand-written allowlist, which
// enforced nothing about reality: it passed while the client required a module
// no seed supplies, and it would have failed for a seeded module the mock never
// learned about. So the seed list is READ FROM THE CHECKOUT here, and the same
// list both drives the mock and guards the client's requires below.
const seedSource = readFileSync(join(DH, 'packages/client/web/src/seed.ts'), 'utf8')
const seedBody = seedSource.slice(seedSource.indexOf('return {'))
const seedWords = new Set([...seedBody.matchAll(/^\s*'([^']+)':/gm)].map(m => m[1]))
if (seedWords.size === 0) throw new Error('parsed no seed words from packages/client/web/src/seed.ts')
const PLATFORM = {
  'react': React,
  'react-dom': fromWeb('react-dom'),
  'react-dom/client': fromWeb('react-dom/client'),
  'react/jsx-runtime': React,
}
const slots = []
window.__ModuleLoader__ = {
  load: ({ id, factory }) => {
    if (id !== 'dsh-llm-manage') throw new Error(`unexpected module id "${id}"`)
    captured = factory((name) => {
      if (!seedWords.has(name)) {
        throw new Error(`client.js required "${name}", which the platform seed does not provide`)
      }
      if (PLATFORM[name] === undefined) {
        throw new Error(`client.js required the seeded module "${name}", which this suite does not stand up`)
      }
      return PLATFORM[name]
    })
  },
}
let captured
await import(pathToFileURL(join(HERE, 'client.js')).href)
if (captured === undefined) throw new Error('client.js did not call __ModuleLoader__.load')

// The picker subscribes through `useSyncExternalStore`, so this store must return
// a STABLE snapshot object: a fresh one per call makes React re-render forever.
// `selections` records the select verb's argument, so a test can prove that
// clicking a row asks for that row's route and model and nothing invented.
const dirSnapshot = { current: null, groups: [], retainedEffort: undefined }
const dirStore = { subscribe: () => () => {}, getSnapshot: () => dirSnapshot }
const selections = []
// Cordis scopes a service proxy to the CONSUMER's declared inject list: reading a
// service the list omits throws `cannot get property "X" without inject`. This suite
// handed the client half a plain object, so it enforced nothing — and passed while
// the live app crashed the picker's slot entry for a missing `remote` declaration,
// taking the picker's entire <style> with it.
//
// Only registered SERVICE paths are gated: `remote.session` is its own service,
// while `slots.inject` is a method on the `slots` service and stays reachable.
const clientDeclared = new Set(captured.inject ?? [])
const clientServices = {
  slots: {
    inject: (_key, callback) => { callback() },
    register: (options, Component) => { slots.push({ options, Component }); return () => {} },
  },
  sessions: { subagentAddress: () => undefined },
  // The resolver's own face: `directoryFor` reads these off the consumer's scope,
  // exactly as the shipped ModelDirectoryResolver does with `this.ctx`. That is why
  // declaring only the services called by name is not enough.
  modelDirectories: {
    directoryFor: () => {
      void clientCtx.sessions.subagentAddress('probe')
      void clientCtx.remote.session
      return {
        store: dirStore,
        load: async () => {},
        select: async (selection) => { selections.push(selection); return { ok: true, value: undefined } },
      }
    },
  },
  remote: { session: { verb: () => Promise.resolve(undefined) } },
}
// Drawn by the history tab when a row names a Session: one navigation action, which is
// the whole point of putting the Session on the row.
const navigations = []
const clientCtx = (() => {
  const require_ = (path) => {
    if (!clientDeclared.has(path)) throw new Error(`cannot get property "${path}" without inject`)
  }
  const scope = {}
  for (const name of ['slots', 'sessions', 'modelDirectories']) {
    Object.defineProperty(scope, name, { get: () => { require_(name); return clientServices[name] } })
  }
  Object.defineProperty(scope, 'remote', {
    get: () => {
      require_('remote')
      return { get session() { require_('remote.session'); return clientServices.remote.session } }
    },
  })
  // Nested injects are how this client reaches optional faces without gating the whole
  // plugin on them (a client that lacks `uiWorkspace` must still mount). Resolved here so
  // a test can see what the UI actually asked for, rather than what it was handed.
  scope.inject = (_names, callback) => {
    const nested = {
      uiWorkspace: { openSession: (sessionId) => { navigations.push(sessionId) } },
    }
    const release = callback(nested)
    return () => { if (typeof release === 'function') release() }
  }
  return scope
})()
captured.apply(clientCtx)

const panelSlot = slots.find(s => s.options.id === 'llm-manage-panel')
if (panelSlot === undefined) throw new Error(`the client half registered no panel; got ${slots.map(s => s.options.id).join(',')}`)

const results = []
function check(label, passed, detail = '') {
  results.push({ label, passed })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

// ── render the panel and click it ───────────────────────────────────────────
console.log(`mode: ${mode} (route ${ROUTE}, ${MODELS.length} models)\n`)

/**
 * Poll a condition instead of sleeping for a guessed duration.
 *
 * A fixed sleep is the usual source of a suite that passes alone and fails under
 * load: the work it waits for is a React flush plus a real HTTP round trip to the
 * Host, neither of which has a fixed duration. Polling also keeps the failing case
 * honest — it waits the full budget and then reports the real state.
 *
 * @param {() => boolean} predicate - condition to reach.
 * @param {number} timeoutMs - how long to keep trying.
 * @returns {Promise<boolean>} whether the condition held.
 */
const waitFor = async (predicate, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return predicate()
}

const container = window.document.getElementById('app')
const root = createRoot(container)
const Panel = panelSlot.Component
await act(async () => {
  root.render(React.createElement(Panel, { provider: { provider: ROUTE } }))
})
// Let the mount-time snapshot settle: poll until rows exist rather than guessing.
await act(async () => { await waitFor(() => container.querySelectorAll('.llmm-row').length > 0) })

const text = () => container.querySelector('.llmm-rows')?.textContent ?? ''
check('the panel rendered the route\'s model rows', text().includes(at(0)), `${text().slice(0, 70)}…`)

const buttons = () => Array.from(container.querySelectorAll('button'))
const pinButtons = () => buttons().filter(b => b.getAttribute('aria-label') === '置顶' || b.getAttribute('aria-label') === 'Pin')
check('row actions are icon buttons carrying an accessible label', pinButtons().length > 0, `${pinButtons().length} pin buttons`)

const labels = new Set(buttons().map(b => b.getAttribute('aria-label')).filter(Boolean))
check('every row action exposes a label for hover/focus', labels.size >= 4, [...labels].join(' / '))

// The regression: clicking must update the panel with no reload. Before the fix
// the Host returned the new state under `value`, the panel read `snapshot`, and
// this assertion failed while the state had in fact changed on disk.
//
// Counting `aria-pressed` across EVERY button is deliberate: a pinned row's label
// flips from "Pin" to "Unpin", so filtering by the "Pin" label drops the very row
// that just changed and would report a false negative.
const pressedCount = () => buttons().filter(b => b.getAttribute('aria-pressed') === 'true').length
const pressedBefore = pressedCount()
const target = pinButtons()[0]
await act(async () => {
  target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await waitFor(() => pressedCount() === pressedBefore + 1)
})
const pressedAfter = pressedCount()
check('clicking pin updates the panel with no manual reload',
  pressedAfter === pressedBefore + 1,
  `aria-pressed ${pressedBefore} -> ${pressedAfter}`)

// Unpinning must flip it back in place, which is the other half of "no reload".
const unpinButton = buttons().find(b => b.getAttribute('aria-label') === '取消置顶' || b.getAttribute('aria-label') === 'Unpin')
await act(async () => {
  unpinButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await waitFor(() => pressedCount() === pressedBefore)
})
check('clicking unpin flips the row back with no manual reload',
  pressedCount() === pressedBefore, `aria-pressed -> ${pressedCount()}`)
// Pin it again so the persistence check below still has something to find.
await act(async () => {
  target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await waitFor(() => pressedCount() === pressedBefore + 1)
})

// The same click must have reached the Host, not only local state.
const snapAfter = await (await handler.fetch(new Request('http://127.0.0.1:3080/api/llm-manage', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'snapshot' }),
}))).json()
const pinnedOnHost = (snapAfter?.value?.groups?.[0]?.rows ?? []).filter(r => r.pinned).map(r => r.model)
check('the click reached the Host and persisted', pinnedOnHost.length > 0, pinnedOnHost.join(','))

// ── the proficiency ledger reaches the panel ────────────────────────────────
// Two models are seeded with deliberately different shapes: one old and
// well-used, one recent and lightly used. That makes "by proficiency" and "by
// recent use" produce DIFFERENT first rows, so the two orderings can be told
// apart — with a single hot-and-heavy model both modes would agree and a broken
// one would still pass.
const usageEmit = (name, ...args) => { for (const cb of listeners[name] ?? []) cb(...args) }
const usageMessage = (seq, model, time, usage) => ({
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
const UI_DAY = 86400000
const UI_NOW = Date.now()
const VETERAN = at(3)
const RECENT = at(4)
for (let seq = 1; seq <= 12; seq += 1) {
  usageEmit('session/event', { id: 'sess-ui' },
    usageMessage(seq, VETERAN, UI_NOW - 30 * UI_DAY, { inputTokens: 10, outputTokens: 2 }))
}
for (let seq = 20; seq <= 23; seq += 1) {
  usageEmit('session/event', { id: 'sess-ui' },
    usageMessage(seq, RECENT, UI_NOW - 60000, { inputTokens: 10, outputTokens: 2 }))
}

// The panel reads a snapshot on mount, so the refreshed read is what proves the
// counters reached the surface the user actually looks at.
const refreshButton = container.querySelector('.llmm-actions button')
await act(async () => {
  refreshButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await waitFor(() => container.querySelector('.llmm-roster') !== null)
})

const roster = container.querySelector('.llmm-roster')
const heroNames = () => Array.from(container.querySelectorAll('.llmm-hero-name')).map(node => node.textContent)
check('the panel shows a most-used roster once models have been used',
  roster !== null && heroNames().length > 0, heroNames().join(' / '))
check('the roster ranks by recent heat, not by lifetime total',
  heroNames()[0] === RECENT, `${heroNames().join(' / ')} — expected ${RECENT} first`)
check('a roster card shows the proficiency level',
  (container.querySelector('.llmm-hero .llmm-lv')?.textContent ?? '').startsWith('Lv'),
  container.querySelector('.llmm-hero .llmm-lv')?.textContent ?? 'no level chip')
check('a well-used model reaches level 2',
  Array.from(container.querySelectorAll('.llmm-lv')).some(node => node.textContent === 'Lv.2'),
  Array.from(container.querySelectorAll('.llmm-lv')).map(n => n.textContent).join(','))
check('the roster card shows distance to the next level as a bar',
  container.querySelector('.llmm-hero .llmm-bar-fill') !== null
  && /width:\s*\d+%/.test(container.querySelector('.llmm-hero .llmm-bar-fill').getAttribute('style') ?? ''),
  container.querySelector('.llmm-hero .llmm-bar-fill')?.getAttribute('style') ?? 'no bar')
const countsText = container.querySelector('.llmm-counts')?.textContent ?? ''
check('the panel totals the recorded uses',
  /16/.test(countsText) && /uses|次调用/.test(countsText), countsText)

// The sort control: the two modes must disagree, because they answer different
// questions ("what am I best at" vs "what am I reaching for today").
const firstName = () => container.querySelector('.llmm-row .llmm-name')?.textContent ?? ''
// Scoped to the sort toolbar: the density control shares the button vocabulary
// deliberately, so an unscoped query would count its two buttons as orderings.
const sortButtons = () => Array.from(container.querySelectorAll('.llmm-sort-modes .llmm-sortbtn'))
const sortBy = async (index) => {
  await act(async () => {
    sortButtons()[index].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await waitFor(() => sortButtons()[index].getAttribute('aria-pressed') === 'true')
  })
}
check('the panel offers a sort control once usage exists', sortButtons().length === 3,
  sortButtons().map(b => b.textContent).join(' / '))
await sortBy(1)
check('sorting by proficiency puts the highest level first', firstName() === VETERAN,
  `${firstName()} — expected ${VETERAN}`)
await sortBy(2)
check('sorting by recent use puts the hottest model first', firstName() === RECENT,
  `${firstName()} — expected ${RECENT}`)
await sortBy(0)
check('the default sort is still available and re-selectable',
  sortButtons()[0].getAttribute('aria-pressed') === 'true')

// A tooltip must appear on hover, and it must be rendered outside the scrolling
// row list so no ancestor can clip it.
const starButton = buttons().find(b => (b.getAttribute('aria-label') ?? '').includes('收藏') || (b.getAttribute('aria-label') ?? '').includes('Favorite'))
await act(async () => {
  starButton.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
  await waitFor(() => container.querySelector('.llmm-tip') !== null)
})
const tipAfterOver = container.querySelector('.llmm-tip')
check('hovering an icon shows its label as a tooltip', tipAfterOver !== null, tipAfterOver ? tipAfterOver.textContent : 'no tooltip')
check('the tooltip is not inside the scrolling row list',
  tipAfterOver !== null && !container.querySelector('.llmm-rows .llmm-tip'))

// Icon-only means the row does not spend its width on words.
const rowActionText = Array.from(container.querySelectorAll('.llmm-rowacts button')).map(b => (b.textContent ?? '').trim())
check('row action buttons render no visible text', rowActionText.every(entry => entry === ''), JSON.stringify(rowActionText))

// Discoverability: the actions must not be hidden until hover. A touch device has
// no hover, and a user who never hovers would never learn the controls exist.
const css = Array.from(container.querySelectorAll('style')).map(node => node.textContent ?? '').join('')
const rowActsRule = /\.llmm-rowacts\{([^}]*)\}/.exec(css)
check('row actions stay visible without hover',
  rowActsRule !== null && !/opacity:\s*0(?![.\d])/.test(rowActsRule[1]),
  rowActsRule ? rowActsRule[1] : 'no .llmm-rowacts rule')

// The panel must trust the Host's snapshot, not only its own optimistic guess.
//
// This simulates a concurrent mutation — the agent's `llm_models` tool pins and
// favorites too, so two writers on one overlay is a real case. A favorite for
// One model is landed on the Host first, then the panel's own click favorites a
// different one. The optimistic update only knows about its own click, so if the
// panel ignored the authoritative `snapshot` it would show one favorite; the Host
// snapshot has two.
const rowFor = (model) => Array.from(container.querySelectorAll('.llmm-row'))
  .find(row => (row.querySelector('.llmm-name')?.textContent ?? '') === model)
const favoriteButtonFor = (model) => Array.from((rowFor(model) ?? container).querySelectorAll('button'))
  .find(b => /收藏|Favorite/.test(b.getAttribute('aria-label') ?? ''))
const favoriteLabels = () => buttons().filter(b => /收藏|Favorite/.test(b.getAttribute('aria-label') ?? '')).length

const realFetch = globalThis.fetch
// Counted from the DOM, not from the catalogue size: the panel collapses a long
// list behind "show all", so the number of rows on screen is its own fact and
// assuming it equals MODELS.length would fail against a real 80-model route.
const favoritesBefore = favoriteLabels()
let landConcurrent = null
globalThis.fetch = async (url, init) => {
  const payload = typeof init?.body === 'string' ? JSON.parse(init.body) : null
  if (landConcurrent !== null && payload?.action === 'toggle' && payload.list === 'favorites') {
    await handler.fetch(new Request('http://127.0.0.1:3080/api/llm-manage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'toggle', route: ROUTE, model: landConcurrent, list: 'favorites', on: true }),
    }))
  }
  return realFetch(url, init)
}
landConcurrent = at(1)
const favTarget = favoriteButtonFor(at(0))
check('the favorite button for a known row was found', favTarget !== undefined)
await act(async () => {
  favTarget.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  // Settled either way: it reaches the expected count, or it never will and the
  // check below reports the state it is actually stuck in.
  await waitFor(() => favoriteLabels() === favoritesBefore - 2)
})
globalThis.fetch = realFetch
// Two rows are favorited — one by the click, one by the concurrent writer — so
// exactly two fewer rows still offer "Favorite". Ignoring the snapshot leaves the
// count one higher, because the panel would not know about the other writer.
const expectedFavorites = favoritesBefore - 2
check('the panel adopts the Host snapshot, not just its optimistic guess',
  favoriteLabels() === expectedFavorites,
  `remaining "Favorite" labels=${favoriteLabels()} (expected ${expectedFavorites}; ${expectedFavorites + 1} means the snapshot was ignored)`)

    // ── the order freeze ────────────────────────────────────────────────────────
    // Toggling a pin used to re-sort the list: the sort puts pinned rows first, so
    // the row under the cursor jumped to the top and took the user's scroll
    // position with it — scroll to model 40, pin it, and you are looking somewhere
    // else. The order is now frozen at the first toggle, and released only at the
    // boundaries where the user expects the list to settle. This is that
    // regression, asserted on the order the rows are actually rendered in.
    const shownNames = () => Array.from(container.querySelectorAll('.llmm-row .llmm-name'))
      .map(node => node.textContent)
    const sortPanelBy = (mode) => act(async () => {
      Array.from(container.querySelectorAll('.llmm-sort-modes .llmm-sortbtn'))[mode]
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => true)
    })
    await sortPanelBy(0)
    const orderBefore = shownNames()
    // A row that is not already first: pinning the first row could not reorder
    // anything, so the assertion would pass against the old behaviour too.
    const pinTarget = orderBefore[2]
    const pinButtonFor = (model) => Array.from((rowFor(model) ?? container).querySelectorAll('button'))
      .find(b => /置顶|取消置顶|Pin|Unpin/.test(b.getAttribute('aria-label') ?? ''))
    await act(async () => {
      pinButtonFor(pinTarget).dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => /取消置顶|Unpin/.test(pinButtonFor(pinTarget)?.getAttribute('aria-label') ?? ''))
    })
    check('pinning a row does not move it',
      shownNames().join('|') === orderBefore.join('|'),
      `${pinTarget} at index ${shownNames().indexOf(pinTarget)}, was ${orderBefore.indexOf(pinTarget)}`
      + `; ${shownNames().filter((n, i) => n !== orderBefore[i]).length} row(s) changed place`)
    check('the pin takes effect in place even though the order did not change',
      /取消置顶|Unpin/.test(pinButtonFor(pinTarget)?.getAttribute('aria-label') ?? ''),
      pinButtonFor(pinTarget)?.getAttribute('aria-label') ?? 'no pin button')
    // A frozen order that says nothing reads as a pin that did nothing.
    const hints = () => Array.from(container.querySelectorAll('.llmm-hint')).map(n => n.textContent)
    check('a frozen order says that the sort is pending',
      hints().some(text => /收起|展开|排序|collapse|expand|sort/i.test(text)),
      hints().join(' | ').slice(0, 140))

    // The boundary: collapsing or expanding settles the order, so the pending pin
    // is expected to move then. Asserting that it moved is what proves the freeze
    // is a freeze rather than a broken sort.
    await act(async () => {
      const showAll = Array.from(container.querySelectorAll('.llmm-btn'))
        .find(b => /全部|收起|show all|fewer/i.test(b.textContent ?? ''))
      // A catalogue short enough to fit on one screen has no expand button; the
      // sort control is a boundary too, and it is always present once usage exists.
      const boundary = showAll ?? Array.from(container.querySelectorAll('.llmm-sort-modes .llmm-sortbtn'))[0]
      boundary.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => true)
    })
    check('a boundary (expand or sort) applies the pending order',
      shownNames().indexOf(pinTarget) < orderBefore.indexOf(pinTarget),
      `${pinTarget} at index ${shownNames().indexOf(pinTarget)}, was ${orderBefore.indexOf(pinTarget)}`
      + ` — a pin that never reorders anything would leave it where it was`)
    check('after the boundary the frozen order is current again',
      !hints().some(text => /收起|展开|排序|collapse|expand|sort/i.test(text)),
      hints().join(' | ').slice(0, 140))

    // ── the row's detail block ──────────────────────────────────────────────────
    // The row carries what a decision needs and nothing else; everything else the
    // Host knows lives here. A hover tooltip was the alternative and it is the
    // weaker one — it needs a pointer, cannot be read on a touch screen, and
    // cannot be held open beside a second row to compare.
    // The detail block is the row's next sibling: a Fragment adds no DOM node, so
    // adjacency is itself part of the contract — the block belongs to this row.
    const detailOf = (model) => {
      const next = rowFor(model)?.nextElementSibling ?? null
      return next !== null && next.classList.contains('llmm-detail') ? next : null
    }
    const chevronFor = (model) => (rowFor(model) ?? container).querySelector('.llmm-chevron')
    check('no detail block is open before anything is expanded', detailOf(pinTarget) === null)
    check('every row offers a labelled disclosure control',
      chevronFor(pinTarget) !== null
      && /details|展开|收起/i.test(chevronFor(pinTarget).getAttribute('aria-label') ?? ''),
      chevronFor(pinTarget)?.getAttribute('aria-label') ?? 'no chevron')
    await act(async () => {
      chevronFor(pinTarget).dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => detailOf(pinTarget) !== null)
    })
    const detail = detailOf(pinTarget)
    check('the chevron opens a detail block under its own row',
      detail !== null && detail.querySelector('.llmm-detail-summary') !== null
        && detail.querySelectorAll('.llmm-detail-line').length >= 1,
      `${detail?.querySelectorAll('.llmm-detail-line').length ?? 0} line(s)`)
    check('the disclosure reports its state',
      chevronFor(pinTarget).getAttribute('aria-expanded') === 'true',
      chevronFor(pinTarget).getAttribute('aria-expanded') ?? 'unset')
    check('the detail block shows the facts the row has no room for',
      Array.from(detail?.querySelectorAll('.llmm-detail-line-label') ?? []).length >= 1,
      Array.from(detail?.querySelectorAll('.llmm-detail-line-label') ?? []).map(n => n.textContent).join(', ').slice(0, 140))

    // A row that carries usage is the interesting case: the numbers exist, the row
    // has no room for them, and the detail block is where they have to appear.
    // A profile line: label on the left, value on the right. The block used to be a
    // fifteen-row form; these assertions follow the shape it has now.
    const detailField = (node, labelPattern) => Array.from(node?.querySelectorAll('.llmm-detail-line') ?? [])
      .find(line => labelPattern.test(line.querySelector('.llmm-detail-line-label')?.textContent ?? ''))
    const usedName = shownNames().find(name => rowFor(name)?.querySelector('.llmm-lv') !== null)
    if (usedName !== undefined && detailOf(usedName) === null) {
      await act(async () => {
        chevronFor(usedName).dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await waitFor(() => detailOf(usedName) !== null)
      })
    }
    const usedDetail = usedName === undefined ? null : detailOf(usedName)
    const usedText = usedDetail?.textContent ?? ''
    check('a used row\'s detail block carries the usage numbers',
  usedDetail !== null && /uses|次调用/i.test(usedText) && /tokens/i.test(usedText),
      usedName === undefined ? 'no used row on screen' : usedText.slice(0, 160))
    // The reason must be the same string in both places, and it must lead the
    // compact row — trailing `source · age` is what let the ellipsis eat it. Read
    // from the detail block rather than from a fixture, so this holds whatever
    // reason the Host actually reports.
    // The reason now lives in the summary line, not in a labelled row: the block is
    // a profile, so it answers in a sentence rather than in fields.
    const summaryText = usedDetail?.querySelector('.llmm-detail-summary-text')?.textContent ?? ''
    const rowWhy = (rowFor(usedName)?.querySelector('.llmm-why')?.textContent ?? '').trim()
    check('the compact summary leads with how to read the row (skipped when there is no reason)',
      summaryText !== '' && (rowWhy === '' || summaryText.startsWith(rowWhy)),
      `summary="${summaryText.slice(0, 48)}" why="${rowWhy.slice(0, 48)}"`)
    if (usedName !== undefined) {
      await act(async () => {
        chevronFor(usedName).dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await waitFor(() => detailOf(usedName) === null)
      })
    }
    // The name is the pointer target for the same disclosure.
    await act(async () => {
      rowFor(pinTarget).querySelector('.llmm-name')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => detailOf(pinTarget) === null)
    })
    check('clicking the model name closes the detail block again', detailOf(pinTarget) === null)

    // ── row density ─────────────────────────────────────────────────────────────
    const rowsEl = () => container.querySelector('.llmm-rows')
    const densityButtons = () => Array.from(container.querySelectorAll('.llmm-density .llmm-sortbtn'))
    check('the density control offers both densities', densityButtons().length === 2,
      densityButtons().map(b => b.textContent).join(' / '))
    check('the default density is compact',
      rowsEl().className.includes('llmm-compact')
      && container.querySelectorAll('.llmm-why-line').length === 0,
      rowsEl().className)
    // The reason leads. It used to trail `source · age`, so the ellipsis ate
    // exactly the part worth reading and kept the part the status dot already says.
    const whyText = rowFor(pinTarget)?.querySelector('.llmm-why')?.textContent ?? ''
    check('compact density leads with the reason rather than the source label',
      whyText.length > 0 && !/^(deep probe|passive|gateway directory|none) ·/.test(whyText),
      whyText.slice(0, 90))
    await act(async () => {
      densityButtons()[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => rowsEl().className.includes('llmm-comfortable'))
    })
    check('switching to comfortable gives the reason its own line',
      rowsEl().className.includes('llmm-comfortable')
      && container.querySelectorAll('.llmm-why-line').length > 0,
      `${container.querySelectorAll('.llmm-why-line').length} second line(s)`)
    check('the chosen density is remembered',
      window.localStorage.getItem('llm-manage:density') === 'comfortable',
      String(window.localStorage.getItem('llm-manage:density')))
    await act(async () => {
      densityButtons()[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => rowsEl().className.includes('llmm-compact'))
    })
    // Put the overlay back. These assertions pinned a row that was sitting in the
    // Favorites section, and the picker assertions below lift pinned rows out of
    // Favorites — so leaving it pinned would change their fixture, not test it.
    await act(async () => {
      pinButtonFor(pinTarget).dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => /^(置顶|Pin)$/.test(pinButtonFor(pinTarget)?.getAttribute('aria-label') ?? ''))
    })
    check('the pin used by this block was undone, leaving the overlay as it was',
      /^(置顶|Pin)$/.test(pinButtonFor(pinTarget)?.getAttribute('aria-label') ?? ''),
      pinButtonFor(pinTarget)?.getAttribute('aria-label') ?? 'no pin button')

    // ── the composer model picker ───────────────────────────────────────────────
// This seat had no coverage at all, which is how its panel copy came to promise
// that pins and favorites "sort to the top" while the picker rendered the Host's
// groups verbatim. The Host ranks only WITHIN a route group and orders groups by
// route name, so with several routes a favorite can sit below every model of
// every alphabetically-earlier route — the exact scrolling the sections remove.
const pickerSlot = slots.find(s => s.options.id === 'llm-manage-picker')
check('the client half shadowed the composer model picker', pickerSlot !== undefined)

const hostCall = (body) => handler.fetch(new Request('http://127.0.0.1:3080/api/llm-manage', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}))

// Arrange the overlay instead of relying on whatever a real profile happens to
// hold: a test that depends on the user's own pins passes for the wrong reason
// on one machine and cannot run at all on another. The store under DSH_HOME is
// fresh here, and the panel block above pinned one model, so these two models
// are known to start with no flags.
const pinnedModel = at(1)
const favoredModel = at(2)
const mirroredPin = MIRRORED[0]
for (const [model, route, list] of [
  [pinnedModel, ROUTE, 'pins'],
  [favoredModel, ROUTE, 'favorites'],
  [mirroredPin, SECOND_ROUTE, 'pins'],
]) {
  const arranged = await hostCall({ action: 'toggle', route, model, list, on: true })
  if (arranged.ok !== true) throw new Error(`could not arrange ${list} for ${route}/${model}`)
}

const pickerContainer = window.document.createElement('div')
window.document.body.appendChild(pickerContainer)
const pickerRoot = createRoot(pickerContainer)

// The card is PORTALLED to <body>, so it is deliberately NOT inside
// pickerContainer. Queries must follow the card to where it really renders:
// scoping them to pickerContainer is what made the first run after the portal
// fail with "0 route labels", and a suite that looked only at pickerContainer
// could never have caught the sidebar painting over the card either. The trigger
// stays in pickerContainer, because only the card leaves the composer subtree.
const pickerMenu = () => window.document.body.querySelector('.llmm-menu')
const pickerMenuQuery = (selector) => pickerMenu()?.querySelector(selector) ?? null
const pickerMenuQueryAll = (selector) => Array.from(pickerMenu()?.querySelectorAll(selector) ?? [])
// Guarded on purpose: an undeclared service makes the inject face throw, and an
// unguarded throw here would abort the run instead of failing one check — hiding
// every assertion after it. That is exactly how the live regression escaped notice.
let pickerInjected = null
let pickerInjectError = ''
try {
  pickerInjected = pickerSlot.options.inject('sess-picker')
} catch (error) {
  pickerInjectError = String(error?.message ?? error)
}
check('the picker\'s inject face resolves against the declared services',
  pickerInjectError === '', pickerInjectError || 'resolved')
if (pickerInjectError !== '') {
  // Render it anyway with a stand-in face, so the section assertions below still
  // produce meaningful failures rather than a cascade of null dereferences.
  pickerInjected = {
    available: true, directory: dirStore, load: () => {}, select: () => Promise.resolve(undefined),
  }
}
await act(async () => {
  pickerRoot.render(React.createElement(pickerSlot.Component, pickerInjected))
})
await act(async () => {
  const trigger = pickerContainer.querySelector('.llmm-trigger')
  if (trigger === null) throw new Error('the picker rendered no trigger')
  trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await waitFor(() => pickerMenuQuery('.llmm-menu-body') !== null)
})

// The card must live on <body>, not nested in the composer row that hosts the
// trigger. The composer row declares `container-type: inline-size` (metrics
// containment), which makes it the containing block for `position: fixed`
// descendants; in-tree, the card is therefore confined to the composer's
// stacking context and the right sidebar column paints over it, and a measured
// z-index of 2147483647 still lost. Nothing about the card's own CSS can fix
// that, so the ancestry IS the fix and this is the check that holds it.
check('the picker card is portalled out of the composer, to <body>',
  pickerMenu() !== null
  && pickerMenu().parentElement === window.document.body
  && pickerContainer.querySelector('.llmm-menu') === null,
  pickerMenu() === null
    ? 'no card rendered'
    : `parent=<${pickerMenu().parentElement?.tagName.toLowerCase()}> inComposer=${pickerContainer.querySelector('.llmm-menu') !== null}`)

// A fixed, portalled card is positioned from the viewport, so the placement maths
// must clamp against the VIEWPORT and not against any column: a clamp that used
// the trigger's offsetParent would strand the card off-screen once it is portalled.
const cardStyle = pickerMenu() === null ? null : pickerMenu().style
check('the portalled card is placed in viewport coordinates',
  cardStyle !== null
  && cardStyle.position !== 'absolute'
  && (cardStyle.left !== '' || cardStyle.right !== '')
  && (cardStyle.top !== '' || cardStyle.bottom !== ''),
  cardStyle === null ? 'no card rendered' : `position=${cardStyle.position} left=${cardStyle.left} top=${cardStyle.top} bottom=${cardStyle.bottom}`)

/** The menu's sections, in render order, with each section's row labels. */
const pickerSections = () => {
  const body = pickerMenuQuery('.llmm-menu-body')
  if (body === null) return []
  return Array.from(body.children).map(section => ({
    title: (section.querySelector('.llmm-group')?.textContent ?? '').trim(),
    items: Array.from(section.querySelectorAll('.llmm-item')).map(item => ({
      name: item.querySelector('.llmm-name').textContent,
      route: item.querySelector('.llmm-route')?.textContent ?? '',
    })),
  }))
}
const sectionNamed = (pattern) => pickerSections().findIndex(s => pattern.test(s.title.split(' (')[0]))

let open = pickerSections()
const pinnedAt = sectionNamed(/^(Pinned|置顶)$/)
const favoritesAt = sectionNamed(/^(Favorites|收藏)$/)
check('the picker leads with a Pinned section', pinnedAt === 0, open.map(s => s.title).join(' | ').slice(0, 90))
check('the picker leads with a Favorites section right after', favoritesAt === 1, `at ${favoritesAt}`)
check('the Pinned section holds the pinned model',
  pinnedAt >= 0 && open[pinnedAt].items.some(row => row.name === pinnedModel), `${pinnedModel}`)
check('the Favorites section holds the favorited model',
  favoritesAt >= 0 && open[favoritesAt].items.some(row => row.name === favoredModel), `${favoredModel}`)

// The 「常用」 section is earned by use rather than declared by hand, so it sits
// after the user's explicit choices and shows the most-used model first. It is
// capped, because it is a shortcut to the top of the list rather than a second
// copy of the catalogue.
const frequentAt = sectionNamed(/^(Most used|常用)$/)
check('the picker lifts frequently used models into their own section',
  frequentAt > favoritesAt, `at ${frequentAt} of ${open.length} — ${open.map(s => s.title.split(' (')[0]).join(' | ')}`)
check('the frequently-used section leads with the hottest model',
  frequentAt >= 0 && open[frequentAt].items[0]?.name === RECENT,
  open[frequentAt]?.items.map(r => r.name).join(' / ') ?? 'no section')
check('the frequently-used section is capped at five rows',
  frequentAt >= 0 && open[frequentAt].items.length <= 5,
  `${open[frequentAt]?.items.length ?? 0} row(s)`)
check('a used model carries its proficiency level in the picker',
  open.some(section => section.items.some(row => row.name === VETERAN))
  && Array.from(pickerMenu().querySelectorAll('.llmm-item')).some(item =>
    item.querySelector('.llmm-name')?.textContent === VETERAN
    && (item.querySelector('.llmm-lv')?.textContent ?? '').startsWith('Lv')),
  Array.from(pickerMenu().querySelectorAll('.llmm-item')).map(i => `${i.querySelector('.llmm-name')?.textContent}:${i.querySelector('.llmm-lv')?.textContent ?? '-'}`).slice(0, 5).join(' '))
check('an untouched model carries no proficiency chip',
  Array.from(pickerMenu().querySelectorAll('.llmm-item')).filter(item => item.querySelector('.llmm-lv') === null).length > 0,
  'every row is chipped, so the chip says nothing')

// ── the picker's trend column ───────────────────────────────────────────────
// The arrow alone cannot be told apart from one extra request, so the trailing
// count is the part that carries the meaning. A model idle for a month must show
// nothing rather than a flat arrow: there is no recent use to report.
const pickerItem = (name) => Array.from(pickerMenu().querySelectorAll('.llmm-item'))
  .find(item => item.querySelector('.llmm-name')?.textContent === name)
const trendText = (name) => pickerItem(name)?.querySelector('.llmm-trend')?.textContent ?? ''
check('a recently used model shows its 7-day count beside the trend arrow',
  trendText(RECENT) === '↑4', `rendered "${trendText(RECENT)}"`)
check('a model idle for a month shows no trend rather than a flat arrow',
  trendText(VETERAN) === '', `rendered "${trendText(VETERAN)}"`)

// ── the lifted section carries the distance-to-next-level bar ───────────────
const liftedSection = () => {
  const body = pickerMenuQuery('.llmm-menu-body')
  if (body === null) return null
  return Array.from(body.children).find(
    section => /^(Most used|常用)$/.test((section.querySelector('.llmm-group')?.textContent ?? '').split(' (')[0]),
  ) ?? null
}
check('the lifted section shows distance to the next level as a bar',
  (liftedSection()?.querySelector('.llmm-item-bar-fill')?.getAttribute('style') ?? '').includes('width:'),
  liftedSection()?.querySelector('.llmm-item-bar-fill')?.getAttribute('style') ?? 'no bar in the lifted section')
const barInRouteGroups = Array.from(pickerMenuQuery('.llmm-menu-body')?.children ?? [])
  .filter(section => !/^(Most used|常用)$/.test((section.querySelector('.llmm-group')?.textContent ?? '').split(' (')[0]))
  .filter(section => section.querySelector('.llmm-item-bar') !== null)
check('a route group does not carry the bar', barInRouteGroups.length === 0,
  barInRouteGroups.length === 0
    ? `${Array.from(pickerMenuQuery('.llmm-menu-body')?.children ?? []).length} section(s) checked`
    : `the bar leaked into ${barInRouteGroups.length} route group(s)`)

// ── the picker's own sort control ───────────────────────────────────────────
// It answers the same two questions the panel's does, and the two orderings must
// DISAGREE: VETERAN has more uses but RECENT has more heat, so a control wired to
// the wrong field, or to nothing at all, cannot pass both.
const pickerSortButtons = () => Array.from(
  pickerMenuQuery('.llmm-menu-foot')?.querySelectorAll('.llmm-sortbtn') ?? [],
)
check('the picker offers a sort control once models have been used',
  pickerSortButtons().length === 3, `${pickerSortButtons().length} button(s)`)
const liftedNames = () => Array.from(liftedSection()?.querySelectorAll('.llmm-name') ?? [])
  .map(node => node.textContent)
check('by default the lifted section follows recent heat',
  liftedNames()[0] === RECENT, liftedNames().join(' / '))
const pickerSortBy = async (index) => {
  await act(async () => {
    pickerSortButtons()[index].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await waitFor(() => pickerSortButtons()[index].getAttribute('aria-pressed') === 'true')
  })
}
await pickerSortBy(1)
check('sorting the picker by proficiency puts the higher level first',
  liftedNames()[0] === VETERAN, liftedNames().join(' / '))
await pickerSortBy(2)
check('sorting the picker by recent use puts the hotter model first',
  liftedNames()[0] === RECENT, liftedNames().join(' / '))
await pickerSortBy(0)
check('returning the picker to its default order restores the designed ranking',
  liftedNames()[0] === RECENT, liftedNames().join(' / '))

// The regression that matters most: lifting rows into sections must not list them
// twice. A model in both lists is offered under Pinned only, because a pin
// outranks a favorite in the Host's own ranking.
const counts = new Map()
for (const section of open) for (const row of section.items) {
  const key = `${row.route}/${row.name}`
  counts.set(key, (counts.get(key) ?? 0) + 1)
}
const duplicated = [...counts.entries()].filter(([, n]) => n > 1)
check('no model is offered twice, across every section', duplicated.length === 0,
  duplicated.map(([key, n]) => `${key}×${n}`).join(', ') || 'each row appears once')

// Lifting must not lose anything either: every row the Host lists as visible is
// still offered. Counted against the Host's own snapshot so that this holds in
// both modes, at any catalogue size.
const snapshot = (await (await hostCall({ action: 'snapshot' })).json()).value
// Model-first: the menu offers one row per MODEL, so the count to match is the
// number of distinct visible model ids — not the number of route rows, which is
// larger exactly when two routes serve one model (this fixture does, twice).
const expectedRows = Array.isArray(snapshot.models)
  ? snapshot.models.filter(entry => entry.hidden !== true).length
  : new Set(snapshot.groups.flatMap(group => group.rows.filter(row => !row.hidden).map(row => row.model))).size
check('every listed model is still offered exactly once',
  [...counts.values()].reduce((a, b) => a + b, 0) === expectedRows,
  `${[...counts.values()].reduce((a, b) => a + b, 0)} rows for ${expectedRows} listed`)

// A section whose rows span routes has to name them: the same model id on two
// routes is two different selections, and the lifted row is no longer under its
// route's heading to say which one it is. A section that stays on one route must
// NOT name routes, or the label is noise on every row.
const pinnedSection = pinnedAt >= 0 ? open[pinnedAt] : { items: [] }
// The chip now names the OTHER route instead of repeating the row's own: the row is
// the model, and its section heading already names the family it belongs to.
const mirrorRow = pinnedSection.items.find(row => row.name === mirroredPin)
check('a lifted row reachable on another route names that route',
  mirrorRow !== undefined && mirrorRow.route !== '', JSON.stringify(mirrorRow ?? null))
const favoriteSection = favoritesAt >= 0 ? open[favoritesAt] : { items: [] }
check('a lifted section on one route names none',
  favoriteSection.items.length > 0 && favoriteSection.items.every(row => row.route === ''),
  favoriteSection.items.map(row => `${row.name}${row.route === '' ? '' : `[${row.route}]`}`).join(', '))

// The status dot is the only at-a-glance "can I use this" signal, and it had no
// assertion at all: a key mismatch between the row and the overlay map turned every
// dot grey while the rest of this suite stayed green. The status is produced by a
// probe rather than assumed from the fixture, so this tests the wiring and not luck.
{
  const DOTTED = at(4)
  // Both helpers below are declared further down this file, so this block resolves
  // its own row rather than reaching forward into a TDZ.
  const dottedRow = () => Array.from(pickerMenu()?.querySelectorAll('.llmm-item') ?? [])
    .find(item => item.querySelector('.llmm-name')?.textContent === DOTTED) ?? null
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => (String(url).includes('/chat/completions')
    ? syntheticGatewayFetch(url, init)
    : realFetch(url, init))
  try {
    await hostCall({ action: 'probe', route: ROUTE, model: DOTTED })
  } finally {
    globalThis.fetch = realFetch
  }
  await act(async () => { pickerRoot.render(null) })
  await act(async () => { pickerRoot.render(React.createElement(pickerSlot.Component, pickerInjected)) })
  // `ensureOpen` is defined further down, so open it here instead of hoisting into TDZ.
  if (pickerMenu() === null) {
    await act(async () => {
      pickerContainer.querySelector('.llmm-trigger')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => pickerMenuQuery('.llmm-menu-body') !== null)
    })
  }
  await act(async () => {
    const input = pickerMenuQuery('.llmm-input')
    if (input !== null) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    }
    await waitFor(() => dottedRow() !== null)
  })
  const dotClass = dottedRow()?.querySelector('.llmm-dot')?.className ?? ''
  check('a usable row paints its health tone, not the idle one',
    /llmm-dot ok/.test(dotClass), dotClass || 'no dot')
}

// ── the picker manages models, not just lists them ──────────────────────────
// Pin, favorite, hide and probe used to be reachable only from the settings
// page, so the moment you noticed a model was unusable — while choosing one —
// was the moment you had to leave the conversation to act on it.
const pickerRowFor = (name) => Array.from(pickerMenu().querySelectorAll('.llmm-item'))
  .find(item => item.querySelector('.llmm-name')?.textContent === name)
const chevronOf = (name) => pickerRowFor(name)?.querySelector('.llmm-chevron') ?? null
const pickerDetailOf = (name) => {
  const next = pickerRowFor(name)?.nextElementSibling ?? null
  return next !== null && next.classList.contains('llmm-detail') ? next : null
}
// A name that appears exactly once: the same model id is served by two routes in
// this fixture, so a target visible twice could not tell "the row moved" from "the
// other route's copy is still there". Which section it sits in does not matter —
// every row carries the same disclosure, and by the time this runs the earlier
// assertions have pinned, favourited and selected enough models that demanding an
// untouched name is a demand on their leftovers rather than on the picker.
const nameCounts = new Map()
for (const section of pickerSections()) {
  for (const item of section.items) nameCounts.set(item.name, (nameCounts.get(item.name) ?? 0) + 1)
}
const manageTarget = [...nameCounts.keys()].find(name => nameCounts.get(name) === 1)
check('every picker row offers a labelled disclosure', chevronOf(manageTarget) !== null
  && /details|展开|收起/i.test(chevronOf(manageTarget).getAttribute('aria-label') ?? ''),
  chevronOf(manageTarget)?.getAttribute('aria-label') ?? 'no chevron on the first row')

// A button cannot contain buttons, so the row had to stop being one. These are
// the two halves of that split: the selection control selects, the row does not.
const pickerSelections = selections.length
await act(async () => {
  pickerRowFor(manageTarget).dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await waitFor(() => true)
})
check('clicking the row itself does not select — only the selection control does',
  selections.length === pickerSelections,
  `${selections.length - pickerSelections} selection(s) from a row click`)

await act(async () => {
  chevronOf(manageTarget).dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await waitFor(() => pickerDetailOf(manageTarget) !== null)
})
const block = pickerDetailOf(manageTarget)
check('the disclosure opens the row management block',
  block !== null && block.querySelectorAll('.llmm-ibtn').length === 4,
  `${block?.querySelectorAll('.llmm-ibtn').length ?? 0} action(s)`)
// Icon-only on purpose: four labels of different lengths could not line up, and the
// label a text button spelled out is what the hover tooltip now carries. What must
// not be lost is the accessible name — an icon with no aria-label is unreadable.
check('the actions are icon-only with an accessible label',
  Array.from(block?.querySelectorAll('.llmm-ibtn') ?? []).every(button => (button.textContent ?? '').trim() === ''
    && (button.getAttribute('aria-label') ?? '').trim().length > 0),
  Array.from(block?.querySelectorAll('.llmm-ibtn') ?? [])
    .map(b => `${(b.getAttribute('aria-label') ?? '?')}[${(b.textContent ?? '').trim()}]`).join(' / '))

// The label the icon cannot spell appears on hover, which is the whole point of
// going icon-only: the action row stays narrow without becoming a guessing game.
const hoverAction = block?.querySelectorAll('.llmm-ibtn')[0] ?? null
// Clear any tooltip another surface left behind, then hover with `mouseover`:
// React synthesises `onMouseEnter` from it, so a raw `mouseenter` never fires.
for (const stale of Array.from(window.document.querySelectorAll('.llmm-tip'))) stale.remove()
await act(async () => {
  hoverAction?.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
  await waitFor(() => window.document.querySelector('.llmm-tip') !== null)
})
const hoverTip = window.document.querySelector('.llmm-tip')
check('hovering an action reveals the label it cannot spell',
  hoverTip !== null && (hoverTip.textContent ?? '') === (hoverAction?.getAttribute('aria-label') ?? null),
  `${hoverTip?.textContent ?? 'no tooltip'} vs ${hoverAction?.getAttribute('aria-label') ?? 'none'}`)
await act(async () => {
  hoverAction?.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true }))
})
// The block reuses the panel's own record component, so the two surfaces cannot
// describe the same model differently.
check('the block carries the same record the panel shows',
  (block?.querySelectorAll('.llmm-detail-line').length ?? 0) >= 1,
  Array.from(block?.querySelectorAll('.llmm-detail-line-label') ?? []).map(n => n.textContent).join(', ').slice(0, 140))
const disclosureState = chevronOf(manageTarget).getAttribute('aria-expanded')
check('the disclosure reports its state', disclosureState === 'true', disclosureState ?? 'unset')

// Pinning from the menu must not move the row between sections — the same jump
// the panel had, but worse here, because a pin lifts the row out of its route
// group entirely. The order is frozen at the first toggle and settled when the
// menu is next opened.
//
// This needs a row that is not pinned yet: un-pinning a lifted row really does
// relocate it, so exercising the assertion on one would be testing the fixture's
// leftovers. When earlier assertions have pinned every unique name there is
// nothing left to pin, and saying so beats failing.
const pinnedSectionNames = new Set(pickerSections()
  .filter(section => /^(Pinned|置顶)/.test(section.title))
  .flatMap(section => section.items.map(row => row.name)))
const pickerPinTarget = [...nameCounts.keys()].find(name => !pinnedSectionNames.has(name))
if (pickerPinTarget === undefined) {
  check('pinning from the picker does not move the row between sections', true,
    `every unique name was already pinned (${[...pinnedSectionNames].join(', ')})`)
} else {
  if (pickerDetailOf(pickerPinTarget) === null) {
    await act(async () => {
      chevronOf(pickerPinTarget).dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => pickerDetailOf(pickerPinTarget) !== null)
    })
  }
  const pinBlock = pickerDetailOf(pickerPinTarget)
  const beforePin = pickerSections().map(section => `${section.title}:${section.items.map(r => r.name).join(',')}`)
  const pinAction = Array.from(pinBlock.querySelectorAll('.llmm-ibtn'))
    .find(button => /置顶|取消置顶|Pin|Unpin/.test(button.getAttribute('aria-label') ?? ''))
  // The state lives in aria-pressed now that the label is a tooltip: reading the text
  // would always succeed and would never prove the click landed.
  const pinPressed = () => pinAction.getAttribute('aria-pressed') === 'true'
  const wasPinned = pinPressed()
  await act(async () => {
    pinAction.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await waitFor(() => pinPressed() !== wasPinned)
  })
  const afterPin = pickerSections().map(section => `${section.title}:${section.items.map(r => r.name).join(',')}`)
  check('pinning from the picker does not move the row between sections',
    afterPin.join('|') === beforePin.join('|'),
    `${pickerPinTarget} was in ${beforePin.find(s => s.includes(pickerPinTarget))?.split(':')[0]}`
    + `, now ${afterPin.find(s => s.includes(pickerPinTarget))?.split(':')[0]}`)
  check('the pin takes effect in place, from the Host own answer',
    pinPressed() !== wasPinned,
    `${pinAction.getAttribute('aria-label') ?? 'no pin action'} pressed=${pinPressed()}`)
  // Put it back: the pinned set is a fixture for the sections asserted above.
  await act(async () => {
    pinAction.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await waitFor(() => pinPressed() === wasPinned)
  })
}

// Hiding must not be a one-way door: the row leaves the menu, and a section at
// the bottom offers it back.
const hideAction = Array.from(block.querySelectorAll('.llmm-ibtn'))
  .find(button => /隐藏|Hide/.test(button.getAttribute('aria-label') ?? ''))
await act(async () => {
  hideAction.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await waitFor(() => pickerSections().some(section => /^(Hidden|已隐藏)/.test(section.title)))
})
const hiddenAt = pickerSections().findIndex(section => /^(Hidden|已隐藏)/.test(section.title))
check('hiding from the picker moves the row into a Hidden section rather than losing it',
  hiddenAt >= 0
  && pickerSections()[hiddenAt].items.some(row => row.name === manageTarget),
  hiddenAt < 0 ? 'no Hidden section' : pickerSections()[hiddenAt].items.map(r => r.name).join(', '))
const occurrences = pickerSections().flatMap((section, index) =>
  section.items.filter(row => row.name === manageTarget).map(() => index))
check('a hidden row is no longer offered as a selectable route row',
  hiddenAt >= 0 && occurrences.length === 1 && occurrences[0] === hiddenAt,
  `appears in section(s) ${occurrences.join(', ') || 'nowhere'}; Hidden is at ${hiddenAt}`)
// And it can be brought back from the same block.
// The row kept its block open through the hide, and the disclosure toggles, so
// opening it must be conditional — clicking an open chevron closes it.
if (pickerDetailOf(manageTarget) === null) {
  await act(async () => {
    pickerRowFor(manageTarget).querySelector('.llmm-chevron')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await waitFor(() => pickerDetailOf(manageTarget) !== null)
  })
}
const unhideButton = Array.from(pickerDetailOf(manageTarget)?.querySelectorAll('.llmm-ibtn') ?? [])
  .find(button => /取消隐藏|Unhide/.test(button.getAttribute('aria-label') ?? ''))
check('the Hidden section offers the way back',
  unhideButton !== undefined, unhideButton?.getAttribute('aria-label') ?? 'no unhide action')
if (unhideButton !== undefined) {
  await act(async () => {
    unhideButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await waitFor(() => !pickerSections().some(section => /^(Hidden|已隐藏)/.test(section.title)))
  })
}
check('a hidden row can be unhidden from the menu that hid it',
  !pickerSections().some(section => /^(Hidden|已隐藏)/.test(section.title)),
  pickerSections().map(s => s.title).join(' | ').slice(0, 120))

// ── the switch banner reports what was proven ───────────────────────────────
// The banner used to state a cause it had not verified ("exhausted quota") and
// inline the provider's raw error, which can be 400 characters. Both are fixed,
// and both are asserted here rather than described in a comment.
{
  const dock = slots.find(s => s.options.id === 'llm-manage-fallback')
  check('the client half still registers the switch banner', dock !== undefined)

  const bannerFetch = globalThis.fetch
  let verdict = null
  globalThis.fetch = async (url, init) => {
    const payload = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    if (payload?.action === 'fallbackLog') {
      return new Response(JSON.stringify({ ok: true, value: verdict, autoSwitch: verdict?.autoSwitch !== false }),
        { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return bannerFetch(url, init)
  }
  // A fresh mount per case: the banner polls the log on mount and its effect is
  // keyed by session, so re-rendering the same root would keep showing the first
  // answer instead of re-reading.
  let bannerHost = null
  let bannerRoot = null
  // The dock hands the banner the same input actions the composer uses; the
  // continuation path must go through them rather than through a Host call, so
  // the draft the user sees is the draft the editor holds.
  const drafts = []
  let persisted = 0
  const inputActions = {
    setDraft: (text) => { drafts.push(text) },
    persistDraft: () => { persisted += 1 },
  }
  const bannerText = () => bannerHost?.textContent ?? ''
  const renderBanner = async (next) => {
    verdict = next
    if (bannerRoot !== null) {
      await act(async () => { bannerRoot.unmount() })
      bannerHost.remove()
    }
    bannerHost = window.document.createElement('div')
    window.document.body.appendChild(bannerHost)
    bannerRoot = createRoot(bannerHost)
    await act(async () => {
      bannerRoot.render(React.createElement(dock.Component, { sessionId: 'sess-banner', inputActions }))
      await new Promise(resolve => setTimeout(resolve, 40))
    })
  }
  const rawDetail = `no adapter registered for provider "${ROUTE}"`
  await renderBanner({
    at: Date.now(), from: { route: ROUTE, model: at(0) },
    to: { route: SECOND_ROUTE, model: at(1) }, reason: 'no_adapter', detail: rawDetail,
    outcome: 'unreached', ran: null, sessionSwitched: false,
  })
  check('the banner names the actual cause instead of always claiming quota',
    /没有可用的适配器|no adapter|route has no adapter/i.test(bannerText())
    && !/额度已用尽|exhausted quota/i.test(bannerText()),
    bannerText().slice(0, 120))
  check('the raw provider text is not inlined in full',
    !bannerText().includes(rawDetail),
    bannerText().includes(rawDetail) ? 'the whole 400-character message is rendered' : 'detail kept out of the text')
  // It is still available, on hover, rather than dropped.
  const why = bannerHost.querySelector('.llmm-banner-why')
  check('the full provider message stays available on hover',
    why?.getAttribute('title') === rawDetail, why?.getAttribute('title') ?? 'no title')
  check('an unreached switch does not offer to switch back',
    !/改回|Switch back/i.test(bannerText()), bannerText().slice(0, 120))
  check('the banner offers to stop future switches',
    /不再自动切换|Stop switching/i.test(bannerText()), bannerText().slice(0, 120))
  const bannerButtons = () => [...bannerHost.querySelectorAll('.llmm-banner-acts button')]
  const buttonNamed = (pattern) => bannerButtons().find(node => pattern.test(node.textContent ?? ''))
  check('a switch that never landed offers a continuation',
    buttonNamed(/接续|^Continue$/i) !== undefined,
    bannerButtons().map(node => node.textContent).join(' | '))

  await renderBanner({
    at: Date.now(), from: { route: ROUTE, model: at(0) },
    to: { route: SECOND_ROUTE, model: at(1) }, reason: 'quota', detail: 'quota exhausted',
    outcome: 'reached', ran: { route: SECOND_ROUTE, model: at(1) }, sessionSwitched: true,
  })
  // A switch that landed is good news, and good news does not take the width of the
  // conversation: it becomes one quiet line, with undo still reachable from it.
  check('a proven switch reports itself in one quiet line',
    bannerHost.querySelector('.llmm-banner-quiet') !== null
      && /已由|handed over/i.test(bannerText()),
    bannerText().slice(0, 140))
  check('a proven switch does not warn like a failure',
    bannerHost.querySelector('.llmm-banner-acts') === null,
    'the failure banner is still rendered')
  const quietButtons = () => [...bannerHost.querySelectorAll('.llmm-banner-x')]
  check('the quiet line still offers the way back',
    quietButtons().some(node => /改回|Switch back/i.test(node.getAttribute('title') ?? '')),
    quietButtons().map(node => node.getAttribute('title')).join(' | '))
  check('a switch that landed offers no continuation',
    !/接续|^Continue$/i.test(bannerText()),
    bannerText().slice(0, 140))

  await renderBanner({
    at: Date.now(), from: { route: ROUTE, model: at(0) },
    to: { route: SECOND_ROUTE, model: at(1) }, reason: 'quota', detail: 'quota exhausted',
    outcome: 'ran-elsewhere', ran: { route: ROUTE, model: at(0) }, sessionSwitched: false,
  })
  check('a switch that ran elsewhere says which model actually answered',
    /切换未生效|did not take effect/i.test(bannerText())
    && /本轮实际使用|actually ran on/i.test(bannerText()),
    bannerText().slice(0, 140))

  // A repair that queued the continuation is a different outcome from one that only
  // moved the session: the first finishes the work, the second still needs the person.
  await renderBanner({
    at: Date.now(), from: { route: ROUTE, model: at(0) },
    to: { route: SECOND_ROUTE, model: at(1) }, reason: 'quota', detail: 'quota exhausted',
    outcome: 'unreached', ran: null, sessionSwitched: true, continued: true,
  })
  check('a repair that queued the continuation reads as handed over',
    /已由|handed over/i.test(bannerText()), bannerText().slice(0, 140))
  check('a continuation already queued does not offer to queue it again',
    buttonNamed(/接续|^Continue$/i) === undefined,
    bannerButtons().map(node => node.textContent).join(' | '))

  await renderBanner({
    at: Date.now(), from: { route: ROUTE, model: at(0) },
    to: { route: ROUTE, model: at(0) }, reason: 'effort', detail: '',
    outcome: 'unreached', ran: null, sessionSwitched: false, continued: true,
  })
  check('a level repair reads as a level repair, not as a model switch',
    /档位|reasoning level/i.test(bannerText()), bannerText().slice(0, 140))

  await renderBanner({
    at: Date.now(), from: { route: ROUTE, model: at(0) },
    to: { route: SECOND_ROUTE, model: at(1) }, reason: 'quota', detail: 'quota exhausted',
    outcome: 'unreached', ran: null, sessionSwitched: true, continued: false,
    continueRefused: 'a message is already waiting; the new model will answer it',
  })
  check('a refused continuation says the turn did not come back',
    /没接上|did not come back/i.test(bannerText()), bannerText().slice(0, 140))
  check('the refusal reason is kept on hover rather than inlined',
    /already waiting/.test(bannerHost.querySelector('.llmm-banner-why')?.getAttribute('title') ?? ''),
    bannerHost.querySelector('.llmm-banner-why')?.getAttribute('title') ?? 'no title')
  // This is the case the continuation exists for: the run stopped, so offer to pick it
  // back up as a draft the person can edit and send.
  check('a switch that did not come back offers to continue',
    buttonNamed(/接续|^Continue$/i) !== undefined,
    bannerButtons().map(node => node.textContent).join(' | '))
  await act(async () => {
    buttonNamed(/接续|^Continue$/i)?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  check('continuing fills an editable draft instead of sending one',
    drafts.length === 1 && /从中断处|from where the previous answer stopped/i.test(drafts[0]),
    JSON.stringify(drafts))
  check('the filled draft is persisted through the editor',
    persisted === 1, `${persisted} persist(s)`)
  check('the banner says where the continuation went',
    /已填入草稿|Filled into the draft/i.test(bannerText()), bannerText().slice(0, 160))
  check('continuing does not submit on its own',
    drafts.length === 1 && persisted === 1, `drafts=${drafts.length} persists=${persisted}`)

  await act(async () => { bannerRoot.unmount() })
  bannerHost.remove()
  globalThis.fetch = bannerFetch
}

// ── the picker and the panel must stay one design ───────────────────────────
// The stylesheet lives in a template literal, so a single backtick or `${` inside a
// CSS comment truncates it. The module still parses in some of those shapes — the
// pieces re-parse as JS — so `node --check` passes while the browser refuses the
// import and the whole client half never boots. This happened twice while editing
// the menu material. Assert the extracted literal instead of trusting the parser.
{
  const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
  const backtick = String.fromCharCode(96)
  const decl = source.indexOf('const CSS')
  const open = decl === -1 ? -1 : source.indexOf(backtick, decl)
  const close = open === -1 ? -1 : source.indexOf(backtick, open + 1)
  const literal = open === -1 || close === -1 ? '' : source.slice(open + 1, close)
  const opens = literal.split('{').length - 1
  const closes = literal.split('}').length - 1
  const hasBacktick = literal.includes(backtick)
  const hasInterpolation = literal.includes('$' + '{')
  check('the client\'s stylesheet template survives its own comments',
    literal.length > 1000 && !hasBacktick && !hasInterpolation
      && opens === closes && literal.trimEnd().endsWith('}'),
    `${literal.length} chars, braces ${opens}/${closes}, `
      + `backticks=${hasBacktick ? 'yes' : 'no'}, interpolation=${hasInterpolation ? 'yes' : 'no'}`)

  // The same hazard, one file over: a suite payload is a template literal too, so a
  // backtick in a comment INSIDE it truncates the payload and the remaining text
  // re-parses as JavaScript — `node --check` passes and the damage only appears when
  // the browser evaluates the mangled string. That happened twice in verify-live.mjs
  // (a comment mentioning the synthetic click method), each time reporting a failure
  // about the code under test rather than about the comment. The precise tell: after
  // the payload's closing backtick the call must end, so anything but `)` means the
  // literal closed early. Only helpers that take the script as their sole argument
  // are scanned — a general `name(\`` sweep flags legitimate interpolated first
  // arguments such as the Host call helper in client.js, which really is followed by
  // a comma.
  const PAYLOAD_CALLS = ['evaluate', 'evaluateAsync', 'ev']
  const BT = String.fromCharCode(96)
  const truncated = []
  let payloads = 0
  for (const file of ['client.js', 'verify.mjs', 'verify-client.mjs', 'verify-browser.mjs', 'verify-live.mjs', 'screenshot.mjs', 'build-public.mjs', 'scan-company-info.mjs']) {
    let src
    try {
      src = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    } catch {
      continue
    }
    for (const name of PAYLOAD_CALLS) {
      let from = 0
      for (;;) {
        const call = src.indexOf(`${name}(${BT}`, from)
        if (call === -1) break
        const openAt = call + name.length + 1
        const closeAt = src.indexOf(BT, openAt + 1)
        if (closeAt === -1) {
          truncated.push(`${file}: ${name} payload is unterminated`)
          break
        }
        const after = src.slice(closeAt + 1).match(/^\s*(.)/)
        payloads += 1
        if (after !== null && after[1] !== ')') {
          const line = src.slice(0, openAt).split('\n').length
          truncated.push(`${file}:${line}: ${name} payload closed early, followed by "${after[1]}"`)
        }
        from = closeAt + 1
      }
    }
  }
  check('every suite payload template literal closes at its own call',
    payloads > 0 && truncated.length === 0,
    truncated.length === 0 ? `${payloads} payloads across the suites` : truncated.join(' | '))
}
// Declaring a service by name is not enough when a service you call reaches for
// another one internally: Cordis checks the CONSUMER's list, so the caller has to
// declare the transitive keys too. The live app proved the cost of getting this
// wrong — the picker's slot entry crashed and rendered none of its CSS.
check('the client half declares the transitive services it needs',
  clientDeclared.has('remote') && clientDeclared.has('remote.session'),
  `inject = [${[...clientDeclared].join(', ')}]`)
// The picker is the newer surface, and it drifted: a 10px menu radius against the
// panel's 8px, rows padded 5px 8px against 4px 6px, a hover that changed the
// background but not the border, rows dimmed to .6 where the panel dims to .55, and
// a brand-tinted section heading the panel never uses. None of that is visible in a
// functional test, and all of it is visible side by side. So the shared properties
// are asserted equal here rather than left to review.
//
// Read from the rendered <style> element, not from the source: that is the CSS the
// browser actually receives, so a rule that never reaches the page cannot pass.
const cssText = Array.from(container.querySelectorAll('style')).map(node => node.textContent ?? '').join('\n')
/**
 * One rule's declarations, matched by exact selector text.
 *
 * Comment text is stripped from the selector side first. Splitting on `}` leaves the
 * preceding comment attached to the next rule's selector, so a rule that documents
 * itself above would otherwise be invisible to every lookup here — and a missing rule
 * reads as "undefined" rather than as a failure, silently weakening the assertion.
 */
const declarationsOf = (selector) => {
  for (const chunk of cssText.split('}')) {
    const brace = chunk.indexOf('{')
    if (brace === -1) continue
    const head = chunk.slice(0, brace).replace(/\/\*[\s\S]*?\*\//g, '').trim()
    if (head === selector) {
      return Object.fromEntries(chunk.slice(brace + 1).trim().split(';').filter(Boolean).map((entry) => {
        const colon = entry.indexOf(':')
        return [entry.slice(0, colon).trim(), entry.slice(colon + 1).trim()]
      }))
    }
  }
  return null
}
// The picker is a dropdown card, and DSH already has a design language for those:
// ui-primitives Menu.module.css and MenuSurface.module.css, plus the shipped model
// picker this plugin shadows (ui-model-selection ModelSelect.module.css). The panel
// is an inline page surface and follows different metrics on purpose, so comparing
// the two against each other was the wrong reference: it is what let the picker keep
// an 8px card and 12px text while the shipped picker beside it used 16px and 13px.
// These assert the picker against the design system's own numbers instead.
const panelRow = declarationsOf('.llmm-row')
const pickerRow = declarationsOf('.llmm-item')
// The shipped picker's option: box-sizing, 34px minimum, 5px/7px padding, md radius,
// 13/18 text, 6px gap, no border.
const optionContract = {
  'box-sizing': 'border-box', 'min-height': '34px', padding: '5px 7px',
  'border-radius': 'var(--dsw-radius-md)', 'font-size': '13px', 'line-height': '18px',
  gap: '6px', border: '0',
}
const optionMismatch = Object.entries(optionContract)
  .filter(([key, want]) => pickerRow?.[key] !== want)
  .map(([key, want]) => `${key}: want "${want}" got "${pickerRow?.[key]}"`)
check('a picker row uses the shipped model picker\'s own row metrics',
  pickerRow !== null && optionMismatch.length === 0,
  optionMismatch.join('; ') || Object.keys(optionContract).map(k => `${k}=${pickerRow[k]}`).join(' '))
// The card measures like the shipped picker's menu: fixed, 1100, 4px inset, no
// border, lg radius (MenuSurface without `compact`), max-content width.
const menuContract = {
  position: 'fixed', 'z-index': '1100', padding: '4px', border: '0',
  'border-radius': 'var(--dsw-radius-lg)',
}
const menuDecls = declarationsOf('.llmm-menu')
const menuMismatch = Object.entries(menuContract)
  .filter(([key, want]) => menuDecls?.[key] !== want)
  .map(([key, want]) => `${key}: want "${want}" got "${menuDecls?.[key]}"`)
check('a picker card uses the shipped model picker\'s own card metrics',
  menuDecls !== null && menuMismatch.length === 0,
  menuMismatch.join('; ') || Object.keys(menuContract).map(k => `${k}=${menuDecls[k]}`).join(' '))

// The panel is a card on the Models settings page, so it takes that page's card
// material (ui-settings-models ModelsSection.module.css). It previously used
// bg-layer-2 with a 1px border at 8px and 6px radii elsewhere -- shapes that page uses
// nowhere, and a border twice the weight of every neighbour on it.
const panelContract = {
  border: '0.5px solid var(--dsw-alias-settings-card-stroke)',
  background: 'var(--dsw-alias-settings-card-fill)',
  'border-radius': 'var(--dsw-radius-xl)',
  padding: '12px 14px',
}
const panelDecls = declarationsOf('.llmm-panel')
const panelMismatch = Object.entries(panelContract)
  .filter(([key, want]) => panelDecls?.[key] !== want)
  .map(([key, want]) => `${key}: want "${want}" got "${panelDecls?.[key]}"`)
check('the panel card uses the settings page\'s own card material',
  panelDecls !== null && panelMismatch.length === 0,
  panelMismatch.join('; ') || Object.keys(panelContract).map(k => `${k}=${panelDecls[k]}`).join(' '))

// Hairlines are 0.5px throughout the design system, and every 1px border the plugin
// drew read heavier than the surfaces it sat between. Assert no rule re-introduces one.
// Only solid hairlines: the design system draws its dashed "nothing here yet"
// borders at 1px (ModelsSection .modelEmpty), so flagging every 1px border would be
// wrong as well as noisy.
const onePixel = (cssText.match(/border[^;{}]*:\s*1px\s+solid[^;{}]*/g) ?? [])
check('no rule draws a solid 1px hairline where the design system uses 0.5px',
  onePixel.length === 0,
  onePixel.length === 0 ? 'none' : onePixel.join(' | '))

// The model id is an identifier, so it must use the app's configured code face rather
// than a hardcoded platform stack, which ignored whatever the app sets.
check('model ids use the app\'s code font, not a hardcoded stack',
  (declarationsOf('.llmm-name')?.['font-family'] ?? '') === 'var(--ds-font-family-code)'
  // The banner's model ids moved into a <code> once the bold run became the
  // title; the code face follows the identifiers, not the emphasis.
  && (declarationsOf('.llmm-banner-move')?.['font-family'] ?? '') === 'var(--ds-font-family-code)',
  `name=${declarationsOf('.llmm-name')?.['font-family']} banner=${declarationsOf('.llmm-banner-move')?.['font-family']}`)

// The card must not be painted with the overlay/scrim token. That was the grey card:
// --dsw-alias-bg-overlay is documented as "Overlay and popover background" but
// resolves to a mid grey, so an opaque card built from it reads as a hole rather than
// a surface. DSH's own popovers paint the translucent menu fill on a child layer.
const menuMaterialRule = declarationsOf('.llmm-menu::before')
check('the picker card paints the menu material, not the overlay scrim',
  menuMaterialRule !== null
  && (menuMaterialRule.background ?? '').startsWith('var(--dsw-specific-menu')
  && (menuMaterialRule['backdrop-filter'] ?? '').includes('--dsw-menu-backdrop-filter'),
  `background=${menuMaterialRule?.background} backdrop-filter=${menuMaterialRule?.['backdrop-filter']}`)
// A fallback chain may legitimately name the scrim as the last resort, so look for a
// direct paint: `background:` whose whole value is that token.
const scrimPrimary = cssText.match(/background:\s*var\(--dsw-alias-bg-overlay/g) ?? []
check('nothing paints a surface directly from the overlay scrim token',
  scrimPrimary.length === 0,
  `${scrimPrimary.length} rule(s)`)
check('the command palette borrows the picker card\'s material',
  /\.llmm-pal::before\{[^}]*--dsw-specific-menu/.test(cssText) && /\.llmm-pal\{[^}]*isolation:isolate/.test(cssText),
  /\.llmm-pal::before\{[^}]*--dsw-specific-menu/.test(cssText) ? 'menu fill' : 'no menu fill')

const hoverMismatch = ['background'].filter(key =>
  declarationsOf('.llmm-row:hover')?.[key] !== undefined
  && declarationsOf('.llmm-item:hover')?.[key] !== declarationsOf('.llmm-row:hover')[key]
  && declarationsOf('.llmm-item:hover')?.[key] !== 'var(--dsw-alias-interactive-bg-hover)')
check('a picker row hovers with the design system\'s own fill', hoverMismatch.length === 0,
  declarationsOf('.llmm-item:hover')?.background ?? 'no hover rule')

const panelDim = declarationsOf('.llmm-row.llmm-hidden').opacity
const pickerDim = declarationsOf('.llmm-item.llmm-down').opacity
check('both surfaces dim a de-emphasised row by the same amount', panelDim === pickerDim,
  `panel ${panelDim} vs picker ${pickerDim}`)

// Keyboard focus is the one interaction the panel states explicitly, on its icon
// buttons; the picker's rows are the interactive element there. DSH's own menus use
// the hover fill as the focus indication (Menu.module.css .item:focus-visible) rather
// than a ring, because a ring on top of the fill doubles the signal.
check('a picker row marks keyboard focus the way the design system does',
  declarationsOf('.llmm-item:focus-visible')?.outline === 'none'
  && declarationsOf('.llmm-item:focus-visible')?.background === 'var(--dsw-alias-interactive-bg-hover)',
  `outline=${declarationsOf('.llmm-item:focus-visible')?.outline} background=${declarationsOf('.llmm-item:focus-visible')?.background}`)

// Section headings are heading rows, so they take the MenuGroup treatment:
// 11/16 at weight 500 in the tertiary label colour, padded 4px 7px 2px.
const heading = declarationsOf('.llmm-group')
check('section headings use the design system\'s heading treatment, not the brand color',
  heading !== null
  && heading.color === 'var(--dsw-alias-label-tertiary)'
  && heading['font-size'] === '11px'
  && heading['font-weight'] === '500'
  && heading['line-height'] === '16px'
  && heading.padding === '4px 7px 2px'
  && cssText.includes('.llmm-accent') === false,
  `color=${heading?.color} size=${heading?.['font-size']} weight=${heading?.['font-weight']} padding=${heading?.padding} accentRule=${cssText.includes('.llmm-accent')}`)

// The route label is the same kind of annotation as the panel's "also on" chip, so
// it must be that chip rather than look like one. Asserted on the DOM, because a
// check comparing .llmm-route's declarations against .llmm-chip's would pass even
// if the two were unrelated — .llmm-route declares almost nothing of its own.
const routeNodes = pickerMenuQueryAll('.llmm-route')
check('the route label is rendered as the panel\'s own chip',
  routeNodes.length > 0 && routeNodes.every(node => node.classList.contains('llmm-chip')),
  `${routeNodes.length} route labels, ${routeNodes.filter(n => n.classList.contains('llmm-chip')).length} of them chips`)

// Selecting a lifted row must ask for THAT row's route and model. A row lifted
// out of a non-primary route is exactly where the route could get dropped and the
// click would silently select the same model on the wrong gateway.
//
// Every lookup here is guarded on purpose: when the sections are broken there is
// no such row, and dereferencing it would abort the suite mid-run instead of
// reporting a failure — which would hide every check after this one.
const menuBody = pickerMenuQuery('.llmm-menu-body')
const pinnedBody = pinnedAt >= 0 && menuBody !== null ? menuBody.children[pinnedAt] : null
// The row is a MODEL now, so it is found by name; what must not be dropped is the
// ROUTE the Host resolved for it — the one with history behind it, which may be the
// non-primary route and is exactly what a naive `row.route` default gets wrong.
const mirrorButton = pinnedBody === null
  ? null
  : Array.from(pinnedBody.querySelectorAll('.llmm-item'))
    .find(item => item.querySelector('.llmm-name')?.textContent === mirroredPin) ?? null
const mirroredPrimary = (snapshot.models ?? []).find(entry => entry.model === mirroredPin)?.primary
const selectionBefore = selections.length
if (mirrorButton !== null) {
  await act(async () => {
    // The row is a wrapper now — it holds the selection control and the
    // disclosure — so the click that selects goes to the control that owns it.
    mirrorButton.querySelector('.llmm-item-select')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await waitFor(() => selections.length > selectionBefore)
  })
}
check('clicking a section row selects that model on the route the Host resolved',
  mirrorButton !== null
  && selections.length === selectionBefore + 1
  && selections[selectionBefore].provider === mirroredPrimary
  && selections[selectionBefore].model === mirroredPin,
  mirrorButton === null
    ? `the Pinned section offered no row for ${mirroredPin}`
    : `${JSON.stringify(selections[selectionBefore] ?? null)} vs primary ${mirroredPrimary}`)

/**
 * Open the menu unless it is already open.
 *
 * Choosing a row closes it, but only when a row was actually chosen; on a broken
 * build the menu is still open and clicking the trigger would close it instead.
 * @returns {Promise<void>} resolves once the search box is present.
 */
const ensureOpen = async () => {
  if (pickerMenuQuery('.llmm-input') === null) {
    await act(async () => {
      pickerContainer.querySelector('.llmm-trigger').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => pickerMenuQuery('.llmm-input') !== null)
    })
  }
}

// Reopening and searching must filter across the lifted sections too, not just
// the route groups below them.
await ensureOpen()
await act(async () => {
  const input = pickerMenuQuery('.llmm-input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, favoredModel)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
  await waitFor(() => pickerSections().every(s => s.items.every(r => r.name === favoredModel)))
})
open = pickerSections()
const searched = open.flatMap(s => s.items.map(r => r.name))
check('search narrows the lifted sections as well as the route groups',
  searched.length > 0 && searched.includes(favoredModel) && searched.every(name => name === favoredModel),
  searched.join(', ') || '(nothing matched)')

// ── the row is the MODEL; the route is how it is reached ────────────────────
// Two routes serving one model id are one row, so the row has to say which route a
// click uses. The Host decides that (`primary`, by usage); the picker must honour it
// — and must NOT override a route the user is deliberately on.
{
  // The search box keeps whatever an earlier block typed into it, and the picker
  // keeps one query for its lifetime; read the unfiltered list or every lookup below
  // searches a one-row result.
  const clearSearch = async () => {
    const input = pickerMenuQuery('.llmm-input')
    if (input === null) return
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '')
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await waitFor(() => pickerSections().length > 1)
  }
  const target = mirroredPin
  const entry = (snapshot.models ?? []).find(candidate => candidate.model === target)
  const primary = entry?.primary
  dirSnapshot.current = { provider: SECOND_ROUTE, model: target }
  await act(async () => { pickerRoot.render(React.createElement(pickerSlot.Component, pickerInjected)) })
  await ensureOpen()
  await clearSearch()
  const before = selections.length
  const row = pickerRowFor(target)
  await act(async () => {
    row?.querySelector('.llmm-item-select').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await waitFor(() => selections.length > before)
  })
  check('re-picking a model keeps the route already in use',
    primary !== SECOND_ROUTE
      && selections[before]?.provider === SECOND_ROUTE
      && selections[before]?.model === target,
    `${JSON.stringify(selections[before] ?? null)} while primary is ${primary}`)

  // A model reads as pinned when ANY route is, so clearing the flag has to clear
  // every route. Otherwise the row would keep reporting the state the click removed.
  await hostCall({ action: 'toggle', route: ROUTE, model: target, list: 'pins', on: true })
  dirSnapshot.current = null
  await act(async () => { pickerRoot.render(React.createElement(pickerSlot.Component, pickerInjected)) })
  await ensureOpen()
  await clearSearch()
  const chevron = chevronOf(target)
  if (chevron !== null) {
    await act(async () => {
      chevron.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => pickerDetailOf(target) !== null)
    })
  }
const unpin = Array.from(pickerDetailOf(target)?.querySelectorAll('.llmm-ibtn') ?? [])
  .find(button => /取消置顶|Unpin/.test(button.getAttribute('aria-label') ?? ''))
const unpinPressed = () => unpin?.getAttribute('aria-pressed') === 'true'
const unpinWas = unpinPressed()
await act(async () => {
  unpin?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await waitFor(() => unpinPressed() === false)
})
  const after = (await (await hostCall({ action: 'snapshot' })).json()).value
  const cleared = (after.models ?? []).find(candidate => candidate.model === target)
  check('turning a model-level flag off clears it on every route',
    cleared?.pinned === false && (cleared?.routes ?? []).every(route => route.pinned === false),
    (cleared?.routes ?? []).map(route => `${route.route}:${route.pinned}`).join(','))
  // Restore the fixture the sections above were built on.
  await hostCall({ action: 'toggle', route: SECOND_ROUTE, model: target, list: 'pins', on: true })

  // The routes a model is reachable on are chooseable, so a wrapper route stays usable
  // without being listed as a second model. This is the whole point of merging them:
  // the capability is not lost, it moves from "another row" to "same row, its routes".
  dirSnapshot.current = { provider: ROUTE, model: target }
  await act(async () => { pickerRoot.render(React.createElement(pickerSlot.Component, pickerInjected)) })
  await ensureOpen()
  await clearSearch()
  if (pickerDetailOf(target) === null) {
    const expand = chevronOf(target)
    if (expand !== null) {
      await act(async () => {
        expand.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await waitFor(() => pickerDetailOf(target) !== null)
      })
    }
  }
  const choices = Array.from(pickerDetailOf(target)?.querySelectorAll('.llmm-route-choice') ?? [])
  check('a model served by two routes offers both, with the current one marked',
    choices.length === 2 && choices.some(node => node.classList.contains('llmm-route-on')),
    `${choices.length} choice(s)`)
  const other = choices.find(node => !node.classList.contains('llmm-route-on'))
  const beforeRoute = selections.length
  await act(async () => {
    other?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await waitFor(() => selections.length > beforeRoute)
  })
  check('choosing a route keeps the model and moves only the provider',
    selections[beforeRoute]?.model === target && selections[beforeRoute]?.provider === SECOND_ROUTE,
    JSON.stringify(selections[beforeRoute] ?? null))
  dirSnapshot.current = null
}

// ── the degraded path is model-first too ────────────────────────────────────
// When the Host cannot answer, the picker falls back to the shipped directory. That
// is the one path where a wrapper route is likeliest to be in play (a vision twin is
// registered against a live Host), so it must dedupe by model id exactly like the
// Host's own view instead of listing the model once per route.
{
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('host down') }
  const holder = {
    value: {
      current: null,
      retainedEffort: undefined,
      groups: [
        { id: ROUTE, name: 'A', models: [{ id: at(0) }, { id: at(1) }] },
        { id: SECOND_ROUTE, name: 'B', models: [{ id: at(0) }] },
      ],
    },
  }
  const face = {
    available: true,
    directory: { subscribe: () => () => {}, getSnapshot: () => holder.value },
    load: () => {},
    select: async () => ({ ok: true, value: undefined }),
  }
  // Unmount first: `snap` is component state read once on mount, so re-rendering the
  // same element with new props keeps the snapshot taken before the probe and the row
  // would still read "not probed".
  await act(async () => { pickerRoot.render(null) })
  await act(async () => { pickerRoot.render(React.createElement(pickerSlot.Component, face)) })
  if (pickerMenu() === null) {
    await act(async () => {
      pickerContainer.querySelector('.llmm-trigger')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => pickerMenuQuery('.llmm-menu-body') !== null)
    })
  }
  const names = pickerMenuQueryAll('.llmm-name').map(node => node.textContent)
  check('a Host that cannot answer still lists each model once',
    names.filter(name => name === at(0)).length === 1 && names.includes(at(1)),
    names.join(',') || 'no rows')
  globalThis.fetch = originalFetch
  await act(async () => { pickerRoot.render(React.createElement(pickerSlot.Component, pickerInjected)) })
}

// ── a measured level becomes a declared one from the row itself ─────────────
// The measurement is only useful if it can be acted on: the harness validates a level
// against the model's DECLARATION, so a model the probe measured but nobody declared
// could never be switched. The row offers that write, and the click must reach it.
{
  const UNDECLARED = at(6)
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => (String(url).includes('/chat/completions')
    ? syntheticGatewayFetch(url, init)
    : realFetch(url, init))
  try {
    await hostCall({ action: 'probe', route: ROUTE, model: UNDECLARED })
  } finally {
    globalThis.fetch = realFetch
  }
  const holder = {
    value: {
      current: null,
      retainedEffort: undefined,
      // No `reasoning` at all: nothing is declared for this model.
      groups: [{ id: ROUTE, name: ROUTE, models: [{ id: UNDECLARED }] }],
    },
  }
  const face = {
    available: true,
    directory: { subscribe: () => () => {}, getSnapshot: () => holder.value },
    load: () => {},
    select: async () => ({ ok: true, value: undefined }),
  }
  await act(async () => { pickerRoot.render(null) })
  await act(async () => { pickerRoot.render(React.createElement(pickerSlot.Component, face)) })
  if (pickerMenu() === null) {
    await act(async () => {
      pickerContainer.querySelector('.llmm-trigger')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => pickerMenuQuery('.llmm-menu-body') !== null)
    })
  }
  const rowOf = () => Array.from(pickerMenu()?.querySelectorAll('.llmm-item') ?? [])
    .find(item => item.querySelector('.llmm-name')?.textContent === UNDECLARED) ?? null
  const chevron = rowOf()?.querySelector('.llmm-chevron')
  const detailOf = () => rowOf()?.nextElementSibling?.classList.contains('llmm-detail')
    ? rowOf().nextElementSibling
    : null
  if (detailOf() === null && chevron !== null) {
    await act(async () => {
      chevron.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => detailOf() !== null)
    })
  }
  const button = detailOf()?.querySelector('.llmm-inline-act') ?? null
  check('a model measured but not declared offers to declare the measurement',
    button !== null, detailOf()?.textContent?.slice(0, 90) ?? 'no detail')
  // Measured, but recorded nowhere: the probe declares on its own now, so the state the
  // button exists for has to be seeded — otherwise the click is an idempotent no-op and
  // the assertion below would pass without the button doing anything.
  const forgetDeclaration = (model) => {
    const next = structuredClone(settingsValue)
    const entries = next.providers?.[ROUTE]?.models ?? []
    const index = entries.findIndex(entry => (typeof entry === 'string' ? entry : entry?.id) === model)
    if (index !== -1 && entries[index] !== null && typeof entries[index] === 'object') {
      delete entries[index].reasoningEfforts
    }
    settingsValue = next
  }
  forgetDeclaration(UNDECLARED)
  const before = settingsWrites.length
  await act(async () => {
    button?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await waitFor(() => settingsWrites.length > before)
  })
  const write = settingsWrites.at(-1)
  const written = write?.section?.providers?.[ROUTE]?.models?.find(
    entry => (typeof entry === 'string' ? entry : entry?.id) === UNDECLARED,
  )
  check('clicking it declares exactly the levels the gateway accepted',
    settingsWrites.length === before + 1
      && Object.keys(written?.reasoningEfforts ?? {}).join(',') === 'low,high,max',
    `writes=${settingsWrites.length - before} keys=${Object.keys(written?.reasoningEfforts ?? {}).join(',')}`)

  // The same fact from the composer's side: the level rail must offer the fix for
  // a measured-but-undeclared model instead of a dead control, and the fix has to be
  // the measurement itself — a hint with nothing to act on is what made the user ask
  // why they could not switch.
  await act(async () => { pickerRoot.render(null) })
  holder.value = {
    current: { provider: ROUTE, model: UNDECLARED },
    retainedEffort: undefined,
    groups: [{ id: ROUTE, name: ROUTE, models: [{ id: UNDECLARED }] }],
  }
  await act(async () => { pickerRoot.render(React.createElement(pickerSlot.Component, face)) })
  if (pickerMenu() === null) {
    await act(async () => {
      pickerContainer.querySelector('.llmm-trigger')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => pickerMenuQuery('.llmm-rail-section') !== null)
    })
  }
  const railEmpty = () => pickerMenuQuery('.llmm-rail-empty')
  const railAction = () => railEmpty()?.querySelector('.llmm-inline-act') ?? null
  const railOpen = await waitFor(() => railEmpty() !== null)
  check('a measured-but-undeclared model puts the measurement in the level rail',
    railOpen === true && /declared|声明|配置/i.test(railEmpty()?.textContent ?? ''),
    railEmpty()?.textContent?.slice(0, 90) ?? 'no rail')
  check('the rail action names the measurement it will take',
    /measure|探测/i.test(railAction()?.textContent ?? ''), railAction()?.textContent ?? 'no action')
  // The probe declares on its own, so the state the action exists for has to be
  // seeded again: otherwise the click is an idempotent no-op and the assertion below
  // would pass without the action doing anything.
  forgetDeclaration(UNDECLARED)
  const writesBeforeProbe = settingsWrites.length
  const realProbeFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => (String(url).includes('/chat/completions')
    ? syntheticGatewayFetch(url, init)
    : realProbeFetch(url, init))
  try {
    await act(async () => {
      railAction()?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => settingsWrites.length > writesBeforeProbe, 4000)
    })
  } finally {
    globalThis.fetch = realProbeFetch
  }
  check('the rail measures the model and declares what it found',
    settingsWrites.length === writesBeforeProbe + 1,
    `${settingsWrites.length - writesBeforeProbe} write(s)`)
  await act(async () => { pickerRoot.render(null) })
  await act(async () => { pickerRoot.render(React.createElement(pickerSlot.Component, pickerInjected)) })
}

// ── the probe's measurement is surfaced, including a declaration it disproves ─
// A level sweep exists to stop a declaration from being a guess. Its answer has to
// reach the row, and a declared level the gateway refuses has to be visible as a
// configuration mistake rather than as a failed turn later.
{
  let faceLoads = 0
  const PROBED = at(2)
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => (String(url).includes('/chat/completions')
    ? syntheticGatewayFetch(url, init)
    : realFetch(url, init))
  try {
    const probed = await (await hostCall({ action: 'probe', route: ROUTE, model: PROBED })).json()
  } finally {
    globalThis.fetch = realFetch
  }
  // Declares low (accepted) and medium (refused by the synthetic gateway), so this
  // covers both the measurement and the mismatch it can expose.
  const holder = {
    value: {
      current: null,
      retainedEffort: undefined,
      groups: [{
        id: ROUTE,
        name: ROUTE,
        models: [{ id: PROBED, reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }] } }],
      }],
    },
  }
  const face = {
    available: true,
    directory: { subscribe: () => () => {}, getSnapshot: () => holder.value },
    load: () => { faceLoads += 1 },
    select: async () => ({ ok: true, value: undefined }),
  }
  // Unmount first: `snap` is component state read once on mount, so re-rendering the
  // same element with new props keeps the snapshot taken before the probe and the
  // row would still read "not probed".
  await act(async () => { pickerRoot.render(null) })
  await act(async () => { pickerRoot.render(React.createElement(pickerSlot.Component, face)) })
  if (pickerMenu() === null) {
    await act(async () => {
      pickerContainer.querySelector('.llmm-trigger')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => pickerMenuQuery('.llmm-menu-body') !== null)
    })
  }
  if (pickerDetailOf(PROBED) === null) {
    const chevron = pickerRowFor(PROBED)?.querySelector('.llmm-chevron')
    if (chevron) {
      await act(async () => {
        chevron.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await waitFor(() => pickerDetailOf(PROBED) !== null)
      })
    }
  }
  const detail = pickerDetailOf(PROBED)
  const detailText = detail?.textContent ?? ''
  check('the detail reports the levels the gateway actually accepted',
    /low/.test(detailText) && /high/.test(detailText) && /max/.test(detailText), detailText.slice(0, 120))
  const warn = detail?.querySelector('.llmm-detail-line-warn')?.textContent ?? ''
  check('a declared level the gateway refused is flagged, not silently offered',
    /medium/.test(warn), warn || 'no warning field')
  // The probe declares what it measured, and a declaration changes the catalog —
  // which the snapshot does not carry — so the picker must reload the directory
  // in the same gesture, or the level segment stays unswitchable until remount.
  check('the picker reloads the directory after an auto-declaring probe',
    faceLoads > 0, `${faceLoads} reload(s)`)
  await act(async () => { pickerRoot.render(null) })
  await act(async () => { pickerRoot.render(React.createElement(pickerSlot.Component, pickerInjected)) })
}

// ── the level segment: capability on the trigger, not a second menu ─────────
// The composer already names the model, so the level lives beside it: reachable
// without opening the list, and printed even where it cannot be changed. An
// omitted level is NOT "no thinking" — measured on this gateway, omitting the
// field was identical to `max` — so a hidden row would read as "off".
{
  const ADJUSTABLE = at(0)
  const PLAIN = at(1)
  const EFFORTS = [
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max' },
  ]
  // A NEW snapshot object per mount, not a mutated field: the picker's derived
  // values are memoised on the snapshot's identity, so mutating in place leaves
  // the reasoning index holding the previous (empty) catalog and every level
  // assertion below reads the stale answer.
  const holder = { value: { current: null, groups: [], retainedEffort: undefined } }
  const face = {
    available: true,
    directory: { subscribe: () => () => {}, getSnapshot: () => holder.value },
    load: () => {},
    select: async (selection) => { selections.push(selection); return { ok: true, value: undefined } },
  }
  const rerender = async (current) => {
    holder.value = {
      current,
      retainedEffort: undefined,
      groups: [{
        id: ROUTE,
        name: ROUTE,
        models: MODELS.map(model => ({
          id: model,
          name: model,
          reasoning: model === ADJUSTABLE ? { efforts: EFFORTS, defaultEffort: 'high' } : undefined,
        })),
      }],
    }
    await act(async () => { pickerRoot.render(React.createElement(pickerSlot.Component, face)) })
  }
  // The level is a rail inside the panel now, and the panel is portalled — so every
  // level query goes through the menu, not through the trigger's container.
  const rail = () => pickerMenuQuery('input.llmm-rail')
  const railSection = () => pickerMenuQuery('.llmm-rail-section')
  const railOut = () => pickerMenuQuery('.llmm-rail-out')
  const railAuto = () => pickerMenuQuery('.llmm-rail-auto')
  const railTicks = () => pickerMenuQueryAll('.llmm-rail-tick')
  const triggerEffort = () => pickerContainer.querySelector('.llmm-trigger-effort')
  const click = async (node) => {
    await act(async () => { node.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  }
  // A range input is driven through React's onChange, which listens for `input`.
  const setRail = async (value) => {
    await act(async () => {
      const input = rail()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, String(value))
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
  }

  await rerender({ provider: ROUTE, model: ADJUSTABLE })
  check('the trigger names the level in force, taken from the model own default',
    triggerEffort() !== null && /High/.test(triggerEffort().textContent ?? ''),
    triggerEffort()?.textContent ?? 'no level on the trigger')

  // The list may already be open from an earlier block, and the trigger toggles:
  // clicking unconditionally would close it, and `waitFor` resolves false on
  // timeout rather than throwing, so the assertions below would then read an empty
  // surface instead of failing here.
  if (pickerMenu() === null) await click(pickerContainer.querySelector('.llmm-trigger'))
  const openForChips = await waitFor(() => pickerMenuQuery('.llmm-menu-body') !== null)
  check('the model list is open for the chip assertion', openForChips === true)
  // The search box keeps whatever an earlier block typed into it, and the picker
  // keeps one query for its lifetime. Read the unfiltered list, or this asserts
  // against one matched row.
  await act(async () => {
    const input = pickerMenuQuery('.llmm-input')
    if (input !== null) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    }
    await waitFor(() => pickerMenuQueryAll('.llmm-item').length > 1)
  })
  check('only the adjustable row carries a level chip',
    pickerMenuQueryAll('.llmm-chip-effort').length === 1,
    `${pickerMenuQueryAll('.llmm-chip-effort').length} chip(s)`)

  const railOpen = await waitFor(() => rail() !== null)
  check('the panel carries the level rail instead of a second menu', railOpen === true)
  check('the rail stops at every declared level plus the automatic one',
    rail()?.max === String(EFFORTS.length) && railTicks().length === EFFORTS.length + 1,
    `max=${rail()?.max} ticks=${railTicks().length}`)
  check('the rail starts on the level the model names as its default',
    /High/.test(railOut()?.textContent ?? '') && /auto|自动/i.test(railOut()?.textContent ?? ''),
    railOut()?.textContent ?? 'no output')
  check('the rail spells the level and its id for a screen reader',
    /High, auto/.test(rail()?.getAttribute('aria-valuetext') ?? ''),
    rail()?.getAttribute('aria-valuetext') ?? 'no value text')
  check('the automatic stop reports itself as automatic',
    railAuto()?.getAttribute('aria-pressed') === 'true',
    railAuto()?.getAttribute('aria-pressed') ?? 'no auto control')

  const before = selections.length
  await setRail(EFFORTS.length)
  await waitFor(() => selections.length > before)
  const chosen = selections.slice(before)
  check('moving the rail re-selects the same model with the level under the thumb',
    chosen.length === 1 && chosen[0].provider === ROUTE && chosen[0].model === ADJUSTABLE
      && chosen[0].reasoningEffort === 'max',
    JSON.stringify(chosen))
  check('an explicit level stops reporting itself as automatic',
    railAuto()?.getAttribute('aria-pressed') === 'false',
    railAuto()?.getAttribute('aria-pressed') ?? 'no auto control')

  const beforeAuto = selections.length
  await click(railAuto())
  await waitFor(() => selections.length > beforeAuto)
  check('the automatic stop drops the explicit level instead of pinning one',
    selections[beforeAuto] !== undefined && selections[beforeAuto].reasoningEffort === undefined,
    JSON.stringify(selections[beforeAuto] ?? null))

  // The shipped directory spells the retained level as a NAME ("High"), and passing it
  // to select() makes resolveCallConfig reject the selection — the exact failure the
  // user hit as `does not support reasoning effort "High"`. Re-picking the same model
  // must send the ID.
  holder.value = {
    ...holder.value,
    retainedEffort: 'High',
    current: { provider: ROUTE, model: ADJUSTABLE, reasoningEffort: 'high' },
  }
  await act(async () => { pickerRoot.render(React.createElement(pickerSlot.Component, face)) })
  if (pickerMenu() === null) {
    await act(async () => {
      pickerContainer.querySelector('.llmm-trigger')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => pickerMenuQuery('.llmm-menu-body') !== null)
    })
  }
  const sameRow = Array.from(pickerMenuQueryAll('.llmm-item'))
    .find(item => item.querySelector('.llmm-name')?.textContent === ADJUSTABLE)
  const beforeRepick = selections.length
  await act(async () => {
    sameRow?.querySelector('.llmm-item-select')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await waitFor(() => selections.length > beforeRepick)
  })
  check('re-picking a used model sends the level ID, not its display name',
    selections[beforeRepick]?.reasoningEffort === 'high',
    JSON.stringify(selections[beforeRepick] ?? null))

  await rerender({ provider: ROUTE, model: PLAIN })
  if (pickerMenu() === null) await click(pickerContainer.querySelector('.llmm-trigger'))
  const plainLabel = (triggerEffort()?.textContent ?? '').replace('·', '').trim()
  check('a model that declares nothing shows the default instead of hiding the row',
    /^(Default|默认)$/.test(plainLabel), triggerEffort()?.textContent ?? 'no level on the trigger')
  const plainOpen = await waitFor(() => railSection() !== null)
  check('a model that declares nothing gets no movable rail',
    plainOpen === true && rail() === null && railAuto()?.disabled === true,
    `rail=${rail() !== null} auto=${railAuto()?.disabled}`)

  // The shipped picker lets the arrow keys walk its rows; without that a search hit
  // can only be taken with the mouse, which is the slow half of searching. Our rows
  // are real <button> elements, so Enter and Space stay the platform's job — what has
  // to be added is the focus movement, out of the search box and back up.
  if (pickerMenu() === null) {
    await act(async () => {
      pickerContainer.querySelector('.llmm-trigger')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => pickerMenuQuery('.llmm-menu-body') !== null)
    })
  }
  {
    const rowButtons = () => pickerMenuQueryAll('.llmm-item-select')
    const press = async (key) => {
      await act(async () => {
        const target = window.document.activeElement ?? pickerMenuQuery('.llmm-input')
        target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      })
    }
    pickerMenuQuery('.llmm-input')?.focus()
    await press('ArrowDown')
    const firstFocused = window.document.activeElement === rowButtons()[0]
    await press('ArrowDown')
    const secondFocused = window.document.activeElement === rowButtons()[1]
    await press('ArrowUp')
    const backFocused = window.document.activeElement === rowButtons()[0]
    await press('ArrowUp')
    const wrapped = window.document.activeElement === rowButtons()[rowButtons().length - 1]
    check('the arrow keys walk the model list from the search box',
      rowButtons().length > 2 && firstFocused && secondFocused && backFocused && wrapped,
      `rows=${rowButtons().length} first=${firstFocused} second=${secondFocused} back=${backFocused} wrap=${wrapped}`)
  }

  // The seat we took carries a child slot the shipped menu rendered into: the agent
  // team switch registers there. A replacing entry CANNOT inherit it — `renderSlot`
  // is only injected into entries that declare children, and declaring this child
  // throws "already declared" because the shipped entry owns the declaration. So the
  // capability is re-provided against the same projection and the same remote call,
  // and these checks exist because a silent omission is exactly the regression: the
  // first version of this file spied a renderSlot prop it had injected itself, which
  // proved the call site existed while the switch was missing on every real page.
  if (pickerMenu() === null) {
    await act(async () => {
      pickerContainer.querySelector('.llmm-trigger')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => pickerMenuQuery('.llmm-menu-body') !== null)
    })
  }
  {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 60))
    const teamCalls = []
    const face = (overrides) => ({
      ...pickerInjected,
      sessionId: 'sess-picker',
      useSession: () => false,
      useSessions: () => false,
      // The projection the shipped switch reads, with the shape that row expects.
      useProjection: (name) => (name === 'agentTeam'
        ? { enabled: false }
        : name === 'modelSelection' ? { lastUsed: { route: 'r', model: 'm' } } : undefined),
      setTeamEnabled: (id, enabled) => {
        teamCalls.push({ id, enabled })
        return Promise.resolve({ ok: true })
      },
      ...overrides,
    })
    /** Mount the picker with a given face and make sure its card is on screen. */
    const renderFace = async (props) => {
      await act(async () => { pickerRoot.render(React.createElement(pickerSlot.Component, props)) })
      if (pickerMenu() === null) {
        await act(async () => {
          pickerContainer.querySelector('.llmm-trigger')
            .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        })
      }
      await act(async () => { await settle() })
    }
    const teamRow = () => pickerMenuQuery('.llmm-opt')
    const teamSwitch = () => pickerMenuQuery('.llmm-opt .llmm-switch')
    const click = async (element) => {
      await act(async () => {
        element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await settle()
      })
      await act(async () => { await settle() })
    }

    await renderFace(face({}))
    const rowShown = teamRow() !== null
    const switchShown = teamSwitch() !== null
    check('the picker re-provides the session option the shipped menu carried',
      rowShown && switchShown
        && teamSwitch().getAttribute('role') === 'switch'
        && teamSwitch().getAttribute('aria-checked') === 'false'
        && (pickerMenuQuery('.llmm-opt .llmm-opt-label')?.textContent ?? '') !== '',
      `row=${rowShown} switch=${switchShown} checked=${teamSwitch()?.getAttribute('aria-checked')} label=${JSON.stringify(pickerMenuQuery('.llmm-opt .llmm-opt-label')?.textContent ?? null)}`)

    await click(teamSwitch())
    check('turning teamwork on asks the shipped remote, not a local toggle',
      teamCalls.length === 1 && teamCalls[0].id === 'sess-picker' && teamCalls[0].enabled === true,
      JSON.stringify(teamCalls))

    // Already-on, with a model choice behind it: the shipped row confirms before it
    // stops sharing the task board, because the next turn's cache depends on it.
    teamCalls.length = 0
    await renderFace(face({
      useProjection: (name) => (name === 'agentTeam'
        ? { enabled: true }
        : name === 'modelSelection' ? { lastUsed: { route: 'r', model: 'm' } } : undefined),
    }))
    await click(teamSwitch())
    const asked = pickerMenuQuery('.llmm-opt .llmm-opt-confirm') !== null
    check('stopping teamwork after a model choice asks first',
      asked && teamCalls.length === 0,
      `confirm=${asked} calls=${JSON.stringify(teamCalls)}`)
    const confirmButton = pickerMenuQuery('.llmm-opt-confirm .llmm-dlg-btn-primary')
    await click(confirmButton)
    check('the confirmation is what actually stops it',
      teamCalls.length === 1 && teamCalls[0].id === 'sess-picker' && teamCalls[0].enabled === false,
      JSON.stringify(teamCalls))

    // Without the model-selection projection the shipped row cannot tell whether
    // stopping would cost the next turn its cache, so it disables the switch
    // rather than guessing.
    await renderFace(face({
      useProjection: (name) => (name === 'agentTeam' ? { enabled: false } : undefined),
    }))
    const blindSwitch = teamSwitch()
    check('the switch stays disabled while the selection projection is missing',
      blindSwitch !== null && blindSwitch.disabled === true,
      `present=${blindSwitch !== null} disabled=${blindSwitch && blindSwitch.disabled}`)

    // Two cases where the shipped row renders nothing, and ours must agree: a child
    // session has no team of its own, and a client without the capability has no
    // switch to draw.
    await renderFace(face({ useSession: () => true }))
    const childHidden = teamRow() === null
    await renderFace(face({ useProjection: () => undefined }))
    const absentHidden = teamRow() === null
    check('no teamwork switch for a child session or a client without the capability',
      childHidden && absentHidden,
      `child=${childHidden} absent=${absentHidden}`)

    // Put the face back for whatever runs after this block.
    await renderFace(face({}))
  }
}

await act(async () => { pickerRoot.unmount() })

// ── deleting the counters ───────────────────────────────────────────────────
// The counters describe the user's own habits, so deleting them must be
// reachable from the panel and must actually delete them — a "clear" button that
// only hides the numbers on screen would be worse than none.
const clearedPanel = await (await hostCall({ action: 'reset-usage', route: ROUTE })).json()
check('clearing usage from the panel reports what it cleared',
  clearedPanel.ok !== false && clearedPanel.snapshot !== undefined && (clearedPanel.value?.cleared ?? []).length > 0,
  JSON.stringify(clearedPanel.value?.cleared ?? null))
const usageAfterClear = await (await hostCall({ action: 'usage' })).json()
check('clearing usage leaves no counter behind',
  (usageAfterClear?.value?.models ?? []).length === 0,
  `models remaining: ${(usageAfterClear?.value?.models ?? []).length}`)
const snapAfterClear = await (await hostCall({ action: 'snapshot' })).json()
check('a cleared counter reads as never used, not as a stale number',
  (snapAfterClear?.value?.groups ?? []).flatMap(g => g.rows).every(row => (row.usage?.uses ?? 0) === 0),
  'a row still reports uses after the counters were cleared')

// ── selector.mode is the only way back to the shipped picker ────────────────
// The picker is registered by the CLIENT half, and the client runtime hands a
// plugin only its module URL — `__DSH_BOOT__` entries are { id, url, rev }, with
// no Loader row config — so the mode cannot arrive as `apply`'s second argument.
// It is asked of the Host instead, and a `native` answer releases the seat. These
// mounts pin the whole contract, including that a Host that cannot answer leaves
// the picker alone rather than silently deleting a control.
{
  const originalFetch = globalThis.fetch
  /**
   * Mount the client half against a Host that answers `selectorMode` with `answer`.
   * @param {string|Error} answer - the mode to report, or a thrown failure.
   * @returns {Promise<string[]>} ids still occupying a seat once the answer landed.
   */
  const mount = async (answer) => {
    const live = new Set()
    globalThis.fetch = async () => {
      if (answer instanceof Error) throw answer
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { selectorMode: answer } }) }
    }
    captured.apply({
      slots: {
        inject: (_key, callback) => {
          const release = callback()
          return () => { if (typeof release === 'function') release() }
        },
        register: (options) => { live.add(options.id ?? options.name); return () => { live.delete(options.id ?? options.name) } },
      },
    })
    // The answer is a real request, so the release lands a tick later.
    await new Promise((resolve) => setTimeout(resolve, 50))
    return [...live]
  }
  const managed = await mount('managed')
  check('the managed mode keeps the picker', managed.includes('llm-manage-picker'), managed.join(',') || 'nothing registered')
  const native = await mount('native')
  check('selector.mode = native releases the picker', !native.includes('llm-manage-picker'), native.join(',') || 'nothing registered')
  check('releasing the picker keeps the management panel', native.includes('llm-manage-panel'), native.join(',') || 'nothing registered')
  const unreachable = await mount(new Error('host down'))
  check('an unreachable Host does not delete the picker', unreachable.includes('llm-manage-picker'), unreachable.join(',') || 'nothing registered')

  // A Host that predates the cheap action still answers the snapshot, and the
  // browser always loads the newer client half — so the fallback is the difference
  // between `native` working on an un-restarted Host and looking inert.
  {
    const live = new Set()
    const asked = []
    globalThis.fetch = async (_url, init) => {
      const action = JSON.parse(init.body).action
      asked.push(action)
      if (action === 'selectorMode') {
        return { ok: true, status: 400, json: async () => ({ ok: false, message: 'unknown action' }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { selectorMode: 'native' } }) }
    }
    captured.apply({
      slots: {
        inject: (_key, callback) => {
          const release = callback()
          return () => { if (typeof release === 'function') release() }
        },
        register: (options) => { live.add(options.id ?? options.name); return () => { live.delete(options.id ?? options.name) } },
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    check('a Host without the cheap action still honours native through the snapshot',
      !live.has('llm-manage-picker'), [...live].join(',') || 'nothing registered')
    check('the fallback asks the cheap action first', asked[0] === 'selectorMode', asked.join(' → '))
  }
  globalThis.fetch = originalFetch
}

// ── one model, two routes, one proficiency ──────────────────────────────────
// The label sits beside a MODEL name, and the same model can be served by two routes
// (a wrapper beside the original). Reading one route's ledger would show the level the
// user earned on one transport and "never used" on the other — the same number has to
// be there whichever route the shipped picker happens to label.
{
  const SHARED = at(0)                    // also served by MIRROR_ROUTE
  for (let seq = 200; seq < 212; seq += 1) {
    usageEmit('session/event', { id: 'sess-shared' },
      usageMessage(seq, SHARED, Date.now() - 60000, { inputTokens: 10, outputTokens: 2 }))
  }
  const rows = (await (await hostCall({ action: 'badges' })).json())?.value ?? []
  const shared = rows.filter(row => row.model === SHARED)
  check('a model served by two routes reports the same level on both labels',
    shared.length >= 2 && shared[0].uses >= 12
      && shared.every(row => row.level === shared[0].level && row.uses === shared[0].uses),
    JSON.stringify(shared))
}

// ── the marks this plugin puts INSIDE the shipped picker ─────────────────────
// Handing the composer seat back to the owner means the plugin's value has to ride in
// the owner's own label. Two failure modes matter and neither is visible in a picker
// screenshot: a contribution REPLACES the owner's fallback, so a label that forgets the
// model name blanks the composer control; and the label mounts once per catalogue row,
// so a stylesheet per instance would multiply a 20 KB sheet by the catalogue size.
{
  const labelSlot = slots.find(slot => slot.options.name === 'conversation.input.model.label')
  check('the client half decorates the shipped picker with a label contribution',
    labelSlot !== undefined && labelSlot.options.id === 'llm-manage-label',
    labelSlot === undefined ? 'not registered' : JSON.stringify(labelSlot.options))
  if (labelSlot !== undefined) {
    // The ledger the label reads was cleared by the panel tests above, and a level is
    // only ever claimed for committed use — so it is seeded the way the real one fills.
    const LABELED = at(3)
    for (let seq = 100; seq < 112; seq += 1) {
      usageEmit('session/event', { id: 'sess-label' },
        usageMessage(seq, LABELED, Date.now() - 60000, { inputTokens: 10, outputTokens: 2 }))
    }
    const host = window.document.createElement('div')
    window.document.body.appendChild(host)
    const labelRoot = createRoot(host)
    const labelProps = {
      provider: { id: ROUTE, name: ROUTE },
      model: { id: LABELED, name: LABELED, badge: { text: { en: 'Preview', 'zh-cn': '预览' } } },
      placement: 'option',
      selected: false,
    }
    await act(async () => { labelRoot.render(React.createElement(labelSlot.Component, labelProps)) })
    await waitFor(() => /Lv\.\d/.test(host.textContent))
    check('the label draws the model name itself, so the fallback is not what shows',
      host.querySelector('.llmm-label-name')?.textContent === LABELED,
      host.textContent || 'empty label')
    check('the label carries the level use has earned',
      /Lv\.\d/.test(host.textContent), host.textContent || 'no level')
    check('the label keeps the listing badge the owner would have drawn',
      host.textContent.includes('Preview') || host.textContent.includes('预览'),
      host.textContent || 'no badge')
    check('the plugin stylesheet is mounted once in <head>, not per label',
      window.document.querySelectorAll('style[data-llmm-style]').length === 1,
      `${window.document.querySelectorAll('style[data-llmm-style]').length} sheet(s)`)

    // The collapsed trigger carries health only: the owner budgeted its width, and the
    // level is a detail worth the space inside the menu, not on the button.
    await act(async () => {
      labelRoot.render(React.createElement(labelSlot.Component, { ...labelProps, placement: 'trigger' }))
      await waitFor(() => !/Lv\.\d/.test(host.textContent))
    })
    check('the collapsed trigger drops the level chip',
      !/Lv\.\d/.test(host.textContent), host.textContent || 'empty label')
    // A SECOND instance, mounted into its own root: re-rendering the first one would
    // not re-run its effect, so only a real second mount can catch a sheet per label.
    const second = window.document.createElement('div')
    window.document.body.appendChild(second)
    const secondRoot = createRoot(second)
    await act(async () => { secondRoot.render(React.createElement(labelSlot.Component, labelProps)) })
    await waitFor(() => second.querySelector('.llmm-label-name') !== null)
    check('a second label instance reuses the mounted stylesheet',
      window.document.querySelectorAll('style[data-llmm-style]').length === 1,
      `${window.document.querySelectorAll('style[data-llmm-style]').length} sheet(s)`)

    await act(async () => { secondRoot.unmount() })
    second.remove()
    await act(async () => { labelRoot.unmount() })
    host.remove()
  }
}

// ── the composer controller ─────────────────────────────────────────────────
// The rail is additive: the editor keeps every shipped seat, and this layer reads the
// same input state it publishes. What matters is that every shape comes from real
// state (a decorative mode would lie while the session runs) and that each palette row
// does the thing it names — a command palette whose actions are props-free is a mock.
{
  const railSlot = slots.find(slot => slot.options.name === 'conversation.input.right' && slot.options.id === 'llm-manage-rail')
  check('the composer controls take the seat inside the card, before submit',
    railSlot !== undefined && railSlot.options.order === 0,
    railSlot === undefined ? 'not registered' : JSON.stringify(railSlot.options))
  if (railSlot !== undefined) {
    const MODEL = at(0)
    const catalog = {
      current: { provider: ROUTE, model: MODEL, reasoningEffort: 'high' },
      groups: [{
        id: ROUTE,
        models: [{
          id: MODEL,
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low' },
              { id: 'high', name: 'High' },
              { id: 'max', name: 'Max' },
            ],
          },
        }],
      }],
    }
    const selects = []
    const loads = []
    const submits = []
    const drafts = []
    const directories = {
      directoryFor: () => ({
        store: { subscribe: () => () => {}, getSnapshot: () => catalog },
        load: () => { loads.push(1); return Promise.resolve() },
        select: async selection => { selects.push(selection) },
      }),
    }
    let inputState = { draft: '', attachmentIds: [], phase: 'plain', queue: [] }
    let statusMap = new Map()
    const controllerProps = {
      sessionId: 'sess-controller',
      useInput: selector => selector(inputState),
      useSessionStatus: selector => selector(statusMap),
      inputActions: {
        submit: () => { submits.push(inputState.draft) },
        setDraft: text => { drafts.push(text) },
      },
      modelDirectories: directories,
    }
    const host = window.document.createElement('div')
    window.document.body.appendChild(host)
    const railRoot = createRoot(host)
    const renderRail = async () => {
      await act(async () => {
        railRoot.render(React.createElement(railSlot.Component, controllerProps))
      })
    }
    const pressKey = async (key, init = {}) => {
      await act(async () => {
        window.document.dispatchEvent(new window.KeyboardEvent('keydown', {
          key, bubbles: true, cancelable: true, ...init,
        }))
      })
    }

    await renderRail()
    await waitFor(() => host.querySelector('.llmm-ctl') !== null)
    check('an idle session collapses the controller to a hairline',
      host.querySelector('.llmm-ctl')?.dataset.mode === 'idle',
      host.querySelector('.llmm-ctl')?.dataset.mode ?? 'no rail')

    inputState = { draft: 'hello', attachmentIds: [], phase: 'plain', queue: [] }
    await renderRail()
    check('a draft expands the controller into a meter',
      host.querySelector('.llmm-ctl')?.dataset.mode === 'draft'
        && /5/.test(host.querySelector('.llmm-ctl-text')?.textContent ?? ''),
      host.querySelector('.llmm-ctl-text')?.textContent ?? 'no text')

    statusMap = new Map([['sess-controller', { running: true, pendingInteraction: undefined, completionUnread: false }]])
    await renderRail()
    check('a running turn becomes a capsule with a clock',
      host.querySelector('.llmm-ctl')?.dataset.mode === 'running'
        && /0:0\d/.test(host.querySelector('.llmm-ctl-text')?.textContent ?? ''),
      host.querySelector('.llmm-ctl-text')?.textContent ?? 'no text')

    statusMap = new Map([['sess-controller', { running: false, pendingInteraction: { kind: 'question' }, completionUnread: false }]])
    await renderRail()
    check('a turn waiting on the user says so on the same line',
      /等待|Waiting|waiting/i.test(host.querySelector('.llmm-ctl-text')?.textContent ?? ''),
      host.querySelector('.llmm-ctl-text')?.textContent ?? 'no text')

    statusMap = new Map()
    inputState = { draft: 'ping', attachmentIds: [], phase: 'plain', queue: [] }
    await renderRail()

    check('the cluster holds no second level control: the trigger beside it already owns that fact',
      host.querySelector('.llmm-ctl-chip') === null,
      host.querySelector('.llmm-ctl-chip')?.textContent ?? 'no chip')
    check('the cluster keeps the manager button and the shortcut hint',
      host.querySelector('.llmm-ctl-icon[aria-label]') !== null
        && host.querySelector('.llmm-ctl-key') !== null, 'missing pieces')

    const openPalette = async () => {
      await pressKey('k', { metaKey: true })
      await waitFor(() => window.document.querySelector('.llmm-pal') !== null)
      return window.document.querySelector('.llmm-pal')
    }
    const closePalette = async () => {
      if (window.document.querySelector('.llmm-pal') === null) return
      await pressKey('Escape')
      await waitFor(() => window.document.querySelector('.llmm-pal') === null)
    }
    // React reads `value` from its own state, so a bare assignment never reaches
    // onChange: drive the native setter and the input event, as a keyboard would.
    const setQuery = async (text) => {
      const field = window.document.querySelector('.llmm-pal-search')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      await act(async () => {
        setter.call(field, text)
        field.dispatchEvent(new window.Event('input', { bubbles: true }))
      })
    }
    const rowOf = pattern => Array.from(window.document.querySelectorAll('.llmm-pal-item'))
      .find(row => pattern.test(row.textContent ?? ''))

    const palette = await openPalette()
    check('the shortcut opens the command palette over the composer', palette !== null, 'no palette')
    const groupTitles = Array.from(palette.querySelectorAll('.llmm-pal-group')).map(node => node.textContent ?? '')
    check('the palette groups its commands instead of stacking one flat list',
      groupTitles.length >= 4 && /本会话|This session/.test(groupTitles[0] ?? ''),
      groupTitles.join(' | '))
    check('the palette takes typed input, not only arrow keys',
      palette.querySelector('.llmm-pal-search') !== null, 'no search field')
    const rootLabels = Array.from(palette.querySelectorAll('.llmm-pal-label')).map(node => node.textContent ?? '')
    // The levels are one row that names the stop in force. Eight rows of stops used
    // to outnumber every other command and pushed them off the first screen.
    check('the level is one row naming the current stop, not eight rows of stops',
      rootLabels.some(label => /档位|Level/.test(label) && /High/.test(label))
        && !rootLabels.some(label => /^(Low|Max)$/.test(label.trim())),
      rootLabels.join(' | '))

    await pressKey('Enter')
    check('Enter runs the highlighted command instead of submitting the draft',
      submits.length === 1 && drafts.length === 0,
      `${submits.length} submit(s), ${drafts.length} draft write(s)`)
    const closedAfterRun = await waitFor(() => window.document.querySelector('.llmm-pal') === null)
    check('the palette closes once a command has run', closedAfterRun, 'palette still open')

    await openPalette()
    await setQuery('probe')
    const filtered = Array.from(window.document.querySelectorAll('.llmm-pal-label')).map(node => node.textContent ?? '')
    check('typing narrows the list to the commands that answer to that word',
      filtered.length >= 1 && filtered.length < rootLabels.length
        && filtered.every(label => /探活|Probe/i.test(label)),
      filtered.join(' | '))

    await setQuery('zzzz')
    check('a search that matches nothing says so instead of drawing an empty card',
      window.document.querySelector('.llmm-pal-empty') !== null,
      window.document.querySelector('.llmm-pal-empty')?.textContent ?? 'no empty state')

    await setQuery('probe')
    await pressKey('Escape')
    check('Escape clears the search word before it closes the panel',
      window.document.querySelector('.llmm-pal') !== null
        && window.document.querySelector('.llmm-pal-search')?.value === '',
      `open=${window.document.querySelector('.llmm-pal') !== null} value=${window.document.querySelector('.llmm-pal-search')?.value}`)
    await closePalette()

    await openPalette()
    await act(async () => { rowOf(/档位|Level/).querySelector('.llmm-pal-run').click() })
    const levelLabels = Array.from(window.document.querySelectorAll('.llmm-pal-label')).map(node => node.textContent ?? '')
    check('the level row opens a page of the stops, automatic included',
      levelLabels.some(label => /Low/.test(label))
        && levelLabels.some(label => /自动|Auto/.test(label))
        && window.document.querySelector('.llmm-pal-back') !== null,
      levelLabels.join(' | '))
    const currentRows = Array.from(window.document.querySelectorAll('.llmm-pal-item'))
      .filter(row => /当前|current/.test(row.textContent ?? ''))
    check('exactly one stop is marked as the one in force',
      currentRows.length === 1 && /High/.test(currentRows[0]?.textContent ?? ''),
      currentRows.map(row => row.textContent).join(' | ') || 'none marked')

    await act(async () => { rowOf(/Low/)?.querySelector('.llmm-pal-run')?.click() })
    await waitFor(() => selects.length > 0)
    check('a level row commits that level through the shipped directory',
      selects[0]?.reasoningEffort === 'low' && selects[0]?.model === MODEL,
      JSON.stringify(selects[0] ?? null))
    await closePalette()

    // The Host is held open on purpose: a command that takes a round trip has to
    // look like work in progress, and the rest of the list has to stop accepting
    // clicks while it runs.
    await openPalette()
    const originalFetch = globalThis.fetch
    const asked = []
    // One resolver per parked request: holding the gate on a single slot would
    // park the probe and hand the release to whichever request came last, so the
    // command under test would never finish.
    const parked = []
    let gate = true
    globalThis.fetch = async (request, init) => {
      try { asked.push(JSON.parse(init?.body ?? '{}').action) } catch { asked.push('?') }
      // Only while the gate is shut: opening it lets late requests (the harness
      // fetching a stylesheet, say) through instead of stranding them too.
      if (gate) await new Promise(resolve => { parked.push(resolve) })
      return originalFetch(request, init)
    }
    await act(async () => { rowOf(/探活|Probe/)?.querySelector('.llmm-pal-run')?.click() })
    await waitFor(() => window.document.querySelector('.llmm-pal-spin') !== null)
    const spinnerWhileBusy = window.document.querySelector('.llmm-pal-spin') !== null
    const lockedRows = Array.from(window.document.querySelectorAll('.llmm-pal-run'))
      .filter(button => button.disabled === true).length
    check('a command in flight shows work instead of a dead row', spinnerWhileBusy, 'no spinner')
    check('the rows that are not running are locked while one runs', lockedRows >= 3, `${lockedRows} locked`)
    await act(async () => { gate = false; parked.splice(0).forEach(resolve => resolve()) })
    await waitFor(() => window.document.querySelector('.llmm-pal-spin') === null)
    await waitFor(() => loads.length > 0)
    globalThis.fetch = originalFetch
    check('the probe row asks the Host for a real deep probe', asked[0] === 'probe', asked.join(','))
    check('the probe reloads the catalogue so the level seat keeps up', loads.length > 0, `${loads.length} load(s)`)
    check('the answer lands on the row that was asked',
      /探活完成|probe finished/i.test(window.document.querySelector('.llmm-pal-ok')?.textContent ?? ''),
      window.document.querySelector('.llmm-pal-ok')?.textContent ?? 'no answer')

    const forced = []
    globalThis.fetch = async (request, init) => {
      let body = {}
      try { body = JSON.parse(init?.body ?? '{}') } catch { body = {} }
      if (body.action === 'snapshot') forced.push(body.forceDirectory === true)
      return originalFetch(request, init)
    }
    await act(async () => { rowOf(/重拉|Refresh/).querySelector('.llmm-pal-run').click() })
    await waitFor(() => forced.length > 0)
    globalThis.fetch = originalFetch
    check('the refresh row asks the Host to bypass its cached catalogue',
      forced.includes(true), JSON.stringify(forced))
    // A command in flight disables the other rows on purpose, so the next click has
    // to wait for this one to land — otherwise the clear row is still locked and
    // the failure reads as "clear is broken" instead of "clear was not asked yet".
    await waitFor(() => window.document.querySelector('.llmm-pal-spin') === null)
    await closePalette()

    await pressKey('k', { metaKey: true })
    await waitFor(() => window.document.querySelector('.llmm-pal') !== null)
    await pressKey('Escape')
    const closedByEscape = await waitFor(() => window.document.querySelector('.llmm-pal') === null)
    check('Escape closes the palette and leaves the draft alone',
      closedByEscape && drafts.length === 0,
      `${drafts.length} draft write(s)`)

    await pressKey('k', { metaKey: true })
    await waitFor(() => window.document.querySelector('.llmm-pal') !== null)
    await act(async () => {
      window.document.querySelector('.llmm-pal-list')?.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }))
    })
    const survivesInside = window.document.querySelector('.llmm-pal') !== null
    await act(async () => {
      window.document.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }))
    })
    const closedByOutside = await waitFor(() => window.document.querySelector('.llmm-pal') === null)
    check('the palette closes when the pointer goes anywhere else, and not when it stays in',
      survivesInside && closedByOutside,
      `inside=${survivesInside} outside=${closedByOutside}`)

    await pressKey('k', { metaKey: true })
    await waitFor(() => window.document.querySelector('.llmm-pal') !== null)
    await act(async () => { rowOf(/清空|Clear/)?.querySelector('.llmm-pal-run')?.click() })
    check('the clear row empties the draft through the owner action',
      drafts.length === 1 && drafts[0] === '', JSON.stringify(drafts))

    // The dialog has to be reachable while the shipped picker owns the model
    // seat, where none of our picker surfaces are mounted at all — that is the
    // default mode, so an entry only the picker carries would be unreachable.
    const mgSlot = slots.find(candidate => candidate.options.id === 'llm-manage-manager')
    const mgShell = window.document.createElement('div')
    window.document.body.appendChild(mgShell)
    const mgShellRoot = createRoot(mgShell)
    // Titles come from the Session list projection, so the harness answers it the way
    // the shell does: one row per Session, with the label the sidebar would draw.
    const sessionFace = selector => selector({
      byId: {
        'sess-seed-a': { id: 'sess-seed-a', displayTitle: 'Retry storm on the API' },
        'sess-seed-b': { id: 'sess-seed-b', title: 'Batch import' },
      },
    })
    await act(async () => { mgShellRoot.render(React.createElement(mgSlot.Component, { useSessions: sessionFace })) })
    await pressKey('m', { metaKey: true, shiftKey: true })
    const openedByShortcut = await waitFor(() => mgShell.querySelector('.llmm-dlg') !== null)
    check('the manager opens from the session shortcut without our picker mounted',
      openedByShortcut, 'no dialog')
    await act(async () => { mgShell.querySelector('.llmm-dlg-head .llmm-dlg-close')?.click() })
    const closedByItsButton = await waitFor(() => mgShell.querySelector('.llmm-dlg') === null)
    check('the dialog closes from its own header button', closedByItsButton, 'still open')

    await act(async () => {
      window.document.querySelector('.llmm-ctl-icon[aria-label]')?.click()
    })
    const openedByRail = await waitFor(() => mgShell.querySelector('.llmm-dlg') !== null)
    check('the always-visible rail button opens the dialog in one click', openedByRail, 'no dialog')
    await act(async () => { mgShell.querySelector('.llmm-dlg-head .llmm-dlg-close')?.click() })
    await waitFor(() => mgShell.querySelector('.llmm-dlg') === null)

    await pressKey('k', { metaKey: true })
    await waitFor(() => window.document.querySelector('.llmm-pal') !== null)
    await act(async () => { rowOf(/模型管理|Manage models/)?.querySelector('.llmm-pal-run')?.click() })
    const openedByPalette = await waitFor(() => mgShell.querySelector('.llmm-dlg') !== null)
    check('the palette carries the same way into the dialog', openedByPalette, 'no dialog')
    await act(async () => { mgShell.querySelector('.llmm-dlg-head .llmm-dlg-close')?.click() })
    await waitFor(() => mgShell.querySelector('.llmm-dlg') === null)

    // A row that names a tab has to land on that tab: opening on Catalog and
    // leaving the user to click again answers a different question than the one
    // the row promises.
    await pressKey('k', { metaKey: true })
    await waitFor(() => window.document.querySelector('.llmm-pal') !== null)
    await act(async () => { rowOf(/最近的故障切换|Recent failovers/)?.querySelector('.llmm-pal-run')?.click() })
    const landedOnFailover = await waitFor(() => {
      const selected = mgShell.querySelector('.llmm-dlg-tabs .llmm-tab[aria-selected="true"]')
      return selected !== null && /故障切换|Failover/.test(selected.textContent ?? '')
    })
    check('a palette row that names a tab opens the dialog on that tab',
      landedOnFailover,
      mgShell.querySelector('.llmm-dlg-tabs .llmm-tab[aria-selected="true"]')?.textContent ?? 'no tab')
    await act(async () => { mgShell.querySelector('.llmm-dlg-head .llmm-dlg-close')?.click() })
    await waitFor(() => mgShell.querySelector('.llmm-dlg') === null)
    await act(async () => { mgShellRoot.unmount() })
    mgShell.remove()

    await pressKey('k', { metaKey: true })
    await waitFor(() => window.document.querySelector('.llmm-pal') !== null)
    await act(async () => { railRoot.unmount() })
    host.remove()
    const cleanedUp = await waitFor(() => window.document.querySelector('.llmm-pal') === null)
    check('the controller cleans its portal up when it goes away', cleanedUp, 'palette left behind')
  }
}


// ── the model manager dialog ─────────────────────────────────────────────────
// The dialog is the only surface that drafts a fallback policy and a manual
// proficiency together, so these assertions are about the SAVE boundary: what
// lands immediately (pins), what waits for the button (the chain, the levels),
// and what a cancel must leave untouched.
const managerSlot = slots.find(s => s.options.id === 'llm-manage-manager')
check('the manager dialog rides the shell overlay', managerSlot !== undefined && managerSlot.options.order === 30,
  managerSlot === undefined ? 'not registered' : `order ${managerSlot.options.order}`)

if (managerSlot !== undefined) {
  const mgContainer = window.document.createElement('div')
  window.document.body.appendChild(mgContainer)
  const mgRoot = createRoot(mgContainer)
  // The Session list the shell would project: one row per Session. `sess-seed-c` is
  // deliberately absent, because a Session the shell no longer lists still has a
  // history row and must still be identifiable.
  const sessionRows = selector => selector({
    byId: {
      'sess-seed-a': { id: 'sess-seed-a', displayTitle: 'Retry storm on the API' },
      'sess-seed-b': { id: 'sess-seed-b', title: 'Batch import' },
    },
  })
  await act(async () => { mgRoot.render(React.createElement(managerSlot.Component, { useSessions: sessionRows })) })
  check('the manager renders nothing until something opens it',
    mgContainer.querySelector('.llmm-dlg') === null)

  const dlg = () => mgContainer.querySelector('.llmm-dlg')
  const tabs = () => Array.from(mgContainer.querySelectorAll('.llmm-dlg-tabs .llmm-tab'))
  const rows = () => Array.from(mgContainer.querySelectorAll('.llmm-mg-item'))
  const rowFor = (model) => rows().find(row => (row.querySelector('.llmm-mg-name')?.textContent ?? '') === model)
  const rowActs = (model) => Array.from(rowFor(model)?.querySelectorAll('.llmm-mg-acts button') ?? [])
  const saveButton = () => mgContainer.querySelector('.llmm-dlg-foot .llmm-dlg-btn-primary')
  const cancelButton = () => Array.from(mgContainer.querySelectorAll('.llmm-dlg-foot .llmm-dlg-btn'))
    .find(button => !button.className.includes('primary') && !button.className.includes('danger'))
  // hostCall returns the raw Response; the state lives in its JSON body.
  const hostJson = async (body) => (await hostCall(body)).json()
  const snapNow = async () => (await hostJson({ action: 'snapshot' })).value
  const modelNow = async (model) => (await snapNow()).models.find(entry => entry.model === model)
  // The picker block above unmounted its instance, so this block mounts its own:
  // the footer entry is the only public way into the dialog, which makes the
  // path worth exercising rather than reaching into the store behind it.
  const mgPickerContainer = window.document.createElement('div')
  window.document.body.appendChild(mgPickerContainer)
  const mgPickerRoot = createRoot(mgPickerContainer)
  await act(async () => { mgPickerRoot.render(React.createElement(pickerSlot.Component, pickerInjected)) })
  const openFromPicker = async () => {
    await act(async () => {
      mgPickerContainer.querySelector('.llmm-trigger')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => pickerMenu() !== null)
    })
    await act(async () => {
      pickerMenuQuery('.llmm-foot-manage')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => dlg() !== null)
    })
  }

  await openFromPicker()
  check('the picker footer opens the manager', dlg() !== null)
  check('the manager is a labelled modal dialog',
    dlg()?.getAttribute('role') === 'dialog' && dlg()?.getAttribute('aria-modal') === 'true'
    && (dlg()?.getAttribute('aria-label') ?? '').length > 0,
    `role=${dlg()?.getAttribute('role')} label=${dlg()?.getAttribute('aria-label')}`)
  check('the manager offers the four tabs the prototype names', tabs().length === 4,
    tabs().map(tab => tab.textContent).join(' / '))
  check('the catalog tab is the one it opens on', tabs()[0]?.getAttribute('aria-selected') === 'true')
  check('the catalog lists every model the snapshot carries', rows().length === MODELS.length,
    `${rows().length} row(s) for ${MODELS.length} model(s)`)

  const firstModel = MODELS[0]
  const acts = rowActs(firstModel)
  check('a row carries the four tools: pin, star, visibility and pulse', acts.length === 4,
    `${acts.length} action(s)`)
  check('the row tools are icon buttons with real accessible names',
    acts.every(button => (button.textContent ?? '').trim() === ''
      && (button.getAttribute('aria-label') ?? '').length > 0),
    JSON.stringify(acts.map(button => button.getAttribute('aria-label'))))

  // Pins are NOT drafted: they already behave immediately in the panel, so the
  // dialog must not introduce a second, contradictory behaviour for the same list.
  const pinLabelBefore = acts[0].getAttribute('aria-label') ?? ''
  await act(async () => {
    acts[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await waitFor(() => (rowActs(firstModel)[0]?.getAttribute('aria-label') ?? '') !== pinLabelBefore)
  })
  const pinnedNow = (await modelNow(firstModel))?.routes?.find(route => route.route === ROUTE)?.pinned === true
  check('pinning a model in the dialog lands immediately', pinnedNow,
    `aria-label=${rowActs(firstModel)[0]?.getAttribute('aria-label')}`)

  // A manual proficiency is drafted, so it must not reach the Host until save.
  await act(async () => {
    rowFor(firstModel)?.querySelector('.llmm-mg-main')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await waitFor(() => mgContainer.querySelector('.llmm-mg-levels') !== null)
  })
  const levelButtons = () => Array.from(mgContainer.querySelectorAll('.llmm-mg-levels .llmm-mg-lvbtn'))
  check('the expanded row offers a proficiency editor with an automatic stop',
    levelButtons().length === 8, `${levelButtons().length} button(s)`)
  await act(async () => {
    levelButtons()[3].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await waitFor(() => mgContainer.querySelector('.llmm-dlg-dirty') !== null)
  })
  check('editing the proficiency is drafted, not written', mgContainer.querySelector('.llmm-dlg-dirty') !== null,
    (await modelNow(firstModel))?.routes?.[0]?.usage?.level ?? 'no level')
  const levelBeforeSave = (await modelNow(firstModel))?.routes?.find(route => route.route === ROUTE)?.usage?.level
  check('the draft leaves the Host alone until save', levelBeforeSave !== 3, `level=${levelBeforeSave}`)

  await act(async () => {
    saveButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await waitFor(() => mgContainer.querySelector('.llmm-dlg-dirty') === null)
  })
  {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      if ((await modelNow(firstModel))?.routes?.find(route => route.route === ROUTE)?.usage?.level === 3) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  const levelAfterSave = (await modelNow(firstModel))?.routes?.find(route => route.route === ROUTE)?.usage?.level
  check('saving writes the drafted proficiency', levelAfterSave === 3, `level=${levelAfterSave}`)
  check('a save that landed says so', (mgContainer.querySelector('.llmm-dlg-note')?.textContent ?? '').length > 0,
    mgContainer.querySelector('.llmm-dlg-note')?.textContent ?? 'no note')

  // Cancel has to mean cancel: the second edit must not survive the discard path.
  await act(async () => {
    levelButtons()[5].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await waitFor(() => mgContainer.querySelector('.llmm-dlg-dirty') !== null)
  })
  await act(async () => {
    cancelButton()?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await waitFor(() => mgContainer.querySelector('.llmm-dlg-ask') !== null)
  })
  check('cancelling with unsaved edits asks before throwing them away',
    mgContainer.querySelector('.llmm-dlg-ask') !== null)
  await act(async () => {
    mgContainer.querySelector('.llmm-dlg-ask .llmm-dlg-btn-danger')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await waitFor(() => dlg() === null)
  })
  const levelAfterDiscard = (await modelNow(firstModel))?.routes?.find(route => route.route === ROUTE)?.usage?.level
  check('discarding a draft writes nothing', dlg() === null && levelAfterDiscard === 3,
    `level=${levelAfterDiscard}`)

  // ── the failover policy tab ──
  await openFromPicker()
  await act(async () => {
    tabs()[1]?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await waitFor(() => mgContainer.querySelector('.llmm-fb-toggle') !== null)
  })
  check('the failover tab exposes the enable switch', mgContainer.querySelector('.llmm-fb-toggle input') !== null)

  // ── the recovery policy lives beside the chain ──
  // It is a preference with an immediate effect, so the switch has to (a) show what
  // the Host is actually doing and (b) write when it moves, not when the draft saves.
  const policySwitches = () => [...mgContainer.querySelectorAll('.llmm-policy .llmm-switch')]
  check('the failover tab shows both recovery switches',
    policySwitches().length === 2
      && policySwitches().every(node => node.getAttribute('role') === 'switch' && node.getAttribute('aria-label') !== ''),
    `${policySwitches().length} switch(es)`)
  check('a recovery switch starts on what the Host reports',
    policySwitches()[1]?.getAttribute('aria-checked') === String((await snapNow()).recovery.autoContinue),
    `aria=${policySwitches()[1]?.getAttribute('aria-checked')}`)
  const policies = []
  const realFetchPolicy = globalThis.fetch
  globalThis.fetch = async (request, init) => {
    try {
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (body.action === 'setRecovery') policies.push(body)
    } catch { /* not ours */ }
    return realFetchPolicy(request, init)
  }
  try {
    await act(async () => {
      policySwitches()[1]?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => policies.length > 0)
    })
    await new Promise((resolve) => setTimeout(resolve, 80))
  } finally {
    globalThis.fetch = realFetchPolicy
  }
  check('moving a recovery switch writes it immediately',
    policies.length === 1 && policies[0].autoContinue === false,
    JSON.stringify(policies))
  check('the switch then reports the new state',
    policySwitches()[1]?.getAttribute('aria-checked') === 'false'
      && (await snapNow()).recovery.autoContinue === false,
    `aria=${policySwitches()[1]?.getAttribute('aria-checked')} host=${(await snapNow()).recovery.autoContinue}`)
  check('a saved recovery switch is reported as saved',
    mgContainer.querySelector('.llmm-dlg-note')?.textContent !== '',
    mgContainer.querySelector('.llmm-dlg-note')?.textContent ?? '')
  // ── the budgets beside the switch are numbers, and only whole numbers are sent ──
  // A policy the dialog exposes has to survive the trip as a number: a boolean switch
  // and a numeric budget share one action, so coercion here would silently save `true`.
  const policyNumbers = () => [...mgContainer.querySelectorAll('.llmm-policy .llmm-policy-num')]
  check('the failover tab exposes the recovery budgets as numbers',
    policyNumbers().length === 3
      && policyNumbers().every(node => node.getAttribute('type') === 'number' && (node.getAttribute('aria-label') ?? '') !== ''),
    `${policyNumbers().length} input(s)`)
  check('a budget input starts on what the Host reports',
    policyNumbers()[0]?.value === String((await snapNow()).recovery.maxSwitches),
    `${policyNumbers()[0]?.value} vs ${(await snapNow()).recovery.maxSwitches}`)

  const budgets = []
  const realFetchBudget = globalThis.fetch
  globalThis.fetch = async (request, init) => {
    try {
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (body.action === 'setRecovery') budgets.push(body)
    } catch { /* not ours */ }
    return realFetchBudget(request, init)
  }
  const typeBudget = async (node, value) => {
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    await act(async () => {
      setValue.call(node, value)
      node.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)) })
  }
  try {
    await typeBudget(policyNumbers()[0], '2')
    check('a budget input writes the number it holds, not a flag',
      budgets.length === 1 && budgets[0].maxSwitches === 2,
      JSON.stringify(budgets))
    check('a written budget comes back from the Host',
      (await snapNow()).recovery.maxSwitches === 2,
      String((await snapNow()).recovery.maxSwitches))
    const beforeRefusal = budgets.length
    await typeBudget(policyNumbers()[0], '99')
    check('a budget outside its range is refused before it is sent',
      budgets.length === beforeRefusal && (mgContainer.querySelector('.llmm-dlg-err')?.textContent ?? '') !== '',
      `${budgets.length - beforeRefusal} request(s), err=${mgContainer.querySelector('.llmm-dlg-err')?.textContent ?? ''}`)
  } finally {
    globalThis.fetch = realFetchBudget
  }
  await typeBudget(policyNumbers()[0], '2')
  check('a budget typing the value it already holds sends nothing',
    budgets.length === 1,
    JSON.stringify(budgets))
  await typeBudget(policyNumbers()[0], '3')
  check('a budget can be put back to its default', (await snapNow()).recovery.maxSwitches === 3,
    String((await snapNow()).recovery.maxSwitches))
  await act(async () => {
    policySwitches()[1]?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await waitFor(() => policySwitches()[1]?.getAttribute('aria-checked') === 'true')
  })
  const candidate = `${ROUTE}/${MODELS[1]}`
  await act(async () => {
    mgContainer.querySelector('.llmm-fb-pick')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await waitFor(() => mgContainer.querySelector('.llmm-fb-pop') !== null)
  })
  const pickOptions = () => [...mgContainer.querySelectorAll('.llmm-fb-pop .llmm-fb-opt')]
  check('the candidate list names a status for every model',
    pickOptions().length > 0 && pickOptions().every(option => option.querySelector('.llmm-dot') !== null && option.querySelector('.llmm-fb-opt-flag')?.textContent !== ''),
    `${pickOptions().length} option(s), flags=${pickOptions().map(option => option.querySelector('.llmm-fb-opt-flag')?.textContent).join('|')}`)
  check('the candidate list leads with a route that answered',
    pickOptions()[0] !== undefined && pickOptions()[0].classList.contains('llmm-fb-opt-bad') === false,
    pickOptions()[0]?.className ?? 'no options')
  await act(async () => {
    const search = mgContainer.querySelector('.llmm-fb-pop-search')
    if (search !== null) {
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setValue.call(search, MODELS[1])
      search.dispatchEvent(new window.Event('input', { bubbles: true }))
      await waitFor(() => pickOptions().length > 0 && pickOptions().length < 80)
    }
  })
  const narrowed = pickOptions()
  check('searching the candidate list narrows it', narrowed.length > 0 && narrowed.length < 80,
    `${narrowed.length} of 80`)
  await act(async () => {
    const target = pickOptions().find(option => option.textContent.includes(MODELS[1]))
    target?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  check('picking a candidate names it on the trigger',
    mgContainer.querySelector('.llmm-fb-pick-label')?.textContent === candidate,
    mgContainer.querySelector('.llmm-fb-pick-label')?.textContent ?? 'no label')
  check('picking a candidate closes the list', mgContainer.querySelector('.llmm-fb-pop') === null,
    mgContainer.querySelector('.llmm-fb-pop') === null ? 'closed' : 'still open')
  await act(async () => {
    mgContainer.querySelector('.llmm-fb-commit')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await waitFor(() => mgContainer.querySelectorAll('.llmm-fb-item').length === 1)
  })
  check('a candidate can be added to the chain', mgContainer.querySelectorAll('.llmm-fb-item').length === 1,
    `${mgContainer.querySelectorAll('.llmm-fb-item').length} item(s)`)
  check('the chain is drafted until saved',
    (await hostJson({ action: 'fallbackConfig' })).value.chain.length === 0,
    `chain=${JSON.stringify((await hostJson({ action: 'fallbackConfig' })).value.chain)}`)
  await act(async () => {
    mgContainer.querySelector('.llmm-fb-check .llmm-dlg-btn')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await waitFor(() => mgContainer.querySelectorAll('.llmm-fb-results li').length > 0)
  })
  check('checking the chain reports one line per candidate',
    mgContainer.querySelectorAll('.llmm-fb-results li').length === 1,
    mgContainer.querySelector('.llmm-fb-results')?.textContent ?? 'no results')
  await act(async () => {
    saveButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await waitFor(() => mgContainer.querySelector('.llmm-dlg-dirty') === null)
  })
  const savedChain = (await hostJson({ action: 'fallbackConfig' })).value.chain
  check('saving writes the drafted chain', savedChain.length === 1 && savedChain[0] === candidate,
    `${JSON.stringify(savedChain)} want=${candidate} err=${mgContainer.querySelector('.llmm-dlg-err')?.textContent ?? '-'} note=${mgContainer.querySelector('.llmm-dlg-note')?.textContent ?? '-'}`)

  // ── the two surfaces that read as broken without their own chrome ──
  const sheetText = () => document.querySelector('style[data-llmm-style]')?.textContent ?? ''
  check('the shortcut hint is standing, not hover-only',
    /\.llmm-ctl-key\{[^}]*opacity:\.75/.test(sheetText()) && !/\.llmm-ctl-key\{[^}]*opacity:0/.test(sheetText()),
    /opacity:\.75/.test(sheetText()) ? 'standing' : 'hover-gated')
  check('dialog buttons carry their own chrome instead of the browser face',
    /\.llmm-dlg-btn\{[^}]*border:0\.5px solid var\(--dsw-alias-border-l3\)/.test(sheetText())
      && /\.llmm-dlg-btn-primary\{[^}]*background:var\(--dsw-alias-button-primary-fill\)/.test(sheetText()),
    /\.llmm-dlg-btn\{[^}]*border:0\.5px solid/.test(sheetText()) ? 'chrome' : 'browser default')

  // ── the probe log tab ──
  await act(async () => {
    tabs()[3]?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await waitFor(() => mgContainer.querySelector('.llmm-mg-record') !== null
      || mgContainer.querySelector('.llmm-mg-empty') !== null)
  })
  const logRendered = mgContainer.querySelectorAll('.llmm-mg-record').length
  check('the probe log tab renders what the Host recorded',
    mgContainer.querySelector('.llmm-mg-record') !== null || mgContainer.querySelector('.llmm-mg-empty') !== null,
    `${logRendered} record(s)`)

  // ── the switch history tab ──
  // The question it answers is "which model keeps failing", so the aggregate comes
  // first and is ordered by that count; the raw events sit below it as evidence.
  // A Host answer lands in a promise, so the render it triggers is not visible to a
  // synchronous predicate poll: give the request its tick before reading the DOM.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60))
  await act(async () => {
    tabs()[2]?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  await settle()
  const swRows = () => Array.from(mgContainer.querySelectorAll('.llmm-sw-models .llmm-sw-row'))
  // The list collapses each burst of retries into one incident card, so the raw rows
  // only exist once the card is opened. Opening every card is the honest way to read
  // them: the assertions are about the rows, not about the default collapsed state.
  const swIncidents = () => Array.from(mgContainer.querySelectorAll('.llmm-sw-inc'))
  const openIncidents = async () => {
    // Re-queried every round: React replaces the head nodes when one of them opens, so a
    // snapshot of the list would dispatch clicks at detached nodes and open exactly one.
    for (let guard = 0; guard < 12; guard += 1) {
      const head = [...mgContainer.querySelectorAll('.llmm-sw-inc-head')]
        .find(node => node.getAttribute('aria-expanded') !== 'true')
      if (head === undefined) return
      await act(async () => {
        head.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      })
    }
  }
  const swEvents = () => Array.from(mgContainer.querySelectorAll('.llmm-sw-event'))
  check('the switch history tab aggregates the models that triggered a switch',
    swRows().length === 3, `${swRows().length} model row(s): ${swRows().map(r => r.textContent).join(' | ')}`)
  check('the model that keeps failing is named first, with its count',
    /seeded-flaky/.test(swRows()[0]?.textContent ?? '')
      && /^2$/.test((swRows()[0]?.querySelector('.llmm-sw-count')?.textContent ?? '').trim()),
    swRows()[0]?.textContent ?? 'no rows')
  check('every aggregate separates the switches that recovered from those that did not',
    swRows().every(row => /已接管|took over/.test(row.textContent ?? '')
      && /未接管|did not take over/.test(row.textContent ?? '')), swRows()[0]?.textContent ?? 'no rows')
  check('the recent switches collapse into one card per incident',
    swIncidents().length === 3
      && swIncidents().filter(card => /2\s*(步|steps)/.test(card.textContent ?? '')).length === 1,
    `${swIncidents().length} card(s): ${swIncidents().map(c => c.textContent.slice(0, 40)).join(' | ')}`)
  await openIncidents()
  check('the raw switches are kept beside the aggregate',
    swEvents().length === 4 && swEvents().every(row => row.textContent.includes('\u2192')),
    `${swEvents().length} event(s)`)
  check('the tab says what it records and why it can be cleared',
    /只记录已经证实的切换|Only proven switches/.test(mgContainer.querySelector('.llmm-sw-note')?.textContent ?? ''),
    mgContainer.querySelector('.llmm-sw-note')?.textContent ?? 'no note')
  // Whether the work was picked back up cannot be read off the counts above: a switch
  // that moved the session and one that rescued the run look identical there. The row
  // states it, because it is the difference the person feels.
  const continuedChips = () => Array.from(mgContainer.querySelectorAll('.llmm-sw-event .llmm-sw-continued'))
  check('every recorded switch states whether the work was continued',
    continuedChips().length === 4, `${continuedChips().length} chip(s) of 4 event(s)`)
  check('a continued repair is marked as recovered, a refused one as not',
    /已继续|continued/i.test(continuedChips()[0]?.textContent ?? '')
      && !/未继续|not continued/i.test(continuedChips()[0]?.textContent ?? '')
      && /未继续|not continued/i.test(continuedChips()[1]?.textContent ?? ''),
    continuedChips().map(node => node.textContent).join(' | '))
  check('the refusal reason is kept on the chip instead of spent on a line',
    /already continued/.test(continuedChips()[1]?.getAttribute('title') ?? ''),
    continuedChips()[1]?.getAttribute('title') ?? 'no title')
  // A switch happened inside a Session, and the row is the only place a reader can go
  // and look at it: the label comes from the shipped projection (the log stores the id
  // it saw, not a name that may since have been renamed).
  const chips = () => Array.from(mgContainer.querySelectorAll('.llmm-sw-event .llmm-sw-session'))
  check('every switch names the Session it happened in',
    chips().length === 4, `${chips().length} session chip(s) of 4 event(s)`)
  check('the Session label is the name the shell shows, not the raw id',
    (chips()[0]?.textContent ?? '') === 'Retry storm on the API',
    chips()[0]?.textContent ?? 'no chip')
  check('a Session the shell no longer lists still identifies itself by id',
    (chips()[2]?.textContent ?? '') === 'sess-seed-c'.slice(0, 8),
    chips()[2]?.textContent ?? 'no chip')
  check('the aggregate counts the Sessions a model failed in',
    /2\s*(个会话|sessions)/.test(swRows()[0]?.textContent ?? ''),
    swRows()[0]?.textContent ?? 'no rows')

  // One navigation action, the same call the shipped sidebar makes. Leaving also
  // closes the dialog, so a reader lands on the Session rather than behind a modal.
  await act(async () => {
    chips()[0]?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
  })
  check('clicking the Session opens it and closes the manager behind it',
    navigations.length === 1 && navigations[0] === 'sess-seed-a' && dlg() === null,
    `${JSON.stringify(navigations)}, dialog=${dlg() === null ? 'closed' : 'open'}`)

  // A client without the workspace face has no navigation to offer. The name must
  // then read as a fact, not as a control that answers nothing.
  await act(async () => {
    mgRoot.render(React.createElement(managerSlot.Component, {
      useSessions: sessionRows,
      canOpenSession: () => false,
    }))
    await settle()
  })
  await openFromPicker()
  await act(async () => {
    tabs()[2]?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
  })
  await openIncidents()
  check('without a navigator the Session is named, not offered as a dead link',
    chips()[0]?.tagName === 'SPAN' && /flat/.test(chips()[0]?.className ?? ''),
    `${chips()[0]?.tagName ?? 'missing'} ${chips()[0]?.className ?? ''}`)
  await act(async () => {
    mgContainer.querySelector('.llmm-sw-clear')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  await settle()
  const afterClear = (await hostJson({ action: 'failoverHistory' })).value
  check('the history can be cleared, and clearing it is durable',
    mgContainer.querySelector('.llmm-sw-event') === null && afterClear.records.length === 0,
    `${afterClear.records.length} record(s) left on the Host`)

  // ── taking a model out of the catalog ──
  // A model the gateway has withdrawn cannot be usefully listed: it occupies a row,
  // it can be picked as a fallback target, and every probe of it is a known failure.
  await act(async () => {
    tabs()[0]?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  await settle()
  check('the catalog comes back when its tab is chosen again', rows().length > 0, `${rows().length} row(s)`)
  const doomed = MODELS[0]
  await act(async () => {
    rowFor(doomed)?.querySelector('.llmm-mg-main')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  check('an expanded row offers to take the model out of the catalog',
    rowFor(doomed)?.querySelector('.llmm-mg-remove') !== null, 'no removal control')
  await act(async () => {
    rowFor(doomed)?.querySelector('.llmm-mg-remove')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  await settle()
  check('removing a model drops its row', rowFor(doomed) === undefined,
    `${rows().length} row(s) left of ${MODELS.length}`)
  check('the removal is undone from the same tab instead of being buried elsewhere',
    (mgContainer.querySelector('.llmm-mg-removed')?.textContent ?? '').includes(doomed),
    mgContainer.querySelector('.llmm-mg-removed')?.textContent ?? 'no removed section')
  await act(async () => {
    mgContainer.querySelector('.llmm-mg-restore')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  await settle()
  check('restoring puts the row back', rowFor(doomed) !== undefined && rows().length === MODELS.length,
    `${rows().length} row(s) for ${MODELS.length} model(s)`)

  await act(async () => {
    dlg()?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await waitFor(() => dlg() === null)
  })
  check('Escape closes the manager', dlg() === null)

  // A host that booted before these actions existed is a state this plugin has
  // actually been in: a browser refresh reloads the client half, the process
  // keeps the copy it started with. The dialog must name that instead of
  // presenting an empty policy as if nothing were configured.
  const healthyFetch = globalThis.fetch
  const staleCalls = []
  globalThis.fetch = async (url, init) => {
    const action = String(url).includes('llm-manage') ? JSON.parse(init?.body ?? '{}').action : ''
    staleCalls.push(action)
    if (action === 'fallbackConfig') {
      return {
        ok: false,
        status: 400,
        json: async () => ({ ok: false, message: 'unknown action "fallbackConfig"' }),
      }
    }
    return healthyFetch(url, init)
  }
  if (pickerMenu() !== null) {
    await act(async () => {
      mgPickerContainer.querySelector('.llmm-trigger')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => pickerMenu() === null)
    })
  }
  await openFromPicker()
  // The notice arrives from a rejected request, so it lands a tick after mount.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  const staleNotice = await waitFor(() => mgContainer.querySelector('.llmm-dlg-stale') !== null, 2000)
  check('a stale host is named rather than shown as an empty policy', staleNotice,
    mgContainer.querySelector('.llmm-dlg-stale')?.textContent
      ?? `open=${mgContainer.querySelector('.llmm-dlg') !== null} calls=${staleCalls.join(',')}`)
  globalThis.fetch = healthyFetch
  await act(async () => {
    mgContainer.querySelector('.llmm-dlg-head .llmm-dlg-close')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await waitFor(() => dlg() === null)
  })

  // Re-pulling belongs at the end of this block: it changes what the catalogue says
  // about a model, and every assertion above describes the catalogue as the gateway
  // first listed it.
  await openFromPicker()
  const pullButton = () => mgContainer.querySelector('.llmm-dlg-head .llmm-dlg-pull')
  const stampLines = () => Array.from(mgContainer.querySelectorAll('.llmm-mg-dirs .llmm-mg-dir'))
  // Only routes that actually answered get a stamp. The built-in and adapter routes
  // have no directory endpoint at all: reporting that once per route turned one fact
  // into a wall of "unavailable", so the count is pinned to the readable routes and
  // the line is forbidden from apologising for the rest.
  const readableRoutes = (await snapNow()).directory.filter(entry => entry.ok === true)
  const stampText = () => mgContainer.querySelector('.llmm-mg-dirs')?.textContent ?? ''
  check('the catalog says which directory it read and how old that reading is',
    stampLines().length > 0 && stampLines().length === readableRoutes.length,
    `${stampLines().length} stamp(s) of ${readableRoutes.length} readable route(s)`)
  check('a route with no directory endpoint is left out, not reported as a failure',
    stampLines().length === readableRoutes.length && !/不可用|unavailable/i.test(stampText()),
    `stamps=${stampLines().length}/${readableRoutes.length} text=${stampText().slice(0, 120)}`)
  check('the header offers a re-pull, named for a screen reader',
    pullButton() !== null && (pullButton().getAttribute('aria-label') ?? '').length > 0,
    pullButton() === null ? 'no button' : pullButton().getAttribute('aria-label'))

  // The directory has a 30-minute cache, so "did this bypass it" is only provable at
  // the request. The same wrapper makes the gateway answer as if a model had been
  // retired, which is the situation the control exists for.
  const truthFetch = globalThis.fetch
  const listed = (await snapNow()).models.filter(entry => entry.status !== 'retired')
  const dropped = listed[listed.length - 1].model
  const pulls = []
  let dropNow = false
  globalThis.fetch = async (request, init) => {
    let body = {}
    try { body = JSON.parse(init?.body ?? '{}') } catch { body = {} }
    if (body.action === 'snapshot') pulls.push(body.forceDirectory === true)
    let url = ''
    try { url = typeof request === 'string' ? request : request?.url ?? String(request) } catch { url = '' }
    if (dropNow !== true || !url.includes('/models')) return truthFetch(request, init)
    const response = await truthFetch(request, init)
    const parsed = await response.json().catch(() => null)
    if (parsed === null) return response
    const source = Array.isArray(parsed.data) ? parsed.data : Array.isArray(parsed.models) ? parsed.models : []
    const kept = source.filter(row => (typeof row === 'string' ? row : row?.id) !== dropped)
    return new Response(JSON.stringify({ ...parsed, data: kept }),
      { status: 200, headers: { 'content-type': 'application/json' } })
  }
  dropNow = true
  await act(async () => { pullButton()?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  const pullSaid = await waitFor(() => {
    const text = mgContainer.querySelector('.llmm-dlg-note')?.textContent ?? ''
    return /重新拉取|Re-pulled/i.test(text)
  }, 8000)
  const pullNote = mgContainer.querySelector('.llmm-dlg-note')?.textContent ?? ''
  globalThis.fetch = truthFetch
  dropNow = false
  check('re-pulling bypasses the cached directory read',
    pulls.includes(true), JSON.stringify(pulls))
  const pullErr = mgContainer.querySelector('.llmm-dlg-err')?.textContent ?? ''
  check('re-pulling reports what came back', pullSaid,
    `note=${pullNote === '' ? 'none' : pullNote} err=${pullErr === '' ? 'none' : pullErr} reads=${JSON.stringify(pulls)}`)
  check('a model the gateway stopped listing is named, not counted',
    pullNote.includes(dropped), `note=${pullNote} dropped=${dropped}`)

  await act(async () => { mgRoot.unmount() })
  await act(async () => { mgPickerRoot.unmount() })
  mgPickerContainer.remove()
  mgContainer.remove()
}

await act(async () => { root.unmount() })
rmSync(HOME, { recursive: true, force: true })

const failed = results.filter(r => !r.passed)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
