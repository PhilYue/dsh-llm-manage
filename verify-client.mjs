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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'CustomEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'AbortController']) {
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
const hostGet = (k) => {
  if (k === 'connection') return connection
  if (k === 'llm') return llmService
  if (k === 'settings') return { describe: () => [{ ns: SETTINGS_NS, autoInitialize: false, schema: {}, revision: 1, applies: 'live', value: SETTINGS, base: SETTINGS, user: SETTINGS }] }
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
const sortButtons = () => Array.from(container.querySelectorAll('.llmm-sortbtn'))
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
const expectedRows = snapshot.groups.reduce(
  (total, group) => total + group.rows.filter(row => !row.hidden).length, 0,
)
check('every listed model is still offered exactly once',
  [...counts.values()].reduce((a, b) => a + b, 0) === expectedRows,
  `${[...counts.values()].reduce((a, b) => a + b, 0)} rows for ${expectedRows} listed`)

// A section whose rows span routes has to name them: the same model id on two
// routes is two different selections, and the lifted row is no longer under its
// route's heading to say which one it is. A section that stays on one route must
// NOT name routes, or the label is noise on every row.
const pinnedSection = pinnedAt >= 0 ? open[pinnedAt] : { items: [] }
const mirrorRow = pinnedSection.items.find(row => row.name === mirroredPin && row.route === SECOND_ROUTE)
check('a lifted row from another route names its route', mirrorRow !== undefined && mirrorRow.route === SECOND_ROUTE,
  JSON.stringify(mirrorRow ?? null))
const favoriteSection = favoritesAt >= 0 ? open[favoritesAt] : { items: [] }
check('a lifted section on one route names none',
  favoriteSection.items.length > 0 && favoriteSection.items.every(row => row.route === ''),
  favoriteSection.items.map(row => `${row.name}${row.route === '' ? '' : `[${row.route}]`}`).join(', '))

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
  && (declarationsOf('.llmm-banner b')?.['font-family'] ?? '') === 'var(--ds-font-family-code)',
  `name=${declarationsOf('.llmm-name')?.['font-family']} banner=${declarationsOf('.llmm-banner b')?.['font-family']}`)

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
check('nothing paints a surface directly from the overlay scrim token',
  (cssText.match(/background:\s*var\(--dsw-alias-bg-overlay\)/g) ?? []).length === 0,
  `${(cssText.match(/background:\s*var\(--dsw-alias-bg-overlay\)/g) ?? []).length} rule(s)`)

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
const mirrorButton = pinnedBody === null
  ? null
  : Array.from(pinnedBody.querySelectorAll('.llmm-item'))
    .find(item => item.querySelector('.llmm-route')?.textContent === SECOND_ROUTE)
const selectionBefore = selections.length
if (mirrorButton !== null) {
  await act(async () => {
    mirrorButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await waitFor(() => selections.length > selectionBefore)
  })
}
check('clicking a section row selects that row\'s own route and model',
  mirrorButton !== null
  && selections.length === selectionBefore + 1
  && selections[selectionBefore].provider === SECOND_ROUTE
  && selections[selectionBefore].model === mirroredPin,
  mirrorButton === null
    ? 'the Pinned section offered no row naming another route'
    : JSON.stringify(selections[selectionBefore] ?? null))

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

await act(async () => { root.unmount() })
rmSync(HOME, { recursive: true, force: true })

const failed = results.filter(r => !r.passed)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
