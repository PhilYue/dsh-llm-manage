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
// The theme tokens are the values the running app actually resolves, measured from
// it rather than guessed. They used to be invented, and `--dsw-alias-bg-overlay:#fff`
// was among them — a made-up white for a token whose real light value is #e9ecf2. That
// fabrication is why the grey card passed every suite: the suites agreed with the
// plugin about a colour the app never had. The dead-token check below now fails if the
// stylesheet reads a token this block does not define.
const PAGE = `<!doctype html>
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
    --dsw-specific-menu:rgba(248,249,250,.94);
    --dsw-alias-menu-group-header-fill:rgba(248,249,250,.94);
    --dsw-menu-backdrop-filter:blur(40px) saturate(150%);
    --dsw-elevation-prominent:0 0 0 .5px rgba(0,0,0,.16),0 3px 8px 0 rgba(0,0,0,.04),0 0 20px 0 rgba(0,0,0,.05);
    --dsw-static-neutral-bluish-00:#fff;}
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
    // One shared model id served by BOTH routes is exactly what the route label is
    // for, and the case only real layout can measure: the label has to fit inside the
    // row without colliding with the model name.
    var SHARED = 'Shared-Model'
    var rows = ['Alpha-Model', 'Beta-Model', 'Gamma-Model', SHARED].map(function (m) {
      return Object.assign({}, base, { model: m })
    })
    rows[1].pinned = true
    rows[2].favorite = true
    // Pinned wherever it is offered, so the row that needs a label sits in a lifted
    // section — that is where it loses the route heading that used to say it.
    rows[3].pinned = true
    var mirrorBase = Object.assign({}, base, { route: 'mirror-route' })
    var mirrorRows = [
      Object.assign({}, mirrorBase, { model: 'Mirror-Model', pinned: true }),
      Object.assign({}, mirrorBase, { model: SHARED, pinned: true }),
    ]
    rows[3].alsoOn = ['Mirror']
    // One unusable row, so the dot colours can be compared: a status dot that is
    // uniformly one colour is exactly the regression that shipped unnoticed.
    rows.push(Object.assign({}, base, { model: 'Gone-Model', status: 'retired',
      reason: 'not listed by the gateway directory', source: 'directory', inDirectory: false }))
    mirrorRows[1].alsoOn = ['Example Gateway']
    // The Host reports a model two routes serve as ONE entry whose routes are its
    // attributes. Serving only 'groups' here would exercise the legacy fallback and
    // silently skip the shape the product actually ships.
    var byModel = {}
    ;[['Example Gateway', rows], ['Mirror', mirrorRows]].forEach(function (pair) {
      pair[1].forEach(function (row) {
        var entry = byModel[row.model]
          || (byModel[row.model] = { model: row.model, name: row.model, routes: [],
            pinned: false, favorite: false, hidden: false, usage: null })
        entry.routes.push(Object.assign({}, row, { name: pair[0] }))
        entry.pinned = entry.pinned || row.pinned === true
        entry.favorite = entry.favorite || row.favorite === true
      })
    })
    var models = Object.keys(byModel).map(function (key) {
      var entry = byModel[key]
      var first = entry.routes[0]
      return Object.assign({}, entry, {
        primary: first.route, status: first.status, reason: first.reason,
        source: first.source, scope: first.scope, at: first.at, inDirectory: first.inDirectory,
      })
    })
    var SNAPSHOT = { models: models, groups: [
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
    // The platform seeds react-dom as well as react (packages/client/web/src/seed.ts),
    // and the card portals through it, so the page must serve the same modules the real
    // loader does - both UMD builds are already on this page. Offering only "react" here
    // failed the client half outright, which took every check in this suite down with it.
    var PLATFORM = { 'react': window.React, 'react/jsx-runtime': window.React,
      'react-dom': window.ReactDOM, 'react-dom/client': window.ReactDOM }
    window.__ModuleLoader__ = { load: function (spec) {
      if (spec.id !== 'dsh-llm-manage') { log('FAIL unexpected module id ' + spec.id); return }
      captured = spec.factory(function (name) {
        if (Object.prototype.hasOwnProperty.call(PLATFORM, name) && PLATFORM[name]) return PLATFORM[name]
        throw new Error('unavailable module ' + name)
      })
    } }
    window.addEventListener('error', function (e) { log('FAIL page error: ' + e.message) })
  </script>
  <script src="file://${join(HERE, 'client.js')}"></script>
  <script>
    var done = function () { log('DONE') }
    var DIR_SNAPSHOT = { current: null, groups: [], retainedEffort: undefined }
    // The declared inject list, enforced the way Cordis enforces it: a service the
    // list omits throws on read. This page otherwise hands the plugin a plain object,
    // which enforces nothing - and that is how a missing "remote" declaration once
    // took the picker's whole stylesheet down in the real app while every suite here
    // stayed green. directoryFor() reads remote.session because the shipped
    // ModelDirectoryResolver does, so the read is mirrored below.
    var DECLARED = new Set((captured.inject || []))
    var slots = []
    var SERVICES = {
      slots: { inject: function (k, cb) { cb() }, register: function (o, C) { slots.push({ o: o, C: C }) } },
      sessions: { subagentAddress: function () { return undefined } },
      remote: { session: { verb: async function () { return undefined } } }
    }
    var CTX = {}
    ;['slots', 'sessions', 'remote', 'modelDirectories'].forEach(function (name) {
      Object.defineProperty(CTX, name, {
        get: function () {
          if (!DECLARED.has(name)) throw new Error('cannot get property "' + name + '" without inject')
          if (name !== 'remote') return SERVICES[name]
          return { get session() {
            if (!DECLARED.has('remote.session')) throw new Error('cannot get property "remote.session" without inject')
            return SERVICES.remote.session
          } }
        },
      })
    })
    SERVICES.modelDirectories = {
      directoryFor: function () {
        // The real resolver reads this.ctx.remote.session here, which is why the
        // consumer has to declare remote.session even though it never names it.
        void CTX.remote.session
        return {
          // The picker subscribes through useSyncExternalStore, so the store must
          // exist, and getSnapshot must return the SAME object every call: a fresh
          // object per call makes React update forever ("Maximum update depth
          // exceeded") and the picker never renders a menu.
          store: { subscribe: function () { return function () {} },
            getSnapshot: function () { return DIR_SNAPSHOT } },
          load: async function () {}, select: async function () { return { ok: true, value: undefined } } }
      },
    }
    try {
      captured.apply(CTX)
    } catch (error) {
      log('FAIL applying the client half: ' + error.message)
      done()
    }
    {
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

            // The panel card's real material, computed here because the README cannot
            // show a panel screenshot: it registers into
            // settings.models.provider-card, reachable only through the settings UI, and
            // building a page to photograph it would supply the theme being checked.
            var panelEl = document.querySelector('.llmm-panel')
            if (panelEl) {
              var panelStyle = getComputedStyle(panelEl)
              log('PANEL_BORDER_WIDTH=' + panelStyle.borderTopWidth)
              log('PANEL_BORDER_COLOR=' + panelStyle.borderTopColor)
              log('PANEL_RADIUS=' + panelStyle.borderTopLeftRadius)
              log('PANEL_BACKGROUND=' + panelStyle.backgroundColor)
              // bg-layer-2 and settings-card-fill are both white in this theme, so the
              // colour alone cannot distinguish them; the stroke can, because the settings
              // stroke is l4 (0.16 alpha) while border-l1 is 0.04. Assert the alpha.
              log('PANEL_STROKE_ALPHA=' + (function () {
                var m = /rgba?\\([^)]*\\)/.exec(panelStyle.borderTopColor)
                if (!m) return 'n/a'
                var parts = m[0].slice(5, -1).split(',').map(Number)
                return parts.length > 3 ? String(parts[3]) : '1'
              })())
            } else { log('FAIL no panel card') }

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
              // The card is portalled to <body>, so it is deliberately NOT inside
              // pickerHost. Measure it where it renders: scoping to pickerHost is what
              // made every menu assertion here fail after the portal, and a suite that
              // only ever looked inside pickerHost could not have seen the sidebar
              // covering the card in the first place.
              var menu = document.querySelector('.llmm-menu')
              log('PICKER_CARD_PARENT=' + (menu && menu.parentElement ? menu.parentElement.tagName : 'none'))
              // Computed colours, not class names: a class can be right while the token
              // resolves to the same surface colour for both tones.
              var dotOf = function (tone) { return menu.querySelector('.llmm-dot.' + tone) }
              var bgOf = function (node) { return node ? getComputedStyle(node).backgroundColor : 'none' }
              log('DOT_OK_BG=' + bgOf(dotOf('ok')))
              log('DOT_BAD_BG=' + bgOf(dotOf('bad')))
              log('DOT_COUNT=' + menu.querySelectorAll('.llmm-dot').length)
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

              // The picker is a dropdown card, so its reference is the design
              // system's own menu metrics (ui-primitives Menu/MenuSurface, and the
              // shipped model picker this plugin shadows), NOT the plugin's own
              // inline panel — the panel is a page surface and follows different
              // metrics deliberately. Compared through getComputedStyle in a real
              // engine, so this resolves the cascade and the theme variables: a
              // declaration that never wins cannot pass, and neither can one whose
              // token is undefined.
              var pickerRow = menu.querySelector('.llmm-item')
              var menuCard = menu
              if (!pickerRow || !menuCard) { log('FAIL no rows to measure') } else {
                var pickerStyle = getComputedStyle(pickerRow)
                var cardStyle = getComputedStyle(menuCard)
                // The shipped .option contract, resolved.
                var wantRow = {'boxSizing': 'border-box', 'minHeight': '34px',
                  'paddingTop': '5px', 'paddingRight': '7px', 'paddingBottom': '5px',
                  'paddingLeft': '7px', 'borderTopLeftRadius': '12px', 'fontSize': '13px',
                  'lineHeight': '18px', 'gap': '6px', 'borderTopWidth': '0px'}
                var rowDiff = Object.keys(wantRow).filter(function (prop) {
                  return pickerStyle[prop] !== wantRow[prop]
                }).map(function (prop) { return prop + ':' + pickerStyle[prop] + '!=' + wantRow[prop] })
                log('PICKER_ROW_DIFF=' + (rowDiff.length === 0 ? 'none' : rowDiff.join(',')))
                log('PICKER_ROW_PROPS=' + Object.keys(wantRow).length)
                // The shipped .menu contract, resolved: lg radius (MenuSurface is used
                // without its compact flag), 4px inset, no border.
                var wantCard = {'position': 'fixed', 'paddingTop': '4px',
                  'borderTopLeftRadius': '16px', 'borderTopWidth': '0px'}
                var cardDiff = Object.keys(wantCard).filter(function (prop) {
                  return cardStyle[prop] !== wantCard[prop]
                }).map(function (prop) { return prop + ':' + cardStyle[prop] + '!=' + wantCard[prop] })
                log('PICKER_CARD_DIFF=' + (cardDiff.length === 0 ? 'none' : cardDiff.join(',')))
                log('PICKER_CARD_PROPS=' + Object.keys(wantCard).length)
                // Every token the plugin's stylesheet reads must resolve in this
                // theme. An undefined custom property makes the whole declaration
                // invalid at computed-value time, so a typo or a token that only
                // exists in some other theme shows up here as a silent 0px/initial
                // rather than an error. This is the guard the invented token block
                // could not provide.
                var cssText = Array.prototype.slice.call(document.querySelectorAll('style'))
                  .map(function (s) { return s.textContent || '' }).join('\\n')
                var used = {}
                var re = /var\\(\\s*(--[a-zA-Z0-9-]+)/g
                var m
                while ((m = re.exec(cssText)) !== null) used[m[1]] = true
                var rootStyle = getComputedStyle(document.documentElement)
                var missing = Object.keys(used).filter(function (name) {
                  return rootStyle.getPropertyValue(name).trim() === ''
                    && document.body && getComputedStyle(document.body).getPropertyValue(name).trim() === ''
                })
                log('DEAD_TOKENS=' + (missing.length === 0 ? 'none' : missing.join(',')))
                log('TOKENS_USED=' + Object.keys(used).length)
              }
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
    }
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
// The panel card, computed in a real engine. Chrome rounds a 0.5px border up to 1px in
// getComputedStyle (verified: a bare `border:0.5px solid red` div reports 1px at DPR 1 and
// 2), so the width is asserted to be a hairline rather than to the literal string; the
// declaration itself is pinned by verify-client.mjs. What the engine CAN separate is the
// stroke colour: the settings stroke is --dsw-alias-border-l4 at 0.16 alpha, while the old
// card used border-l1 at 0.04. Both fills are white in this theme, so the alpha is the only
// thing distinguishing the settings card material from the heavier box it replaced.
check('the panel card renders the settings page\'s hairline stroke and radius',
  (line('PANEL_BORDER_WIDTH') === '0.5px' || line('PANEL_BORDER_WIDTH') === '1px')
  && line('PANEL_RADIUS') === '20px'
  && line('PANEL_STROKE_ALPHA') === '0.16',
  `border=${line('PANEL_BORDER_WIDTH')} ${line('PANEL_BORDER_COLOR')} (alpha ${line('PANEL_STROKE_ALPHA')}, want 0.16 = border-l4) radius=${line('PANEL_RADIUS')} background=${line('PANEL_BACKGROUND')}`)

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
// Structural, in the engine that has real layout: the card must be a child of
// <body> and not of the host the trigger lives in. In the composer this is the
// difference between a card that can be placed freely and one confined by the
// composer row's `container-type: inline-size`, which is what let the right
// sidebar paint over it.
check('the picker card is a child of <body>, not of the composer host',
  line('PICKER_CARD_PARENT') === 'BODY',
  `parent=${line('PICKER_CARD_PARENT')}`)
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
// The status dot is the only at-a-glance "can I use this" signal, and no suite
// asserted its colour — so a key mismatch that turned every dot grey passed review.
check('the status dot paints the healthy colour, not an empty one',
  line('DOT_OK_BG') !== 'none' && line('DOT_OK_BG') !== 'rgba(0, 0, 0, 0)',
  line('DOT_OK_BG'))
check('an unusable row paints a different dot colour from a healthy one',
  line('DOT_BAD_BG') !== 'none' && line('DOT_BAD_BG') !== line('DOT_OK_BG'),
  `ok=${line('DOT_OK_BG')} bad=${line('DOT_BAD_BG')}`)
check('a route label fits inside its row', line('ROUTE_LABEL_WITHIN_ROW') === 'true')
check('the menu does not scroll horizontally', line('MENU_ROW_NO_HSCROLL') === 'true')

// The picker must compute to the design system's own menu metrics. Asserted on
// computed styles in a real engine, where the cascade and the theme variables are
// resolved, so this catches a rule that is present in the stylesheet but never
// actually applied — and a token that is undefined, which would otherwise make the
// declaration invalid and silently render an initial value.
check('a picker row computes to the shipped model picker\'s row metrics',
  line('PICKER_ROW_DIFF') === 'none',
  `${line('PICKER_ROW_DIFF')} (${num('PICKER_ROW_PROPS')} properties compared)`)
check('a picker card computes to the shipped model picker\'s card metrics',
  line('PICKER_CARD_DIFF') === 'none',
  `${line('PICKER_CARD_DIFF')} (${num('PICKER_CARD_PROPS')} properties compared)`)
// The theme block above stands in for the app's theme. If the stylesheet reads a token
// the theme does not define, the property using it becomes invalid at computed-value
// time and renders an initial value with no error anywhere. That is how a fabricated
// token value stayed invisible: the suites defined white for a token the app paints grey.
check('every theme token the stylesheet reads is defined',
  line('DEAD_TOKENS') === 'none',
  `${line('DEAD_TOKENS')} (${num('TOKENS_USED')} tokens used)`)


const failed = results.filter(r => !r.passed)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
