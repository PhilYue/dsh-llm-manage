/**
 * dsh-llm-manage — render a static preview of the panel.
 *
 * Renders the real `client.js` in jsdom, lets its effects settle, forces one
 * tooltip visible, and writes a self-contained HTML file. This is for looking at
 * the control design without restarting the harness; it is not a test.
 *
 *   node preview.mjs [outfile]
 *
 * Default output: panel-preview.html
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkoutRootOrExit } from './verify-env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DH = checkoutRootOrExit(join('apps', 'web', 'package.json'))
const fromWeb = createRequire(join(DH, 'apps/web/package.json'))
const fromRoot = createRequire(join(DH, 'package.json'))
const OUT = process.argv[2] ?? join(HERE, 'panel-preview.html')

const HOME = mkdtempSync(join(tmpdir(), 'llmm-preview-'))
process.env.DSH_HOME = HOME

const registered = []
const listeners = {}
let routes = []

const { JSDOM } = fromRoot('jsdom')
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: 'http://127.0.0.1:3080/',
  pretendToBeVisual: true,
})
const { window } = dom
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'CustomEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'AbortController']) {
  if (window[key] === undefined) continue
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

// ── a Host stub that answers the panel's snapshot ───────────────────────────
const ROUTE = 'example-route'
const now = Date.now()
const row = (model, extra) => ({
  route: ROUTE, model, favorite: false, pinned: false, hidden: false,
  status: 'unknown', reason: '', source: 'none', scope: 'model', at: 0,
  inDirectory: true, ...extra,
})
// Synthetic catalogue, and one row per status the panel can render, so the
// preview exercises every badge and tone without naming a real deployment.
const SNAPSHOT = {
  groups: [{
    route: ROUTE,
    name: 'Example Gateway',
    models: ['model-alpha', 'model-beta', 'model-gamma', 'model-delta', 'model-epsilon', 'model-zeta'],
    rows: [
      row('model-alpha', { pinned: true, favorite: true, status: 'ok', source: 'probe', reason: 'answered a minimal request', at: now - 90_000 }),
      row('model-beta', { status: 'ok', source: 'passive', reason: 'in use', at: now - 240_000 }),
      row('model-gamma', { status: 'quota', source: 'passive', reason: 'quota exhausted for this model', at: now - 600_000 }),
      row('model-delta', { status: 'protocol', source: 'probe', reason: 'model not support', at: now - 3_600_000 }),
      row('model-epsilon', { status: 'error', source: 'probe', reason: 'unexpected response body', at: now - 7_200_000, alsoOn: ['other-route'] }),
      row('model-zeta', { status: 'retired', source: 'directory', reason: "not listed by the route's gateway directory", at: now - 60_000 }),
    ],
  }],
  directory: [{ route: ROUTE, ok: true, count: 42, at: now - 30_000 }],
}
let delivered = false
globalThis.fetch = async () => {
  const body = delivered ? { ok: true, value: SNAPSHOT } : { ok: true, value: SNAPSHOT }
  delivered = true
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

// ── the real client half ────────────────────────────────────────────────────
let captured
window.__ModuleLoader__ = {
  load: ({ id, factory }) => {
    if (id !== 'dsh-llm-manage') throw new Error(`unexpected module id "${id}"`)
    captured = factory((name) => {
      if (name === 'react') return React
      throw new Error(`client.js required unavailable module "${name}"`)
    })
  },
}
await import(pathToFileURL(join(HERE, 'client.js')).href)

const slots = []
captured.apply({
  slots: { inject: (_k, cb) => { cb() }, register: (options, Component) => { slots.push({ options, Component }); return () => {} } },
  modelDirectories: { directoryFor: () => ({ store: {}, load: async () => {}, select: async () => ({ ok: true, value: undefined }) }) },
  sessions: { subagentAddress: () => undefined },
})

const Panel = slots.find(s => s.options.id === 'llm-manage-panel').Component
const container = window.document.getElementById('app')
const root = createRoot(container)
// The panel reads the locale from the ambient document, which has no Harness
// locale service here, so the dictionary falls back to its first entry (en).
await act(async () => { root.render(React.createElement(Panel, { provider: { provider: ROUTE } })) })
await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)) })

// Force one tooltip visible so the hover label's design is captured too.
const star = Array.from(container.querySelectorAll('button'))
  .find(b => /Favorite|收藏/.test(b.getAttribute('aria-label') ?? ''))
if (star) {
  await act(async () => {
    star.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 30))
  })
}

// jsdom implements no layout, so getBoundingClientRect() returns all zeros and
// the tooltip would sit off-screen. Park it somewhere visible so the preview
// shows the hover label's design; a real browser positions it from the rect.
const tipNode = container.querySelector('.llmm-tip')
if (tipNode) {
  tipNode.style.left = '640px'
  tipNode.style.top = '150px'
}

const css = Array.from(container.querySelectorAll('style')).map(node => node.textContent ?? '').join('\n')
const html = container.innerHTML
// Count while the tree is still mounted: unmounting empties the container.
const rowCount = container.querySelectorAll('.llmm-row').length
const actCount = container.querySelectorAll('.llmm-rowacts button').length
const tipShown = container.querySelector('.llmm-tip') !== null
await act(async () => { root.unmount() })
rmSync(HOME, { recursive: true, force: true })

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>dsh-llm-manage panel preview</title>
<style>
  /* The panel's own stylesheet, verbatim, plus the theme tokens it reads.
     Values are the light-theme defaults so the file renders standalone. */
  :root{
    --dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#f7f8fa;--dsw-alias-bg-layer-2:#fff;
    --dsw-alias-bg-overlay:#fff;--dsw-alias-border-l1:#e3e5e8;--dsw-alias-border-l2:#c9ccd1;
    --dsw-alias-brand-primary:#1f6feb;--dsw-alias-label-primary:#1a1d21;
    --dsw-alias-label-secondary:#6b7280;--dsw-alias-state-error-primary:#c8342f;
    --dsw-alias-state-idle-primary:#9aa1ab;--dsw-alias-state-success-primary:#1a9d54;
    --dsw-alias-state-warn-primary:#c98a00;
  }
  body{margin:0;padding:20px;background:var(--dsw-alias-bg-base);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .note{max-width:820px;margin:0 auto 12px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6}
${css}
</style></head>
<body>
  <div class="note">
    Static render of the real <code>client.js</code> panel. Row actions are icon-only
    (pin, star, eye, pulse) with the label on hover; one tooltip is forced visible.
    The live panel resolves these colors from your active theme.
  </div>
  <div style="max-width:820px;margin:0 auto">${html}</div>
</body></html>
`
writeFileSync(OUT, page)
console.log(`wrote ${OUT}`)
console.log(`rows=${rowCount} rowActionButtons=${actCount} tooltipEl=${tipShown}`)
