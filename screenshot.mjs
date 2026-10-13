/**
 * dsh-llm-manage — screenshot the INSTALLED plugin, from the running Harness.
 *
 * This replaces `preview.mjs`, which rendered the plugin into a hand-written page
 * with a hand-written theme. That page defined `--dsw-alias-bg-overlay:#fff`, a value
 * the token never has in the app (its light value is #e9ecf2), so the preview showed a
 * white card and the real app painted a grey one. The mock also declared only the 14
 * tokens the plugin contract documents, while the plugin reads 27 — the rest silently
 * resolved to nothing. A preview that supplies its own theme cannot show you the theme,
 * and an approved mock is worse than no mock.
 *
 * This script supplies nothing. It opens the URL that `dsh web` prints, in a real
 * engine, against the real profile and the real model catalogue, and photographs what
 * is there. It reads the page's own tokens for nothing and asserts nothing about
 * colour; the layout it captures is the layout a user gets.
 *
 * Usage:
 *   DSH_LIVE_URL='http://127.0.0.1:3080/?token=…' node screenshot.mjs
 *   DSH_LIVE_URL=http://127.0.0.1:3080/ DSH_LIVE_COOKIE="$(cat cookie.txt)" node screenshot.mjs
 *
 * Writes docs/picker-<scheme>.png and docs/panel-<scheme>.png. Exits 0 without
 * writing when no Harness answers, so it is safe in a repo checkout but never
 * claims to have captured anything it did not.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, 'docs')
const URL_ = process.env.DSH_LIVE_URL ?? ''
const COOKIE = process.env.DSH_LIVE_COOKIE ?? ''

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)
const CHROME = CHROME_CANDIDATES.find(candidate => existsSync(candidate))

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const skip = reason => { console.log(`screenshot: SKIP — ${reason}`); process.exit(0) }

if (URL_ === '') skip('set DSH_LIVE_URL to the URL `dsh web` printed')
if (CHROME === undefined) skip('no Chrome/Chromium binary found (set CHROME_PATH)')

try {
  const probe = await fetch(URL_, { redirect: 'manual' })
  if (probe.status >= 400 && probe.status !== 401) skip(`${URL_} answered ${probe.status}`)
} catch (error) {
  skip(`${URL_} is not answering (${error.message})`)
}

const profile = mkdtempSync(join(tmpdir(), 'llmm-shot-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--window-size=1400,1000', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] })

const cleanup = () => {
  try { chrome.kill('SIGKILL') } catch { /* already gone */ }
  rmSync(profile, { recursive: true, force: true })
}
process.on('exit', cleanup)

let ws
for (let attempt = 0; attempt < 80; attempt += 1) {
  try {
    const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]
    const reply = await fetch(`http://127.0.0.1:${port}/json/version`)
    if (reply.ok) { ws = (await reply.json()).webSocketDebuggerUrl; break }
  } catch { /* still starting */ }
  await sleep(250)
}
if (ws === undefined) skip('Chrome never reported a debugging port')

const socket = new WebSocket(ws)
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
let nextId = 1
const pending = new Map()
socket.onmessage = (frame) => {
  const message = JSON.parse(frame.data)
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  }
}
const send = (method, params = {}, sessionId) => new Promise((resolve) => {
  const id = nextId++
  pending.set(id, message => resolve(message.result))
  socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
})

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)
if (COOKIE !== '') {
  const separator = COOKIE.indexOf('=')
  await send('Network.setCookie', {
    name: COOKIE.slice(0, separator),
    value: COOKIE.slice(separator + 1),
    domain: new URL(URL_).hostname,
    path: '/',
    httpOnly: true,
  }, sessionId)
}

const evaluate = async (expression) => {
  const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.text)
  return reply.result.value
}

