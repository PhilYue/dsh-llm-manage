/**
 * Upstream parity guard for the seats this plugin takes over.
 *
 * The plugin replaces shipped UI (`conversation.input.model`) and cannot inherit
 * that seat's child slots: the framework only injects `renderSlot` into an entry
 * that declares `children` itself, and the slot table refuses a second
 * declaration of the same child key. So every row the shipped menu appends is
 * lost the moment we take the seat — silently, because the replacement simply
 * renders fewer things. That has already happened once (`ui-agent-team`'s
 * teamwork switch disappeared without a trace).
 *
 * This guard turns that class of loss from "someone has to remember to compare"
 * into a check that fails loudly:
 *   1. every child slot the manifest claims still exists upstream;
 *   2. every upstream entry registered into those child slots is either
 *      reproduced by us or skipped with a reason on record;
 *   3. the copy we reproduce is still the shipped copy, verbatim, zh and en.
 *
 * Run with DSH_CHECKOUT pointing at the harness checkout:
 *   node tools/check-upstream.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const checkout = process.env.DSH_CHECKOUT ?? ''
if (checkout === '') {
  console.error('DSH_CHECKOUT is not set; point it at the harness checkout to compare.')
  process.exit(2)
}

const manifest = JSON.parse(readFileSync(join(root, 'docs/upstream-parity.json'), 'utf8'))
const clientSource = readFileSync(join(root, 'client.js'), 'utf8')

const failures = []
const check = (ok, name, detail) => {
  if (!ok) failures.push(detail === undefined ? name : `${name} — ${detail}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
}

/**
 * A single-quoted TypeScript string literal, tolerating escapes.
 * @param text - source text
 * @param at - index of the opening quote
 * @returns the literal body and the index just past the closing quote
 */
function readLiteral(text, at) {
  let value = ''
  let index = at + 1
  while (index < text.length) {
    const character = text[index]
    if (character === '\\') {
      const next = text[index + 1]
      if (next === 'u') {
        value += String.fromCharCode(Number.parseInt(text.slice(index + 2, index + 6), 16))
        index += 6
        continue
      }
      value += next
      index += 2
      continue
    }
    if (character === "'") return { value, end: index + 1 }
    value += character
    index += 1
  }
  throw new Error(`unterminated literal at ${at}`)
}

/**
 * Collect `key: 'value'` pairs from object literals, in source order.
 * @param text - module source
 * @param start - index to start scanning from
 * @param end - index to stop at
 * @returns ordered key/value pairs
 */
function readDictionary(text, start, end) {
  const pairs = []
  const pattern = /(?:^|[\s,{])(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*'/g
  pattern.lastIndex = start
  let match = pattern.exec(text)
  while (match !== null && match.index < end) {
    const quote = text[match.index + match[0].length - 1] === "'"
      ? match.index + match[0].length - 1
      : text.indexOf("'", match.index + match[0].length - 1)
    const literal = readLiteral(text, quote)
    pairs.push({ key: match[1] ?? match[2], value: literal.value })
    pattern.lastIndex = literal.end
    match = pattern.exec(text)
  }
  return pairs
}

/**
 * Every source file under a directory, skipping build output and dependencies.
 * @param directory - absolute path to walk
 * @returns absolute file paths
 */
function listSources(directory) {
  const found = []
  const walk = (current) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'dist') continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name)) found.push(full)
    }
  }
  walk(directory)
  return found
}

