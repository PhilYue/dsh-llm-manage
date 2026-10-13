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
  await waitFor(() => pickerContainer.querySelector('.llmm-menu-body') !== null)
})

/** The menu's sections, in render order, with each section's row labels. */
const pickerSections = () => {
  const body = pickerContainer.querySelector('.llmm-menu-body')
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
/** One rule's declarations, matched by exact selector text. */
const declarationsOf = (selector) => {
  for (const chunk of cssText.split('}')) {
    const brace = chunk.indexOf('{')
    if (brace === -1) continue
    if (chunk.slice(0, brace).trim() === selector) {
      return Object.fromEntries(chunk.slice(brace + 1).trim().split(';').filter(Boolean).map((entry) => {
        const colon = entry.indexOf(':')
        return [entry.slice(0, colon).trim(), entry.slice(colon + 1).trim()]
      }))
    }
  }
  return null
}
const panelRow = declarationsOf('.llmm-row')
const pickerRow = declarationsOf('.llmm-item')
const boxProperties = ['display', 'align-items', 'gap', 'padding', 'border-radius', 'border']
const mismatch = panelRow === null || pickerRow === null
  ? 'a rule was not found in the rendered stylesheet'
  : boxProperties.filter(key => panelRow[key] !== pickerRow[key])
    .map(key => `${key}: panel "${panelRow[key]}" vs picker "${pickerRow[key]}"`).join('; ')
check('a picker row is laid out exactly like a panel row', mismatch === '',
  mismatch || boxProperties.map(key => `${key}=${pickerRow[key]}`).join(' '))

const hoverMismatch = ['background', 'border-color'].filter(key =>
  declarationsOf('.llmm-row:hover')[key] !== declarationsOf('.llmm-item:hover')[key])
check('a picker row reacts to hover exactly like a panel row', hoverMismatch.length === 0,
  hoverMismatch.join(', ') || declarationsOf('.llmm-item:hover')['background'])

const panelDim = declarationsOf('.llmm-row.llmm-hidden').opacity
const pickerDim = declarationsOf('.llmm-item.llmm-down').opacity
check('both surfaces dim a de-emphasised row by the same amount', panelDim === pickerDim,
  `panel ${panelDim} vs picker ${pickerDim}`)

// Keyboard focus is the one interaction the panel states explicitly, on its icon
// buttons; the picker's rows are the interactive element there, so they owe the
// same outline rather than the browser default.
check('a picker row shows the same focus ring as the panel\'s controls',
  declarationsOf('.llmm-item:focus-visible')?.['outline']
    === declarationsOf('.llmm-ibtn:focus-visible')?.['outline'],
  `${declarationsOf('.llmm-item:focus-visible')?.['outline']}`)

// Section headings are structural labels, so they take the panel's secondary-label
// treatment. The panel reserves the brand color for state (an active control), and a
// tinted heading would be the one place the two surfaces disagreed about that.
check('section headings use the panel\'s heading treatment, not the brand color',
  declarationsOf('.llmm-group')?.color === 'var(--dsw-alias-label-secondary)'
  && declarationsOf('.llmm-group')?.['font-weight'] === '600'
  && cssText.includes('.llmm-accent') === false,
  `color=${declarationsOf('.llmm-group')?.color} weight=${declarationsOf('.llmm-group')?.['font-weight']} accentRule=${cssText.includes('.llmm-accent')}`)

// The route label is the same kind of annotation as the panel's "also on" chip, so
// it must be that chip rather than look like one. Asserted on the DOM, because a
// check comparing .llmm-route's declarations against .llmm-chip's would pass even
// if the two were unrelated — .llmm-route declares almost nothing of its own.
const routeNodes = Array.from(pickerContainer.querySelectorAll('.llmm-route'))
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
const menuBody = pickerContainer.querySelector('.llmm-menu-body')
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
  if (pickerContainer.querySelector('.llmm-input') === null) {
    await act(async () => {
      pickerContainer.querySelector('.llmm-trigger').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => pickerContainer.querySelector('.llmm-input') !== null)
    })
  }
}

// Reopening and searching must filter across the lifted sections too, not just
// the route groups below them.
await ensureOpen()
await act(async () => {
  const input = pickerContainer.querySelector('.llmm-input')
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

await act(async () => { root.unmount() })
rmSync(HOME, { recursive: true, force: true })

const failed = results.filter(r => !r.passed)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
