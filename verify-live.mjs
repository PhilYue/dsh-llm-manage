/**
 * dsh-llm-manage — live-app checks against a running harness.
 *
 * The other suites build their own page and hand the client half a context they
 * control. That is fast and deterministic, and it is also how a real regression
 * survived a full green run: the plugin declared three services but the resolver it
 * calls reaches for a fourth internally, so in the live app the picker's slot entry
 * threw `cannot get property "remote.session" without inject` and — because `Style`
 * renders inside that same subtree — the composer model control lost every rule in
 * the stylesheet. A hand-built context cannot catch a contract it does not enforce.
 *
 * This suite loads the REAL application from a running `dsh web`, in a real engine,
 * and asserts what the user actually sees.
 *
 *   DSH_LIVE_URL='http://127.0.0.1:3080/?token=...' node verify-live.mjs
 *
 * `DSH_LIVE_URL` is the URL `dsh web` prints, token and all; Chrome performs the
 * exchange and stores the session cookie itself. `DSH_LIVE_COOKIE` is accepted
 * instead, for an already-authenticated browser.
 *
 * Skips (exit 0) when neither is set, when no Chrome-family binary is installed, or
 * when nothing answers at the URL, so it never blocks a checkout or a CI run that
 * has no live harness — and never reports a pass it did not earn.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(candidate => typeof candidate === 'string' && candidate !== '')
const chrome = CHROME_CANDIDATES.find(candidate => existsSync(candidate))
const LIVE_URL = process.env.DSH_LIVE_URL ?? process.env.DSH_WEB_URL ?? ''
const LIVE_COOKIE = process.env.DSH_LIVE_COOKIE ?? ''

if (chrome === undefined) {
  console.log('SKIP  no Chrome-family browser found; set CHROME_PATH to run this suite')
  process.exit(0)
}
if (LIVE_COOKIE === '' && /[?&]token=/.test(LIVE_URL) === false) {
  console.log('SKIP  set DSH_LIVE_URL to the URL `dsh web` printed (it carries ?token=...),')
  console.log('      or DSH_LIVE_COOKIE to an authenticated session cookie')
  process.exit(0)
}
if (LIVE_URL === '') {
  console.log('SKIP  DSH_LIVE_COOKIE was set without DSH_LIVE_URL; nothing to open')
  process.exit(0)
}

const target = new URL(LIVE_URL)
try {
  const probe = await fetch(new URL('/', target), { method: 'GET', redirect: 'manual' })
  if (probe.status >= 500) throw new Error(`status ${probe.status}`)
} catch (error) {
  console.log(`SKIP  nothing usable at ${target.origin}: ${error?.message ?? error}`)
  process.exit(0)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const profile = mkdtempSync(join(tmpdir(), 'llmm-live-'))
const browser = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--window-size=1400,1000', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] })

/** Chrome writes the port it chose into the profile once the socket is listening. */
async function debuggerUrl() {
  const file = join(profile, 'DevToolsActivePort')
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (existsSync(file)) {
      const [port] = readFileSync(file, 'utf8').split('\n')
      if (/^\d+$/.test(port ?? '')) {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null)
        if (res !== null && res.ok) {
          const json = await res.json()
          if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl
        }
      }
    }
    await sleep(250)
  }
  throw new Error('Chrome did not expose a debugger endpoint')
}

