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
import { mkdtempSync, rmSync } from 'node:fs'
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
const connection = { fetch: { register: (r) => { routes.push(r); return () => {} } } }
const llmService = {
  listProviders: () => [{ id: ROUTE, name: DISPLAY_NAME }],
  listConfigurableProviders: () => [{ provider: ROUTE, displayName: DISPLAY_NAME, settingsNs: SETTINGS_NS, settingsPath: ['providers', ROUTE] }],
  listModels: async () => MODELS.map(id => ({ id, name: id })),
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
const slots = []
window.__ModuleLoader__ = {
  load: ({ id, factory }) => {
    if (id !== 'dsh-llm-manage') throw new Error(`unexpected module id "${id}"`)
    captured = factory((name) => {
      if (name === 'react') return React
      throw new Error(`client.js required unavailable module "${name}"`)
    })
  },
}
let captured
await import(pathToFileURL(join(HERE, 'client.js')).href)
if (captured === undefined) throw new Error('client.js did not call __ModuleLoader__.load')

const clientCtx = {
  slots: {
    inject: (_key, callback) => { callback() },
    register: (options, Component) => { slots.push({ options, Component }); return () => {} },
  },
  modelDirectories: { directoryFor: () => ({ store: {}, load: async () => {}, select: async () => ({ ok: true, value: undefined }) }) },
  sessions: { subagentAddress: () => undefined },
}
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

await act(async () => { root.unmount() })
rmSync(HOME, { recursive: true, force: true })

const failed = results.filter(r => !r.passed)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