// ── 1 + 2: the seats we take over keep their child slots, and we know every row
const upstreamSources = listSources(join(checkout, 'packages'))
console.log(`scanning ${upstreamSources.length} upstream source file(s)`)
for (const slot of manifest.slots) {
  let source
  try {
    source = readFileSync(join(checkout, slot.source), 'utf8')
  } catch {
    check(false, `${slot.key} still exists upstream`, `${slot.source} is gone`)
    continue
  }
  for (const child of slot.children) {
    check(source.includes(`'${child.key}'`),
      `${slot.key} still declares ${child.key}`,
      `${slot.source} no longer names this child slot`)

    const known = new Set(child.occupants.map(occupant => occupant.id))
    const shipped = child.occupants.filter(occupant => occupant.origin !== 'ours')
    const pattern = new RegExp(`name:\\s*'${child.key.replace(/\./g, '\\.')}'[\\s\\S]{0,120}?\\bid:\\s*'([^']+)'`, 'g')
    const registrations = []
    for (const file of upstreamSources) {
      const text = readFileSync(file, 'utf8')
      if (!text.includes(child.key)) continue
      pattern.lastIndex = 0
      let match = pattern.exec(text)
      while (match !== null) {
        registrations.push({ id: match[1], file: file.slice(checkout.length + 1) })
        match = pattern.exec(text)
      }
    }
    const unknown = registrations.filter(entry => !known.has(entry.id))
    check(unknown.length === 0,
      `every upstream row in ${child.key} is accounted for`,
      unknown.map(entry => `${entry.id} (${entry.file})`).join(', '))
    const expected = child.occupants.filter(occupant => occupant.origin !== 'ours')
    const missing = expected
      .filter(occupant => !registrations.some(entry => entry.id === occupant.id))
    check(missing.length === 0,
      `the rows we reproduce for ${child.key} are still shipped upstream`,
      missing.map(occupant => occupant.id).join(', '))
  }
}

// ── 3: reproduced copy stays the shipped copy
const copy = manifest.copy
const upstreamCopy = readFileSync(join(checkout, copy.source), 'utf8')
const oursStart = clientSource.indexOf('const DICT = {')
if (oursStart === -1) throw new Error('client.js no longer has a DICT literal')
const oursEnd = clientSource.indexOf('\n    const LANG', oursStart)
if (oursEnd === -1) throw new Error('client.js DICT is no longer followed by the LANG statement')
const oursPairs = readDictionary(clientSource, oursStart, oursEnd)
const half = oursPairs.length / 2
if (!Number.isInteger(half)) throw new Error(`DICT has ${oursPairs.length} entries; expected an even en/zh split`)
const oursEn = new Map(oursPairs.slice(0, half).map(pair => [pair.key, pair.value]))
const oursZh = new Map(oursPairs.slice(half).map(pair => [pair.key, pair.value]))
// The shipped module declares zh first (it is the key source) and en second.
const zhStart = upstreamCopy.indexOf('export const zh')
const enStart = upstreamCopy.indexOf('export const en')
const upstreamZh = new Map(readDictionary(upstreamCopy, zhStart, enStart).map(pair => [pair.key, pair.value]))
// The shipped module keeps exporting further locales (pt, ja, …) after en; stop at the
// next export or a later dictionary silently overwrites the pairs we are comparing.
const enEnd = upstreamCopy.indexOf('export const ', enStart + 10)
const upstreamEn = new Map(
  readDictionary(upstreamCopy, enStart, enEnd === -1 ? upstreamCopy.length : enEnd)
    .map(pair => [pair.key, pair.value]),
)

for (const [upstreamKey, ourKey] of copy.keys) {
  const zh = upstreamZh.get(upstreamKey)
  const en = upstreamEn.get(upstreamKey)
  check(zh !== undefined && oursZh.get(ourKey) === zh,
    `zh copy for ${upstreamKey} matches the shipped wording`,
    `ours=${JSON.stringify(oursZh.get(ourKey) ?? null)}`)
  check(en !== undefined && oursEn.get(ourKey) === en,
    `en copy for ${upstreamKey} matches the shipped wording`,
    `ours=${JSON.stringify(oursEn.get(ourKey) ?? null)}`)
}

console.log('')
if (failures.length === 0) {
  console.log('upstream parity holds')
  process.exit(0)
}
console.log(`${failures.length} upstream parity failure(s):`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(1)