const results = []
function check(label, passed, detail = '') {
  results.push({ label, passed })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

let socket
async function main() {
  socket = new WebSocket(await debuggerUrl())
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })

  let nextId = 1
  const pending = new Map()
  const events = []
  socket.onmessage = (frame) => {
    const message = JSON.parse(frame.data)
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
      return
    }
    events.push(message)
  }
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  for (const domain of ['Page', 'Runtime', 'Log', 'Network']) await send(`${domain}.enable`, {}, sessionId)

  if (LIVE_COOKIE !== '') {
    const separator = LIVE_COOKIE.indexOf('=')
    await send('Network.setCookie', {
      name: LIVE_COOKIE.slice(0, separator),
      value: LIVE_COOKIE.slice(separator + 1),
      domain: target.hostname,
      path: '/',
      httpOnly: true,
    }, sessionId)
  }

  await send('Page.navigate', { url: LIVE_URL }, sessionId)

  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.text)
    return reply.result.value
  }

  // Poll rather than sleep for a guessed duration: boot time depends on how many
  // plugins the profile loads. The condition is the plugin's own stylesheet, which
  // is the thing under test, so a failure here is "it never arrived", not "too slow".
  const styleExpression = `(() => {
    const styles = Array.from(document.querySelectorAll('style'))
    const mine = styles.filter(s => (s.textContent || '').includes('.llmm-'))
    return { shell: document.getElementById('root')?.children.length ?? -1,
      count: mine.length, chars: mine.reduce((n, s) => n + (s.textContent || '').length, 0) }
  })()`
  let style = { shell: -1, count: 0, chars: 0 }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    style = await evaluate(styleExpression)
    if (style.count > 0) break
    await sleep(500)
  }
  // Once the plugin's styles exist, give the composer one more beat to settle so the
  // picker trigger is queryable and the crash report below has been emitted.
  await sleep(1500)

  const page = await evaluate(`(() => {
    const trigger = document.querySelector('.llmm-trigger')
    const style = trigger ? getComputedStyle(trigger) : null
    return {
      href: location.href,
      title: document.title,
      shell: document.getElementById('root')?.children.length ?? -1,
      pluginRoot: document.querySelector('.llmm-root') !== null,
      trigger: trigger !== null,
      triggerRadius: style?.borderTopLeftRadius ?? null,
      triggerPadding: style?.padding ?? null,
      unstyledButton: (() => {
        const probe = document.createElement('button')
        document.body.appendChild(probe)
        const bare = getComputedStyle(probe).borderTopLeftRadius
        probe.remove()
        return bare
      })(),
    }
  })()`)

  console.log(`\nlive: ${page.title} @ ${page.href}\n`)

  check('the real shell mounts', page.shell > 0, `#root has ${page.shell} child(ren)`)
  check('the plugin renders into the real composer', page.pluginRoot && page.trigger,
    `root=${String(page.pluginRoot)} trigger=${String(page.trigger)}`)
  check('the plugin\'s stylesheet reaches the real page', style.count === 1 && style.chars > 1000,
    `${style.count} style element(s), ${style.chars} chars`)

  // A user agent's default button has a 0-radius border box; the plugin's trigger is
  // 8px with the shipped picker's padding. Comparing against a freshly created element
  // rather than a hard-coded constant means this fails if the stylesheet is absent even
  // on a UA that rounds its own defaults.
  check('the stylesheet is actually applied, not merely present',
    page.triggerRadius !== page.unstyledButton
    && page.triggerRadius === '8px'
    && page.triggerPadding === '0px 4px 0px 8px',
    `trigger radius=${page.triggerRadius} padding=${page.triggerPadding}, bare button radius=${page.unstyledButton}`)

  // The specific failure that took the styles down. Matched on the message rather
  // than counted, so an unrelated console error cannot be mistaken for it.
  const crashes = events.filter(event =>
    (event.method === 'Runtime.consoleAPICalled' || event.method === 'Log.entryAdded')
    && JSON.stringify(event.params ?? {}).includes('slot entry crashed'))
  const injectErrors = events.filter(event =>
    (event.method === 'Runtime.consoleAPICalled' || event.method === 'Log.entryAdded')
    && JSON.stringify(event.params ?? {}).includes('without inject'))
  check('no slot entry crashed while booting the real app', crashes.length === 0,
    crashes.length === 0 ? 'none' : JSON.stringify(crashes[0].params).slice(0, 300))
  check('no service is reached without its inject declaration', injectErrors.length === 0,
    injectErrors.length === 0 ? 'none' : JSON.stringify(injectErrors[0].params).slice(0, 300))

  // The menu is the surface the pins/favorites work is about; assert its order on
  // the real catalogue, in whatever locale the browser reports.
  const menu = await evaluate(`(async () => {
    const trigger = document.querySelector('.llmm-trigger')
    if (!trigger) return { opened: false }
    trigger.click()
    await new Promise(r => setTimeout(r, 900))
    const menuEl = document.querySelector('.llmm-menu')
    if (!menuEl) return { opened: false }
    const body = menuEl.querySelector('.llmm-menu-body')
    return {
      opened: true,
      sections: Array.from(body.children).map(section => ({
        title: (section.querySelector('.llmm-group')?.textContent ?? '').trim(),
        rows: Array.from(section.querySelectorAll('.llmm-item')).map(item =>
          (item.querySelector('.llmm-name')?.textContent ?? '').trim()),
      })),
    }
  })()`)

  check('the picker menu opens in the real composer', menu.opened === true, JSON.stringify(menu).slice(0, 120))

  // The card's surface, measured against the theme the page is actually running.
  // This is the check the grey card would have failed: the plugin painted
  // --dsw-alias-bg-overlay, which the token contract documents as the popover
  // background but which resolves to a mid grey (#e9ecf2 light / #61666b dark) —
  // darker than the white composer it drops out of. Asserting a raw colour would
  // pin the suite to one theme, so assert the relationship instead: the card must
  // not be that scrim token, and it must sit close to the page in light mode and
  // close to the raised layers in dark mode, i.e. read as a surface, not a shadow.
  const surface = await evaluate(`(() => {
    const menuEl = document.querySelector('.llmm-menu')
    if (!menuEl) return { ok: false }
    const paint = getComputedStyle(menuEl, '::before').backgroundColor
    const pageBg = getComputedStyle(document.body).backgroundColor
    // Resolve the scrim token through the browser rather than parsing it: custom
    // properties come back as authored (#e9ecf2), and a hex parser here would
    // silently read null and make the comparison vacuous.
    const probe = document.createElement('div')
    probe.style.backgroundColor = 'var(--dsw-alias-bg-overlay)'
    document.body.appendChild(probe)
    const scrimColor = getComputedStyle(probe).backgroundColor
    probe.remove()
    const parse = (c) => {
      const m = String(c).match(/rgba?\\(([^)]+)\\)/)
      if (!m) return null
      const p = m[1].split(',').map(Number)
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
    }
    const over = (fg, bg) => {
      const f = parse(fg); const b = parse(bg)
      if (!f || !b) return null
      return { r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a) }
    }
    const painted = over(paint, pageBg)
    const scrim = over(scrimColor, pageBg)
    const luma = (c) => c === null ? null : (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b)
    const distance = (a, b) => a === null || b === null ? null
      : Math.round(Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2))
    return {
      ok: true, paint, scrimColor,
      luma: Math.round(luma(painted)),
      scrimLuma: Math.round(luma(scrim)),
      distanceFromPage: distance(painted, parse(pageBg)),
      distanceFromScrim: distance(painted, scrim),
    }
  })()`)
  // The material is the menu fill (58%/45% opaque light/dark) composited over the
  // page, so a near-white page yields a near-white card and a #151517 page a dark
  // one. "Reads as a surface" = the card's luminance stays on the page's side.
  const cardSurfaceOk = surface.ok === true && surface.distanceFromScrim > 4
    && (surface.luma > 200 ? surface.distanceFromPage <= 12 : surface.luma < 90)
  check('the menu card takes the menu material, not the overlay scrim', cardSurfaceOk,
    surface.ok
      ? `painted=${surface.paint} luma=${surface.luma} vs scrim luma=${surface.scrimLuma} `
        + `(distance ${surface.distanceFromScrim}, from page ${surface.distanceFromPage})`
      : 'the menu did not render')
  const sections = menu.sections ?? []
  const pinnedFirst = /^(Pinned|置顶) \(/.test(sections[0]?.title ?? '')
  check('the menu leads with the pinned section', pinnedFirst, sections.map(s => s.title).join(' | '))
  const favoritesSecond = sections.length < 2 || /^(Favorites|收藏) \(/.test(sections[1]?.title ?? '')
  check('favorites follow when the menu has more than one section', favoritesSecond,
    sections.map(s => s.title).join(' | '))
  const allRows = sections.flatMap(section => section.rows)

  // Compare the rendered menu against the plugin's own catalogue instead of against
  // a hard-coded count. Comparing bare names would be wrong: the same model id on two
  // routes is two different selections, so a name legitimately appears more than once.
  // The move-not-copy property still holds on names alone — a lifted row that was
  // COPIED rather than moved would push some name's multiplicity above the
  // catalogue's. Equal totals plus "never more than the catalogue" makes the two
  // multisets equal, which proves nothing was lost, duplicated, or invented.
  const catalogue = await evaluate(`(async () => {
    const reply = await fetch('/api/llm-manage', { headers: { accept: 'application/json' } })
    const body = await reply.json()
    const groups = body?.value?.groups ?? []
    const counts = {}
    for (const group of groups) {
      for (const row of group.rows ?? []) {
        if (row.hidden === true) continue
        counts[row.model] = (counts[row.model] ?? 0) + 1
      }
    }
    return { ok: body?.ok === true, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) }
  })()`)

  check('the plugin\'s own catalogue is readable from the live app', catalogue.ok === true,
    `${catalogue.total} offered models`)

  const shown = {}
  for (const name of allRows) shown[name] = (shown[name] ?? 0) + 1
  const inflated = Object.entries(shown).filter(([name, count]) => count > (catalogue.counts[name] ?? 0))
  check('no model appears more often than the catalogue offers it', inflated.length === 0,
    inflated.length === 0 ? `${allRows.length} rows over ${Object.keys(shown).length} distinct names`
      : inflated.slice(0, 4).map(([name, count]) => `${name} x${count} > ${catalogue.counts[name] ?? 0}`).join('; '))
  check('the menu offers every model the catalogue lists, and invents none',
    allRows.length === catalogue.total,
    `menu ${allRows.length} rows vs catalogue ${catalogue.total}`)
}

try {
  await main()
} finally {
  socket?.close()
  browser.kill('SIGKILL')
  rmSync(profile, { recursive: true, force: true })
}

const failed = results.filter(result => result.passed === false)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log(failed.map(result => `  FAIL ${result.label}`).join('\n'))
  process.exit(1)
}
