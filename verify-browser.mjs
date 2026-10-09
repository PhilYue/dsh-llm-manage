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
    var SNAPSHOT = { groups: [{ route: ROUTE, name: 'Example Gateway',
      models: rows.map(function (r) { return r.model }), rows: rows }] }
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
    try {
      var slots = []
      captured.apply({
        slots: { inject: function (k, cb) { cb() }, register: function (o, C) { slots.push({ o: o, C: C }) } },
        modelDirectories: { directoryFor: function () { return { store: {},
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
                  done()
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

const failed = results.filter(r => !r.passed)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
