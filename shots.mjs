/**
 * dsh-llm-manage — regenerate the images the README and the plugin marketplace show.
 *
 *   node shots.mjs            # writes docs/picker.png, docs/manager.png, docs/switches.png
 *   node shots.mjs --only picker
 *
 * Why this exists instead of `screenshot.mjs`: that one photographs a RUNNING Harness,
 * which needs the per-process token and therefore produces the maintainer's own route
 * names and model inventory — exactly the content a public README must not contain.
 * This script instead drives the REAL `client.js` inside a real engine with the real
 * theme tokens (the same mirrored block `verify-browser.mjs` uses, values measured from
 * the app) and an invented catalogue. So the picture is the shipped rendering, of data
 * that is ours to publish.
 *
 * The images are therefore "synthetic but not mocked": no component is stubbed, no
 * colour is invented. `check-publication.mjs` still OCRs them against the same term list
 * as every text gate, which is why nothing here may name a real route or model.
 */
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DH = process.env.DSH_CHECKOUT ?? ''
if (DH === '' || !existsSync(join(DH, 'package.json'))) {
  console.log('SKIP  set DSH_CHECKOUT to the deepseek-harness checkout to render the images')
  process.exit(0)
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(candidate => typeof candidate === 'string' && candidate !== '')
const chrome = CHROME_CANDIDATES.find(candidate => existsSync(candidate))
if (chrome === undefined) {
  console.log('SKIP  no Chrome-family browser found; set CHROME_PATH to render the images')
  process.exit(0)
}
const REACT = join(DH, 'node_modules/.pnpm/react@18.3.1/node_modules/react/umd/react.development.js')
const REACT_DOM = join(DH, 'node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/umd/react-dom.development.js')
for (const [label, path] of [['react', REACT], ['react-dom', REACT_DOM]]) {
  if (!existsSync(path)) {
    console.log(`SKIP  ${label} UMD build not found at ${path}`)
    process.exit(0)
  }
}

const SCENES = {
  picker: { size: [460, 620], only: 'picker', cardHeight: 588 },
  manager: { size: [1080, 820], only: 'manager' },
  switches: { size: [1080, 820], only: 'switches' },
  panel: { size: [820, 900], only: 'panel' },
}
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined

const page = (scene, forcedHeight = 0) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root{--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#fff;
    --dsw-alias-bg-layer-3:#fff;--dsw-alias-bg-overlay:#e9ecf2;
    --dsw-alias-border-l1:rgba(0,0,0,.04);--dsw-alias-border-l2:rgba(0,0,0,.1);
    --dsw-alias-border-l3:rgba(0,0,0,.12);--dsw-alias-border-l4:rgba(0,0,0,.16);
    --dsw-alias-brand-primary:#0f1115;--dsw-alias-state-business-primary:#4176e6;
    --dsw-alias-label-primary:#0f1115;--dsw-alias-label-secondary:#61666b;
    --dsw-alias-label-tertiary:#81858c;--dsw-alias-label-caption:#adb2b8;
    --dsw-alias-label-dimmed:#e1e5ee;--dsw-alias-menu-icon:#353638;
    --dsw-alias-state-error-primary:#ec1313;--dsw-alias-state-idle-primary:#d4d4d4;
    --dsw-alias-state-success-primary:#22c55e;--dsw-alias-state-warn-primary:#f59e0b;
    --dsw-alias-interactive-bg-hover:rgba(38,49,72,.06);
    --dsw-alias-interactive-bg-hover-danger:rgba(236,19,19,.05);
    --dsw-alias-scrollbar-bg-l2:#e5e5e5;--dsw-alias-scrollbar-hover-l2:#d4d4d4;
    --dsw-alias-scrollbar-bg-l1:#e5e5e5;--dsw-alias-scrollbar-hover-l1:#d4d4d4;
    --dsw-alias-tooltip-bg:#2c2c2e;--dsw-alias-bg-module-platform:#f5f6f7;
    --dsw-alias-state-warn-label:#dd8629;--dsw-focus-ring-color:transparent;
    --dsw-alias-settings-card-fill:#fff;--dsw-alias-settings-card-stroke:rgba(0,0,0,.16);
    --ds-font-family-code:ui-monospace,SFMono-Regular,Menlo,monospace;
    --dsw-radius-xs:4px;--dsw-radius-sm:8px;--dsw-radius-md:12px;--dsw-radius-lg:16px;
    --dsw-radius-xl:20px;
    --dsw-alias-bg-mask-1:rgba(0,0,0,.24);--dsw-mask-blur:none;--dsw-radius-panel:28px;
    --dsw-specific-menu:#fff;--dsw-elevation-prominent:0 12px 40px rgba(0,0,0,.18);
    --dsw-elevation-stroke-color:rgba(0,0,0,.04);--dsw-menu-backdrop-filter:none;
    --dsw-alias-button-primary-fill:rgb(15,17,21);
    --dsw-alias-button-primary-hover:rgb(67,69,74);
    --dsw-alias-label-primary-foreground:rgb(255,255,255);}
  html,body{margin:0;height:100%}
  body{background:var(--dsw-alias-bg-module-platform);
    font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;
    color:var(--dsw-alias-label-primary);-webkit-font-smoothing:antialiased}
  #stage{display:flex;align-items:flex-start;justify-content:center;padding:24px 16px}
  .llmm-panel{max-width:none}
  #stage.drawer{align-items:center;padding:0}
</style></head><body>
<script>${REACT_SOURCE}</script>
<script>${REACT_DOM_SOURCE}</script>
<script>
  var ROUTE = 'example-route'
  var NOW = Date.now()
  var MIN = 60000
  function row(model, extra) {
    return Object.assign({ route: ROUTE, favorite: false, pinned: false, hidden: false,
      status: 'ok', reason: 'answered a minimal request', source: 'probe', scope: 'model',
      at: NOW - 2 * MIN, inDirectory: true, levels: { accepted: ['low', 'medium', 'high'],
        declared: ['low', 'medium', 'high'] } }, extra, { model: model })
  }
  function usage(uses, level, next, progress, trend, recent, prior) {
    return { uses: uses, attempts: uses, inputTokens: uses * 920, outputTokens: uses * 208,
      firstAt: NOW - 40 * 24 * 60 * MIN, lastAt: NOW - 3 * MIN, level: level, manual: false,
      nextAt: next, progress: progress, heat: 12 + uses / 40, recent7: recent, prior7: prior,
      trend: trend, seeded: false }
  }
  // An invented catalogue: two routes, one shared model, one bad row, one retired row.
  var rows = [
    row('model-alpha', { pinned: true, usage: usage(214, 5, 500, 0.36, 'up', 36, 31) }),
    row('model-beta', { pinned: true, usage: usage(168, 4, 200, 0.79, 'up', 25, 16) }),
    row('model-gamma', { favorite: true, usage: usage(96, 4, 200, 0.35, 'up', 7, 3) }),
    row('model-delta', { usage: usage(41, 3, 80, 0.29, 'down', 6, 11) }),
    row('model-epsilon', { usage: usage(12, 2, 30, 0.21, 'flat', 2, 2) }),
    row('model-zeta', { status: 'retired', source: 'directory', inDirectory: false,
      reason: 'not listed by the gateway directory' }),
  ]
  var SHARED = 'Shared-Model'
  rows.push(row(SHARED, { pinned: true }))
  var mirrorRows = [row(SHARED, { route: 'mirror-route', pinned: true }),
    row('Mirror-Model', { route: 'mirror-route', pinned: true })]
  rows[6].alsoOn = ['Mirror']
  mirrorRows[0].alsoOn = ['Example Gateway']
  var byModel = {}
  ;[['Example Gateway', rows], ['Mirror', mirrorRows]].forEach(function (pair) {
    pair[1].forEach(function (r) {
      var entry = byModel[r.model] || (byModel[r.model] = { model: r.model, name: r.model,
        routes: [], pinned: false, favorite: false, hidden: false, usage: null })
      entry.routes.push(Object.assign({}, r, { name: pair[0] }))
      entry.pinned = entry.pinned || r.pinned === true
      entry.favorite = entry.favorite || r.favorite === true
      if (r.usage) entry.usage = r.usage
    })
  })
  var models = Object.keys(byModel).map(function (key) {
    var entry = byModel[key]
    var first = entry.routes[0]
    return Object.assign({}, entry, { primary: first.route, status: first.status,
      reason: first.reason, source: first.source, scope: first.scope, at: first.at,
      inDirectory: first.inDirectory, levels: first.levels })
  })
  var SNAPSHOT = { models: models, groups: [
      { route: ROUTE, name: 'Example Gateway',
        models: rows.map(function (r) { return r.model }), rows: rows },
      { route: 'mirror-route', name: 'Mirror',
        models: mirrorRows.map(function (r) { return r.model }), rows: mirrorRows }],
    directory: [{ route: ROUTE, ok: true, count: 7, at: NOW - 4000 }],
    fallback: { enabled: true, chain: [ROUTE + '/model-beta'] },
    recovery: { retryFirst: true, autoContinue: true, maxSwitches: 3, maxContinuations: 2,
      idleWaitMs: 1000 },
    removed: [], usageTop: [], usageTotals: { uses: 531, tokens: 1194 * 180 } }
  function failoverHistory() {
    var records = [
      { id: 'r1', at: NOW - 18 * MIN, sessionId: 'alpha-run', reason: 'error',
        detail: 'request failed', outcome: 'reached', continued: true,
        from: { route: 'free-route', model: 'model-epsilon' }, to: { route: ROUTE, model: 'model-alpha' } },
      { id: 'r2', at: NOW - 18 * MIN + 900, sessionId: 'alpha-run', reason: 'error',
        detail: 'request failed', outcome: 'reached', continued: true,
        from: { route: 'free-route', model: 'model-epsilon' }, to: { route: ROUTE, model: 'model-alpha' } },
      { id: 'r3', at: NOW - 55 * MIN, sessionId: 'alpha-run', reason: 'error',
        detail: 'request failed', outcome: 'reached', continued: true,
        from: { route: 'free-route', model: 'model-epsilon' }, to: { route: ROUTE, model: 'model-alpha' } },
      { id: 'r4', at: NOW - 3 * 60 * MIN, sessionId: 'beta-run', reason: 'quota',
        detail: 'quota exhausted', outcome: 'unreached', continued: false,
        continueRefused: 'already continued 2 time(s) for this request', legacy: false,
        from: { route: 'free-route', model: 'model-delta' }, to: { route: ROUTE, model: 'model-beta' } },
      { id: 'r5', at: NOW - 14 * 60 * MIN, sessionId: 'gamma-run', reason: 'unauthorized',
        detail: 'needs authorization', outcome: 'unreached', continued: false, legacy: true,
        from: { route: 'free-route', model: 'model-zeta' }, to: { route: ROUTE, model: 'model-gamma' } },
    ]
    return { records: records, models: [
      { model: 'model-epsilon', route: 'free-route', switches: 8, reached: 6, unreached: 2,
        elsewhere: 0, lastAt: NOW - 18 * MIN, sessions: 2, reasons: { error: 8 } },
      { model: 'model-delta', route: 'free-route', switches: 3, reached: 1, unreached: 2,
        elsewhere: 0, lastAt: NOW - 3 * 60 * MIN, sessions: 2, reasons: { quota: 2, error: 1 } },
      { model: 'model-zeta', route: 'free-route', switches: 1, reached: 0, unreached: 1,
        elsewhere: 0, lastAt: NOW - 14 * 60 * MIN, sessions: 1, reasons: { unauthorized: 1 } } ] }
  }
  var ANSWERS = {
    snapshot: SNAPSHOT,
    failoverHistory: failoverHistory(),
    defaultModel: { known: true, route: ROUTE, model: 'model-alpha', listed: true,
      removed: false, status: 'ok', unusable: false, suggestion: null },
    probeRecords: [],
    fallbackConfig: { enabled: true, chain: [ROUTE + '/model-beta'] },
    fallbackLog: null,
    selectorMode: { selectorMode: 'managed' },
    usage: null,
    badges: { badges: {} },
  }
  window.fetch = function (url, init) {
    var body = {}
    try { body = JSON.parse(init && init.body ? init.body : '{}') } catch (e) {}
    var action = body.action || new URL(String(url)).searchParams.get('action') || ''
    var value = Object.prototype.hasOwnProperty.call(ANSWERS, action) ? ANSWERS[action] : null
    return Promise.resolve(new Response(JSON.stringify({ ok: true, value: value }),
      { status: 200, headers: { 'content-type': 'application/json' } }))
  }
  document.documentElement.setAttribute('data-react', typeof window.React + '/' + typeof window.ReactDOM)
  var captured
  var PLATFORM = { 'react': window.React, 'react/jsx-runtime': window.React,
    'react-dom': window.ReactDOM, 'react-dom/client': window.ReactDOM }
  window.__ModuleLoader__ = { load: function (spec) {
    captured = spec.factory(function (name) {
      if (Object.prototype.hasOwnProperty.call(PLATFORM, name) && PLATFORM[name]) return PLATFORM[name]
      throw new Error('unavailable module ' + name)
    })
  } }
  window.__shotErrors = []
  // Recorded on <html> as well as in the array: a syntax error in a later inline
  // script never reaches finish(), and then the only witness left is the DOM.
  window.addEventListener('error', function (e) {
    window.__shotErrors.push(String(e.message))
    document.documentElement.setAttribute('data-shot-error', String(e.message))
  })
</script>
<script>${CLIENT_SOURCE}</script>
<script>document.documentElement.setAttribute('data-captured', typeof captured)</script>
<script>
  var SCENE = '${scene}'
  var FORCED_HEIGHT = ${forcedHeight}
  if (FORCED_HEIGHT > 0) {
    var forced = document.createElement('style')
    forced.textContent = '.llmm-menu{max-height:' + FORCED_HEIGHT + 'px !important;' +
      'height:' + FORCED_HEIGHT + 'px !important}'
    document.head.appendChild(forced)
  }
  var DIR_SNAPSHOT = { current: null, groups: [], retainedEffort: 'high' }
  var DECLARED = new Set((captured.inject || []))
  var slots = []
  var SERVICES = {
    slots: { inject: function (k, cb) { cb() }, register: function (o, C) { slots.push({ o: o, C: C }) } },
    sessions: { subagentAddress: function () { return undefined } },
    remote: { session: { verb: async function () { return undefined } } },
  }
  var CTX = {}
  ;['slots', 'sessions', 'remote', 'modelDirectories'].forEach(function (name) {
    Object.defineProperty(CTX, name, {
      get: function () {
        if (!DECLARED.has(name)) throw new Error('cannot get property "' + name + '" without inject')
        if (name !== 'remote') return SERVICES[name]
        return { get session() { return SERVICES.remote.session } }
      },
    })
  })
  SERVICES.modelDirectories = {
    directoryFor: function () {
      void CTX.remote.session
      return { store: { subscribe: function () { return function () {} },
        getSnapshot: function () { return DIR_SNAPSHOT } },
        load: async function () {}, select: async function () { return { ok: true, value: undefined } } }
    },
  }
  CTX.get = function (name) { return name === 'agentDefaultModel' ? undefined : undefined }
  CTX.on = function () {}
  CTX.effect = function (fn) { try { fn() } catch (e) {} }
  CTX.inject = function (names, cb) { try { cb(CTX) } catch (e) {} return function () {} }
  captured.apply(CTX)

  function byId(id) {
    for (var i = 0; i < slots.length; i += 1) if (slots[i].o.id === id) return slots[i]
    return null
  }
  function registered() {
    return Array.prototype.map.call(slots, function (s) { return s.o.id + '@' + s.o.name }).join(', ')
  }
  function mount(node, el) { ReactDOM.createRoot(el).render(node) }
  function settle(ms, next) { setTimeout(next, ms) }

  var stage = document.createElement('div')
  stage.id = 'stage'
  if (SCENE === 'manager' || SCENE === 'switches') stage.className = 'drawer'
  document.body.appendChild(stage)

  function boot() {
    try {
      if (SCENE === 'picker') return pickerShot()
      if (SCENE === 'panel') return panelShot()
      return dialogShot()
    } catch (error) {
      window.__shotErrors.push('boot: ' + (error && error.message))
      finish()
    }
  }
  function pickerShot() {
    var entry = byId('llm-manage-picker')
    if (!entry) throw new Error('no picker registration among ' + registered())
    var host = document.createElement('div')
    stage.appendChild(host)
    var props = entry.o.inject('alpha-run')
    mount(React.createElement(entry.C, props), host)
    settle(140, function () {
      var trigger = host.querySelector('.llmm-trigger')
      if (trigger) trigger.click()
      settle(220, function () {
        var menu = document.querySelector('.llmm-menu')
        if (menu) {
          var chevron = menu.querySelector('.llmm-chevron')
          if (chevron) {
            var button = chevron.closest('button')
            if (button) button.click()
          }
        }
        settle(260, function () {
          host.style.visibility = 'hidden'
          // The card is portalled at the trigger's coordinates. Park it at the padding
          // origin so the picture is the card, not the card plus the stub it hangs off.
          var card = document.querySelector('.llmm-menu')
          if (card !== null) {
            card.style.left = '16px'
            card.style.top = '16px'
            // A baked-in height, measured in a taller pass and compiled into this page:
            // the card caps itself against the viewport, so letting it choose its own
            // height in the screenshot pass yields a different card than the one framed.
          }
          finish()
        })
      })
    })
  }
  // The dialog has no keyboard hook of its own: its palette lives in the picker's
  // subtree, so this scene mounts the picker, walks its footer the way a reader would,
  // then hides the picker again. Photographing two cards at once would misrepresent
  // both, and faking the shortcut would misrepresent the route a reader actually takes.
  function dialogShot() {
    var entry = byId('llm-manage-picker')
    if (!entry) throw new Error('no picker registration among ' + registered())
    var host = document.createElement('div')
    stage.appendChild(host)
    mount(React.createElement(entry.C, entry.o.inject('alpha-run')), host)
    // The dialog is its own overlay slot; the shell mounts it once and it renders
    // nothing until something opens it.
    var shell = document.createElement('div')
    stage.appendChild(shell)
    var manager = byId('llm-manage-manager')
    if (!manager) throw new Error('no manager registration among ' + registered())
    mount(React.createElement(manager.C, { useSessions: function (selector) {
      return selector({ byId: {
        'alpha-run': { id: 'alpha-run', displayTitle: 'Release notes draft' },
        'beta-run': { id: 'beta-run', displayTitle: 'Batch import fix' },
        'gamma-run': { id: 'gamma-run', displayTitle: 'Quota audit' },
      } })
    } }), shell)
    settle(180, function () {
      var trigger = host.querySelector('.llmm-trigger')
      if (!trigger) throw new Error('no picker trigger')
      trigger.click()
      settle(260, function () {
        var foot = document.querySelectorAll('.llmm-menu-foot button')
        var opened = false
        for (var i = 0; i < foot.length; i += 1) {
          if (/模型管理|Manage models/.test(foot[i].textContent || '')) { foot[i].click(); opened = true; break }
        }
        if (!opened) throw new Error('no manage button in the picker footer')
        settle(320, function () {
          var menu = document.querySelector('.llmm-menu')
          if (menu !== null) menu.style.display = 'none'
          host.style.display = 'none'
          if (SCENE === 'switches') return switchesTab()
          var button = document.querySelector('.llmm-mg-item .llmm-mg-main')
          if (button !== null) button.click()
          settle(300, finish)
        })
      })
    })
  }
  // The models panel lives inside the provider card, which the settings UI mounts; here
  // it is mounted the way that card mounts it, with one route.
  function panelShot() {
    var entry = byId('llm-manage-panel')
    if (!entry) throw new Error('no panel registration among ' + registered())
    var host = document.createElement('div')
    stage.appendChild(host)
    mount(React.createElement(entry.C, { provider: { provider: ROUTE } }), host)
    settle(260, function () {
      var acts = host.querySelector('.llmm-rowacts button')
      if (acts !== null) acts.click()
      settle(240, finish)
    })
  }
  function switchesTab() {
    var tabs = document.querySelectorAll('.llmm-dlg-tabs .llmm-tab')
    for (var i = 0; i < tabs.length; i += 1) {
      if (/切换记录|Switches/.test(tabs[i].textContent || '')) { tabs[i].click(); break }
    }
    settle(320, function () {
      var head = document.querySelector('.llmm-sw-inc-head')
      if (head !== null) head.click()
      settle(280, finish)
    })
  }
  function finish() {
    var card = document.querySelector('.llmm-menu') || document.querySelector('.llmm-dlg')
    if (card !== null) {
      var box = card.getBoundingClientRect()
      document.documentElement.setAttribute('data-card',
        [Math.round(box.left), Math.round(box.top), Math.round(box.width),
          Math.round(box.height)].join(','))
    }
    if (document.querySelectorAll('.llmm-menu, .llmm-dlg, .llmm-panel').length === 0) {
      window.__shotErrors.push('nothing rendered: ' +
        Array.prototype.map.call(slots, function (s) { return s.o.id + '@' + s.o.name }).join(',|'))
    }
    document.title = window.__shotErrors.length ? 'ERR ' + window.__shotErrors.join(' | ') : 'READY'
    document.body.setAttribute('data-shot-ready', window.__shotErrors.length ? 'error' : 'ready')
  }
  boot()
</script>
</body></html>`

// Inlined, not linked: on file:// every subresource is its own opaque origin, so an
// exception thrown from a linked script reaches window.onerror as "Script error."
// — the one message that tells you nothing.
const CLIENT_SOURCE = readFileSync(join(HERE, 'client.js'), 'utf8')
const REACT_SOURCE = readFileSync(REACT, 'utf8')
const REACT_DOM_SOURCE = readFileSync(REACT_DOM, 'utf8')
const dir = mkdtempSync(join(tmpdir(), 'llmm-shots-'))
mkdirSync(join(HERE, 'docs'), { recursive: true })
const written = []
const base = ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-proxy-server',
  '--disable-features=HttpsUpgrades', '--proxy-bypass-list=<-loopback>']
for (const [scene, config] of Object.entries(SCENES)) {
  if (only !== undefined && only !== scene) continue
  const measure = join(dir, `${scene}.measure.html`)
  writeFileSync(measure, page(scene))
  const domPath = join(dir, `${scene}.dom.html`)
  const fd = openSync(domPath, 'w')
  try {
    execFileSync(chrome, [...base, '--virtual-time-budget=6000',
      `--window-size=${config.size[0]},${config.size[1]}`, '--dump-dom', `file://${measure}`],
    { timeout: 90_000, stdio: ['ignore', fd, 'ignore'] })
  } finally {
    closeSync(fd)
  }
  const dom = readFileSync(domPath, 'utf8').slice(0, 4000)
  const tag = (/<html[^>]*>/.exec(dom) ?? ['(no html tag)'])[0]
  if (process.argv.includes('--dump')) console.log(`${scene}: ${tag}`)
  if (/data-shot-error=/.test(tag) || /title>ERR/.test(dom)) {
    console.log(`FAIL  ${scene}: the page reported an error — ${tag}`)
    if (!process.argv.includes('--keep')) rmSync(dir, { recursive: true, force: true })
    process.exit(1)
  }
  const cardBox = (/(?:data-card)="([^"]*)"/.exec(tag) ?? [])[1]
  const box = cardBox === undefined ? null : cardBox.split(',').map(Number)
  const forced = scene === 'picker' ? config.cardHeight : 0
  const frame = forced > 0 ? [config.size[0], forced + 32] : config.size
  const shotPage = join(dir, `${scene}.html`)
  writeFileSync(shotPage, page(scene, forced))
  const out = join(HERE, 'docs', `${scene}.png`)
  rmSync(out, { force: true })
  execFileSync(chrome, [...base, '--hide-scrollbars', '--force-device-scale-factor=2',
    '--virtual-time-budget=6000', `--window-size=${frame[0]},${frame[1]}`,
    `--screenshot=${out}`, `file://${shotPage}`],
  { stdio: ['ignore', 'pipe', 'ignore'], timeout: 90_000 })
  if (!existsSync(out)) {
    console.log(`FAIL  ${scene}: no image written`)
    if (!process.argv.includes('--keep')) rmSync(dir, { recursive: true, force: true })
    process.exit(1)
  }
  written.push(out)
  console.log(`OK    ${out.replace(`${HERE}/`, '')}`)
}
if (!process.argv.includes('--keep')) rmSync(dir, { recursive: true, force: true })
if (written.length === 0) {
  console.log('FAIL  no scene matched --only')
  process.exit(1)
}
