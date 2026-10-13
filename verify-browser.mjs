/**
 * dsh-llm-manage — real-browser checks for the panel's controls.
 *
 * jsdom (used by `verify-client.mjs`) implements no layout: every
 * `getBoundingClientRect()` returns zeros, so a tooltip's position and a button's
 * width cannot be verified there. This suite loads the REAL `client.js` into a
 * real engine (headless Chrome), hovers a row action, and asserts the geometry
 * the design depends on.
 *
 *   node verify-browser.mjs
 *
 * Skips (exit 0) with a notice when no Chrome-family binary is installed, so it
 * never blocks a checkout that only has Node.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkoutRootOrExit } from './verify-env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DH = checkoutRootOrExit(join('apps', 'web', 'package.json'))

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
  console.log('SKIP  no Chrome-family browser found; set CHROME_PATH to run this suite')
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

// ── the page: real client.js, real engine, real layout ──────────────────────
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root{--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#f7f8fa;--dsw-alias-bg-layer-2:#fff;
    --dsw-alias-bg-overlay:#fff;--dsw-alias-border-l1:#e3e5e8;--dsw-alias-border-l2:#c9ccd1;
    --dsw-alias-brand-primary:#1f6feb;--dsw-alias-label-primary:#1a1d21;
    --dsw-alias-label-secondary:#6b7280;--dsw-alias-state-error-primary:#c8342f;
    --dsw-alias-state-idle-primary:#9aa1ab;--dsw-alias-state-success-primary:#1a9d54;
    --dsw-alias-state-warn-primary:#c98a00;}
  body{margin:0;padding:16px;font-family:-apple-system,sans-serif}
</style></head>
<body>
  <div id="app" style="max-width:820px"></div>
  <pre id="out" style="font:11px monospace;white-space:pre-wrap"></pre>
  <script src="file://${REACT}"></script>
  <script src="file://${REACT_DOM}"></script>
  <script>
    var log = function (m) { document.getElementById('out').textContent += m + '\\n' }
    var ROUTE = 'example-route'
    var base = { route: ROUTE, favorite: false, pinned: false, hidden: false, status: 'ok',
      reason: 'answered', source: 'probe', scope: 'model', at: Date.now(), inDirectory: true }
    var rows = ['Alpha-Model', 'Beta-Model', 'Gamma-Model'].map(function (m) {
      return Object.assign({}, base, { model: m })
    })
    // One pinned and one favorited row, plus a second route serving a row id that
    // also exists above. That combination is what the picker's sections and their
    // route labels exist for, and it is only measurable with real layout.
    rows[1].pinned = true
    rows[2].favorite = true
    // Every model id here belongs to exactly one route, so a repeated name in the
    // menu can only mean a lifted row was copied instead of moved. (An id served by
    // two routes is a legitimate repeat, and verify-client.mjs covers that case
    // with full route information, which a geometry probe cannot recover.)
    var mirrorRows = [Object.assign({}, base, { route: 'mirror-route', model: 'Mirror-Model', pinned: true })]
    var SNAPSHOT = { groups: [
      { route: ROUTE, name: 'Example Gateway',
        models: rows.map(function (r) { return r.model }), rows: rows },
      { route: 'mirror-route', name: 'Mirror',
        models: mirrorRows.map(function (r) { return r.model }), rows: mirrorRows },
    ] }
    window.fetch = function () {
      return Promise.resolve(new Response(JSON.stringify({ ok: true, value: SNAPSHOT }),
        { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    var captured
    window.__ModuleLoader__ = { load: function (spec) {
      if (spec.id !== 'dsh-llm-manage') { log('FAIL unexpected module id ' + spec.id); return }
      captured = spec.factory(function (name) {
        if (name === 'react') return window.React
        throw new Error('unavailable module ' + name)
      })
    } }
    window.addEventListener('error', function (e) { log('FAIL page error: ' + e.message) })
  </script>
  <script src="file://${join(HERE, 'client.js')}"></script>
  <script>
    var done = function () { log('DONE') }
    var DIR_SNAPSHOT = { current: null, groups: [], retainedEffort: undefined }
    try {
      var slots = []
      captured.apply({
        slots: { inject: function (k, cb) { cb() }, register: function (o, C) { slots.push({ o: o, C: C }) } },
        modelDirectories: { directoryFor: function () { return {
          // The picker subscribes through useSyncExternalStore, so the store must
          // exist, and getSnapshot must return the SAME object every call: a fresh
          // object per call makes React update forever ("Maximum update depth
          // exceeded") and the picker never renders a menu.
          store: { subscribe: function () { return function () {} },
            getSnapshot: function () { return DIR_SNAPSHOT } },
          load: async function () {}, select: async function () { return { ok: true, value: undefined } } } } },
        sessions: { subagentAddress: function () { return undefined } }
      })
      var slot = slots.filter(function (s) { return s.o.id === 'llm-manage-panel' })[0]
      if (!slot) { log('FAIL no panel slot'); done() } else {
        var root = ReactDOM.createRoot(document.getElementById('app'))
        ReactDOM.flushSync(function () {
          root.render(React.createElement(slot.C, { provider: { provider: ROUTE } }))
        })
        setTimeout(function () {
          var acts = document.querySelectorAll('.llmm-rowacts button')
          log('rowActionButtons=' + acts.length)
          if (acts.length === 0) { log('FAIL no action buttons'); done() } else {
            var btn = acts[0]
            var rect = btn.getBoundingClientRect()
            log('buttonWidth=' + Math.round(rect.width))
            log('buttonHeight=' + Math.round(rect.height))
            log('buttonHasVisibleText=' + ((btn.textContent || '').trim().length > 0))
            log('buttonHasAriaLabel=' + (btn.getAttribute('aria-label') !== null))

            var row = document.querySelector('.llmm-row')
            var actsBox = document.querySelector('.llmm-rowacts').getBoundingClientRect()
            log('rowActionGroupWidth=' + Math.round(actsBox.width))
            log('ROW_NO_OVERFLOW=' + (actsBox.right <= row.getBoundingClientRect().right + 1))

            // The same four actions rendered as the text buttons this replaced,
            // measured in the panel's own stylesheet.
            var probe = document.createElement('div')
            probe.style.cssText = 'position:absolute;left:-9999px;top:0'
            ;['\u53d6\u6d88\u7f6e\u9876', '\u53d6\u6d88\u6536\u85cf', '\u53d6\u6d88\u9690\u85cf', '\u63a2\u6d3b'].forEach(function (label) {
              var b = document.createElement('button')
              b.className = 'llmm-btn'
              b.textContent = label
              probe.appendChild(b)
            })
            document.body.appendChild(probe)
            var textWidth = 3 * 4
            var kids = probe.querySelectorAll('button')
            for (var i = 0; i < kids.length; i += 1) textWidth += kids[i].getBoundingClientRect().width
            log('textButtonGroupWidth=' + Math.round(textWidth))
            probe.remove()

            // ── the composer model picker, in real layout ────────────────────
            // Measured in its own phase, after the panel and tooltip checks: the
            // picker mounts a second React root, and a failure in it must not be
            // reported as a panel failure. Anything it throws is logged as
            // PICKER THREW rather than escaping as a cross-origin "Script error.".
            var guard = function (fn) {
              return function () {
                try { fn() } catch (e) { log('PICKER THREW: ' + (e && e.message)); done() }
              }
            }
            var measurePicker = function (pickerHost) {
              var menu = pickerHost.querySelector('.llmm-menu')
              if (!menu) { log('FAIL picker menu did not open'); done(); return }
              var heads = Array.prototype.slice.call(menu.querySelectorAll('.llmm-group'))
              log('pickerSections=' + heads.map(function (nd) { return nd.textContent }).join(' | '))
              var titleOf = function (nd) { return (nd.textContent || '').split(' (')[0] }
              // The dictionary follows the browser's locale, so the assertions read
              // the section by position and compare against either language rather
              // than hard-coding English.
              log('pickerFirstSection=' + (heads[0] ? titleOf(heads[0]) : ''))
              log('pickerSecondSection=' + (heads[1] ? titleOf(heads[1]) : ''))
              var isLifted = function (title) {
                return title === 'Pinned' || title === '\u7f6e\u9876'
                  || title === 'Favorites' || title === '\u6536\u85cf'
              }
              log('PICKER_FIRST_IS_PINNED=' + (heads[0] ? isLifted(titleOf(heads[0])) : false))
              log('PICKER_SECOND_IS_FAVORITES=' +
                (heads[1] ? titleOf(heads[1]) === 'Favorites' || titleOf(heads[1]) === '\u6536\u85cf' : false))

              // The claim in one measurement: the pinned/favorite sections sit
              // above every route section.
              var firstRouteHead = heads.filter(function (nd) {
                return !isLifted(titleOf(nd))
              })[0]
              log('PINNED_ABOVE_ROUTES=' +
                (heads[0] && firstRouteHead
                  ? heads[0].getBoundingClientRect().top < firstRouteHead.getBoundingClientRect().top
                  : false))

              // No row may be offered twice: the same name in two sections would
              // mean the lift copied instead of moved.
              var names = Array.prototype.slice.call(menu.querySelectorAll('.llmm-name'))
                .map(function (nd) { return nd.textContent })
              log('pickerRowCount=' + names.length)
              log('pickerDistinctRows=' + new Set(names).size)

              // A route label must appear only where a section spans routes (the
              // mirror-route row), never on a single-route section's rows, and it
              // must neither overlap the name nor overflow the row.
              var body = menu.querySelector('.llmm-menu-body')
              var labelled = Array.prototype.slice.call(menu.querySelectorAll('.llmm-item'))
                .filter(function (item) { return item.querySelector('.llmm-route') !== null })
              log('pickerLabelledRows=' + labelled.length)
              // Only the Pinned section spans routes here (example-route +
              // mirror-route), so the Favorites and route sections must carry no
              // label at all: a route printed on every row would be noise.
              // The sections are the children of the scroll body, not of the menu:
              // the menu's own children are the search head and that body.
              var perSectionLabels = Array.prototype.slice.call(body.children).map(function (section) {
                return (section.querySelector('.llmm-group').textContent || '').split(' (')[0]
                  + ':' + section.querySelectorAll('.llmm-route').length
              })
              log('pickerLabelsPerSection=' + perSectionLabels.join(','))
              log('ROUTE_LABEL_NO_OVERLAP=' + labelled.every(function (item) {
                var name = item.querySelector('.llmm-name').getBoundingClientRect()
                var route = item.querySelector('.llmm-route').getBoundingClientRect()
                return name.right <= route.left + 1
              }))
              log('ROUTE_LABEL_WITHIN_ROW=' + labelled.every(function (item) {
                return item.querySelector('.llmm-route').getBoundingClientRect().right
                  <= item.getBoundingClientRect().right + 1
              }))
              log('MENU_ROW_NO_HSCROLL=' + (body.scrollWidth <= body.clientWidth + 1))
              done()
            }
            var runPickerChecks = guard(function () {
              var pickerSlot = slots.filter(function (s) { return s.o.id === 'llm-manage-picker' })[0]
              if (!pickerSlot) { log('FAIL no picker slot'); done(); return }
              var pickerHost = document.createElement('div')
              document.body.appendChild(pickerHost)
              ReactDOM.createRoot(pickerHost).render(
                React.createElement(pickerSlot.C, pickerSlot.o.inject('sess-browser')))
              setTimeout(guard(function () {
                var trigger = pickerHost.querySelector('.llmm-trigger')
                if (!trigger) { log('FAIL picker rendered no trigger'); done(); return }
                trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                // The menu's position comes from a useEffect, which React runs
                // after paint, so the node does not exist on the click's own tick.
                setTimeout(guard(function () { measurePicker(pickerHost) }), 60)
              }), 60)
            })

            btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
            setTimeout(function () {
              var tip = document.querySelector('.llmm-tip')
              if (!tip) { log('FAIL no tooltip after hover'); done() } else {
                var t = tip.getBoundingClientRect()
                log('tooltipText=' + tip.textContent)
                log('TOOLTIP_CLEAR_OF_BUTTON=' + (t.bottom <= rect.top))
                log('TOOLTIP_HORIZONTALLY_CENTERED=' +
                  (Math.abs((t.x + t.width / 2) - (rect.x + rect.width / 2)) < 2))
                log('TOOLTIP_WITHIN_VIEWPORT=' +
                  (t.x >= 0 && t.right <= window.innerWidth && t.y >= 0))
                log('TOOLTIP_OUTSIDE_SCROLLER=' + (tip.parentElement === document.querySelector('.llmm-panel')))

                // The rightmost button is the clamp's reason to exist: near the
                // viewport edge the label must still fit.
                var last = acts[acts.length - 1]
                last.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
                setTimeout(function () {
                  var edge = document.querySelector('.llmm-tip').getBoundingClientRect()
                  log('EDGE_TOOLTIP_WITHIN_VIEWPORT=' + (edge.x >= 0 && edge.right <= window.innerWidth))
                  setTimeout(runPickerChecks, 20)
                }, 40)
              }
            }, 60)
          }
        }, 120)
      }
    } catch (error) { log('FAIL ' + error.message); done() }
  </script>
</body></html>
`

const dir = mkdtempSync(join(tmpdir(), 'llmm-browser-'))
const page = join(dir, 'geometry.html')
writeFileSync(page, PAGE)

let dom = ''
try {
  dom = execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
    '--virtual-time-budget=4000', '--window-size=900,700', '--dump-dom', `file://${page}`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 90_000 })
} catch (error) {
  console.log(`FAIL  headless Chrome did not complete: ${error.message}`)
  rmSync(dir, { recursive: true, force: true })
  process.exit(1)
}
rmSync(dir, { recursive: true, force: true })

const block = /<pre id="out"[^>]*>([\s\S]*?)<\/pre>/.exec(dom)
if (block === null) {
  console.log('FAIL  the page produced no output block')
  process.exit(1)
}
const text = block[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
const line = (key) => {
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(text)
  return match === null ? undefined : match[1]
}
const num = (key) => {
  const value = line(key)
  return value === undefined ? undefined : Number(value)
}

const results = []
function check(label, passed, detail = '') {
  results.push({ label, passed })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

if (/\bFAIL\b/.test(text)) {
  console.log(text.split('\n').filter(l => l.includes('FAIL')).join('\n'))
}

check('the real panel renders in a real browser', (num('rowActionButtons') ?? 0) > 0,
  `rowActionButtons=${num('rowActionButtons')}`)
check('row actions are icon-sized, not text-width', (num('buttonWidth') ?? 999) <= 32,
  `buttonWidth=${num('buttonWidth')}px height=${num('buttonHeight')}px`)
check('row actions render no visible text', line('buttonHasVisibleText') === 'false')
check('row actions carry an aria-label', line('buttonHasAriaLabel') === 'true')

const iconWidth = num('rowActionGroupWidth')
const textWidth = num('textButtonGroupWidth')
check('four icon buttons are much narrower than the four text buttons they replaced',
  iconWidth !== undefined && textWidth !== undefined && iconWidth < textWidth * 0.5,
  `${textWidth}px as text -> ${iconWidth}px as icons`)
check('the row does not overflow its container', line('ROW_NO_OVERFLOW') === 'true')

check('hovering an action shows its label', (line('tooltipText') ?? '') !== '')
check('the tooltip sits above the button, not over it', line('TOOLTIP_CLEAR_OF_BUTTON') === 'true')
check('the tooltip is horizontally centred on its button', line('TOOLTIP_HORIZONTALLY_CENTERED') === 'true')
check('the tooltip stays inside the viewport', line('TOOLTIP_WITHIN_VIEWPORT') === 'true')
check('the tooltip is not a child of the scrolling row list', line('TOOLTIP_OUTSIDE_SCROLLER') === 'true')
check('a button at the row edge still keeps its label on-screen',
  line('EDGE_TOOLTIP_WITHIN_VIEWPORT') === 'true')

// ── the composer picker, measured ───────────────────────────────────────────
check('the picker opens with its sections in a real engine',
  (line('pickerSections') ?? '') !== '', line('pickerSections'))
check('the picker leads with Pinned, then Favorites',
  line('PICKER_FIRST_IS_PINNED') === 'true' && line('PICKER_SECOND_IS_FAVORITES') === 'true',
  `${line('pickerFirstSection')} / ${line('pickerSecondSection')}`)
check('pinned and favorite rows sit above every route section',
  line('PINNED_ABOVE_ROUTES') === 'true')
check('no row is offered twice in the menu',
  num('pickerRowCount') !== undefined && num('pickerRowCount') === num('pickerDistinctRows'),
  `${num('pickerRowCount')} rows, ${num('pickerDistinctRows')} distinct`)
check('only a route-spanning section prints route labels',
  (num('pickerLabelledRows') ?? 0) > 0
  && /^[^:]+:[1-9]/.test(line('pickerLabelsPerSection') ?? '')
  && (line('pickerLabelsPerSection') ?? '').split(',').slice(1).every(entry => entry.endsWith(':0')),
  line('pickerLabelsPerSection'))
check('a route label never overlaps the model name', line('ROUTE_LABEL_NO_OVERLAP') === 'true')
check('a route label fits inside its row', line('ROUTE_LABEL_WITHIN_ROW') === 'true')
check('the menu does not scroll horizontally', line('MENU_ROW_NO_HSCROLL') === 'true')

const failed = results.filter(r => !r.passed)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