/** Crop to an element, padded, at 2x — the card, or the panel. */
const capture = async (selector, pad, file) => {
  const box = await evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)})
    if (node === null) return null
    const rect = node.getBoundingClientRect()
    return { x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.round(rect.width), height: Math.round(rect.height) }
  })()`)
  if (box === null || box.width === 0 || box.height === 0) return null
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2, scale: 2 },
    captureBeyondViewport: true,
  }, sessionId)
  writeFileSync(join(OUT_DIR, file), Buffer.from(shot.data, 'base64'))
  return { ...box, file }
}

for (const scheme of ['light', 'dark']) {
  // Light keeps the canonical filename the README links (docs/picker.png); dark is the
  // suffixed companion. A suffixed-only set would leave every existing link dangling.
  const suffix = scheme === 'light' ? '' : `-${scheme}`
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, sessionId)
  await send('Page.navigate', { url: URL_ }, sessionId)
  // Poll for the plugin's own stylesheet: the condition under test is its arrival,
  // so a timeout means "it never booted", not "the machine was slow".
  let booted = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    booted = await evaluate(`Array.from(document.querySelectorAll('style')).some(s => (s.textContent || '').includes('.llmm-'))`)
    if (booted) break
    await sleep(500)
  }
  if (!booted) { console.error(`screenshot: the plugin never booted in ${scheme}; nothing written`); continue }
  await sleep(1500)

  // The settings panel. It registers into `settings.models.provider-card`, so there is no
  // URL for it and no element to query until the settings UI is open. It is opened the way
  // a user opens it: the `settings.open` shortcut. On the web runtime that chord is
  // primary+alt+Comma (ui-settings-general registers it per platform), so it is Cmd+Alt+,
  // on macOS here — plain Cmd+, is the desktop runtime's binding and does nothing.
  //
  // Then the Models section is found by clicking candidate nav entries and keeping the one
  // that reveals the panel, rather than matching a label: the labels are localised, and a
  // screenshot tool that only works in one language is a screenshot tool that silently
  // stops working.
  for (const type of ['keyDown', 'char', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type, modifiers: 5, key: ',', code: 'Comma',
      windowsVirtualKeyCode: 188, nativeVirtualKeyCode: 43,
      text: type === 'char' ? ',' : undefined, unmodifiedText: ',',
    }, sessionId)
    await sleep(120)
  }
  await sleep(2000)

  const panelReady = await evaluate(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms))
    if (document.querySelector('.llmm-panel') !== null) return true
    const dialog = document.querySelector('[role="dialog"]')
    if (dialog === null) return false
    const nav = Array.from(dialog.querySelectorAll('button, [role="tab"]'))
    for (const entry of nav) {
      entry.click()
      await wait(900)
      if (document.querySelector('.llmm-panel') !== null) return true
    }
    return false
  })()`)
  if (panelReady !== true) {
    console.log(`  panel   ${scheme}: not reachable — settings did not expose the panel`)
  } else {
    await evaluate(`document.querySelector('.llmm-panel').scrollIntoView({ block: 'center' })`)
    await sleep(600)
    const shot = await capture('.llmm-panel', 0, `panel${suffix}.png`)
    console.log(shot === null ? `  panel   ${scheme}: not measurable`
      : `  panel   ${scheme}: ${shot.width}x${shot.height} → docs/${shot.file}`)
    // Leave the settings UI before photographing the composer, or the modal covers it.
    await evaluate(`(() => {
      const close = document.querySelector('[role="dialog"] [aria-label*="lose"], [role="dialog"] [aria-label*="关闭"]')
      if (close) close.click()
      return true
    })()`)
    await sleep(900)
  }

  // Open the picker, then photograph the card itself. The card is portaled, so it is
  // not inside .llmm-root and has to be measured on its own.
  const opened = await evaluate(`(async () => {
    const trigger = document.querySelector('.llmm-trigger')
    if (trigger === null) return false
    trigger.click()
    await new Promise(r => setTimeout(r, 900))
    return document.querySelector('.llmm-menu') !== null
  })()`)
  if (!opened) { console.error(`  picker  ${scheme}: did not open`); continue }
  const picker = await capture('.llmm-menu', 12, `picker${suffix}.png`)
  console.log(picker === null ? `  picker  ${scheme}: not measurable` : `  picker  ${scheme}: ${picker.width}x${picker.height} → docs/${picker.file}`)

  // The menu is 100+ rows tall; a photograph of the top of the list is what a README
  // wants, and cropping to the whole scroll height would be a wall of text.
  const trimmed = await evaluate(`(() => {
    const menu = document.querySelector('.llmm-menu')
    const body = menu.querySelector('.llmm-menu-body')
    let removed = 0
    for (const section of Array.from(body.children)) {
      const title = (section.querySelector('.llmm-group')?.textContent ?? '')
      if (/^(Pinned|Favorites|置顶|收藏)/.test(title)) continue
      for (const row of Array.from(section.querySelectorAll('.llmm-item')).slice(3)) { row.remove(); removed += 1 }
    }
    return { removed, height: Math.round(menu.getBoundingClientRect().height) }
  })()`)
  const card = await capture('.llmm-menu', 12, `picker${suffix}.png`)
  console.log(`  card    ${scheme}: trimmed ${trimmed.removed} rows, height ${trimmed.height}`
    + (card === null ? '' : ` → docs/${card.file}`))
}

socket.close()
cleanup()
