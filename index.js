/**
 * dsh-llm-manage — Host half.
 *
 * Owns one persistent overlay over whatever `ctx.llm` advertises for a route:
 * favorites and pins, hidden rows, recent use, and per-model health with the
 * reason a model is unusable. It then does two things a stock profile cannot:
 *
 * 1. Reconciles the route's configured `models:` list against the gateway's own
 *    `GET {baseURL}/models` directory, which is the only authoritative, free
 *    "still exists" signal. Catalog membership is never trusted as proof a
 *    model can actually serve a request — live probing on this gateway showed
 *    Claude, Gemini, Qwen-VL and image models advertised but uncallable.
 * 2. Recovers one model's exhausted quota by moving the session to the next
 *    usable model in a configurable chain, and records that it did so instead
 *    of switching silently.
 *
 * Health is learned three ways, cheapest first. The free directory set is read
 * on demand; real request failures are classified as they happen (passive
 * learning, zero extra traffic); and explicit deep probes are manual, serial
 * and throttled because this gateway meters the whole API key, so an automatic
 * sweep of a large catalogue would lock the user out of their own gateway.
 *
 * @module dsh-llm-manage
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Loader row id; also the store directory name. */
export const name = 'llm-manage'

/** Overlay document version; bump when the fold semantics change. */
const STORE_VERSION = 1

/** Upper bound on retained recent-use rows, newest first. */
const RECENT_LIMIT = 40

/** Upper bound on retained health rows so one huge catalog cannot grow the file without end. */
const HEALTH_LIMIT = 4000

/**
 * Upper bound on retained per-model usage rows inside one route file. Usage is
 * keyed by model, so a huge catalog could otherwise grow the file without end.
 */
const USAGE_LIMIT = 300

/**
 * Per-day buckets retained per model. Only the recent window is needed: heat
 * decays with a 14-day half-life, so a bucket older than this contributes
 * nothing a user could act on, while its total is already folded into `uses`.
 */
const USAGE_DAY_WINDOW = 30

/**
 * Half-life of the heat score, in days. A use 14 days old counts half as much as
 * one from today, which is what makes the ordering track current habits instead
 * of a lifetime total.
 */
const HEAT_HALF_LIFE_DAYS = 14

/**
 * Cumulative model round-trips required for each proficiency level, index 0
 * being level 1. A level is a trophy: it is derived from the lifetime total and
 * therefore never decreases, while ordering uses the decaying heat score. That
 * split is deliberate — one number cannot be both a stable achievement and a
 * current-habit signal.
 */
const LEVEL_STEPS = [0, 10, 30, 80, 200, 500, 1200]

/**
 * How long usage deltas accumulate in memory before one durable write. A model
 * step must never pay for a disk write, and a long tool call can produce many
 * steps in a row.
 */
const USAGE_FLUSH_MS = 5000

/** Most sessions one backfill pass will read, newest first. */
const SEED_SESSION_LIMIT = 300

/** Upper bound on remembered backfilled session ids, so the watermark cannot grow forever. */
const SEED_MARK_LIMIT = 2000

/** How long a model marked quota-exhausted is skipped by the fallback chain. */
const QUOTA_COOLDOWN_MS = 30 * 60 * 1000

/** How long a recorded model override waits for the retry that consumes it. */
const OVERRIDE_TTL_MS = 30 * 1000

/** Automatic model switches allowed per session and turn before the turn is left to fail. */
const MAX_FALLBACKS_PER_TURN = 3

/** How long a deep-probe result is trusted before it is treated as stale. */
const PROBE_FRESH_MS = 6 * 60 * 60 * 1000

/**
 * Business codes this plugin's gateway reports in its error body.
 *
 * The gateway reports a per-model quota exhaustion as `429`, which DSH's own
 * classifier maps to a retryable `RATE_LIMIT` — indistinguishable from an
 * account-wide rate limit. The two need opposite handling, so the numeric code
 * is read from the body instead of trusting the mapped code.
 */
const GW_MODEL_MISSING = 4010
const GW_MODEL_QUOTA = 2007
const GW_KEY_RATE_LIMIT = 2008

/**
 * Why a model is unusable. Ordered most-specific first; the first match wins.
 * @enum {string}
 */
const REASON = {
  /** The gateway no longer serves this model at all. */
  RETIRED: 'retired',
  /** The gateway serves it, but not over this route's protocol. */
  PROTOCOL: 'protocol',
  /** This model's quota is exhausted; another model may still work. */
  QUOTA: 'quota',
  /** The API key is being rate limited; switching models cannot help. */
  RATE_LIMITED: 'rate_limited',
  /** A probe or request failed for any other reason. */
  ERROR: 'error',
  /** Verified reachable. */
  OK: 'ok',
}

/** Reasons that make the fallback chain skip a model. */
const UNUSABLE_REASONS = new Set([REASON.RETIRED, REASON.PROTOCOL, REASON.QUOTA, REASON.ERROR])

/**
 * Provider wording that identifies an exhausted quota rather than a transient
 * rate limit. Mirrors `isQuotaExceededError` from `@deepseek-ai/dsh-llm`, plus
 * the Chinese wording this gateway actually returns ("配额已用尽"), which the
 * upstream English-only classifier does not match — it falls through to
 * `RATE_LIMIT`, whose code IS retryable, so the stock retry policy would back
 * off against a limit that cannot recover.
 * @param {string} text - failure message or provider body text.
 * @returns {boolean} whether the text describes exhausted quota.
 */
function looksLikeQuota(text) {
  return /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(text)
    || /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(text)
    || /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i.test(text)
    || /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i.test(text)
    || /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(text)
    || /配额已用尽|额度已用尽|配额不足|余额不足|配额超限/.test(text)
}

/**
 * Read the gateway's numeric business code out of a provider body.
 * @param {string} text - raw failure text.
 * @returns {number | undefined} the code, when one is present.
 */
function gatewayCode(text) {
  const quoted = /"code"\s*:\s*(\d+)/.exec(text)
  if (quoted !== null) return Number(quoted[1])
  const bare = /\bcode[=:\s]+(\d{3,5})\b/i.exec(text)
  return bare === null ? undefined : Number(bare[1])
}

/**
 * Classify one failure into a health reason and whether moving to another model
 * could help.
 * @param {{ code?: string, message?: string, status?: number }} failure - the LlmFailure the loop reported.
 * @returns {{ reason: string, detail: string, scope: 'model'|'route'|'account'|'none', switchable: boolean }} the verdict.
 */
function classifyFailure(failure) {
  const text = `${failure?.code ?? ''} ${failure?.message ?? ''}`
  const code = gatewayCode(text)
  const detail = String(failure?.message ?? '').slice(0, 400)

  if (code === GW_MODEL_MISSING || /模型不存在|model not found|does not exist|unknown model/i.test(text)) {
    return { reason: REASON.RETIRED, detail, scope: 'model', switchable: true }
  }
  if (code === GW_MODEL_QUOTA || failure?.code === 'QUOTA') {
    return { reason: REASON.QUOTA, detail, scope: 'model', switchable: true }
  }
  if (failure?.code === 'ACCOUNT_QUOTA' || code === GW_KEY_RATE_LIMIT) {
    // The whole API key is limited. Another model shares that key, so switching
    // cannot help and would only hide the real problem.
    return { reason: REASON.RATE_LIMITED, detail, scope: 'account', switchable: false }
  }
  if (looksLikeQuota(text)) {
    return { reason: REASON.QUOTA, detail, scope: 'model', switchable: true }
  }
  if (failure?.code === 'RATE_LIMIT') {
    return { reason: REASON.RATE_LIMITED, detail, scope: 'account', switchable: false }
  }
  if (/model not support|not supported for this (?:route|protocol)|unsupported (?:protocol|model)/i.test(text)) {
    return { reason: REASON.PROTOCOL, detail, scope: 'model', switchable: true }
  }
  return { reason: REASON.ERROR, detail, scope: 'model', switchable: true }
}

/**
 * A positive integer from untrusted config, or the fallback.
 * @param {unknown} value - configured value.
 * @param {number} fallback - value to use when unusable.
 * @returns {number} a usable positive integer.
 */
function positiveInt(value, fallback) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

/**
 * A non-negative integer from untrusted config, or the fallback.
 * @param {unknown} value - configured value.
 * @param {number} fallback - value to use when unusable.
 * @returns {number} a usable integer.
 */
function nonNegativeInt(value, fallback) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
}

/**
 * A trimmed non-empty string, or undefined.
 * @param {unknown} value - candidate.
 * @returns {string | undefined} the trimmed string.
 */
function cleanString(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Local calendar day of an instant, as `YYYY-MM-DD`.
 *
 * Days are bucketed by the user's own calendar day rather than by a UTC or
 * 24-hour window: "I used it today" has to mean the day the user is living in,
 * or the heat score would disagree with the panel's own timestamps near midnight.
 * @param {number} at - epoch milliseconds.
 * @returns {string} the day key.
 */
function dayKeyOf(at) {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Whole-day index of a `YYYY-MM-DD` key, so two keys can be subtracted.
 * @param {string} key - day key.
 * @returns {number} days since the epoch.
 */
function dayIndexOf(key) {
  const parts = key.split('-')
  return Math.floor(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])) / 86400000)
}

/**
 * Sum one model's usage over a 7-day window ending `offsetDays` ago.
 * @param {Record<string, number>} days - per-day buckets.
 * @param {number} today - today's day index.
 * @param {number} offsetDays - 0 for the last 7 days, 7 for the 7 before that.
 * @returns {number} the summed count.
 */
function windowCount(days, today, offsetDays) {
  let total = 0
  for (const [key, count] of Object.entries(days)) {
    const age = today - dayIndexOf(key)
    if (age >= offsetDays && age < offsetDays + 7) total += count
  }
  return total
}

/**
 * The decaying heat score: recent use counts most, and nothing has to be
 * re-scheduled because the decay is applied when the value is read.
 * @param {Record<string, number>} days - per-day buckets.
 * @param {number} today - today's day index.
 * @returns {number} the score.
 */
function heatOf(days, today) {
  let score = 0
  for (const [key, count] of Object.entries(days)) {
    const age = today - dayIndexOf(key)
    // A bucket dated in the future only appears when the clock moved backwards;
    // counting it would let one bad timestamp dominate the ordering.
    if (age < 0 || age > 3650) continue
    score += count * Math.pow(0.5, age / HEAT_HALF_LIFE_DAYS)
  }
  return score
}

/**
 * Fold one model's stored counters into what the UI renders.
 *
 * Everything the panel shows is derived here rather than in the browser half, so
 * the picker, the panel and the tool cannot disagree about what "level 4" means.
 * @param {object} entry - stored usage counters.
 * @param {number} now - current epoch milliseconds.
 * @returns {object} the derived view.
 */
function usageView(entry, now) {
  const days = entry?.days ?? {}
  const uses = entry?.uses ?? 0
  const today = dayIndexOf(dayKeyOf(now))
  let level = 1
  for (let index = 0; index < LEVEL_STEPS.length; index += 1) {
    if (uses >= LEVEL_STEPS[index]) level = index + 1
  }
  const floor = LEVEL_STEPS[level - 1]
  const ceiling = LEVEL_STEPS[level]
  const recent7 = windowCount(days, today, 0)
  const prior7 = windowCount(days, today, 7)
  return {
    uses,
    attempts: entry?.attempts ?? 0,
    inputTokens: entry?.in ?? 0,
    outputTokens: entry?.out ?? 0,
    firstAt: entry?.firstAt ?? 0,
    lastAt: entry?.lastAt ?? 0,
    level,
    /** Round-trips needed for the next level, or 0 when the model is maxed. */
    nextAt: ceiling ?? 0,
    /** Share of the way to the next level, 0..1; 1 when maxed. */
    progress: ceiling === undefined ? 1 : (uses - floor) / (ceiling - floor),
    heat: Number(heatOf(days, today).toFixed(3)),
    recent7,
    prior7,
    /** `up` when the last 7 days beat the 7 before, `down`, or `flat`. */
    trend: recent7 > prior7 ? 'up' : recent7 < prior7 ? 'down' : 'flat',
    seeded: (entry?.seededAt ?? 0) > 0,
  }
}

/**
 * Normalize the row's config into the shape the rest of the plugin uses.
 * Every field is optional, so an empty or partial row stays valid.
 * @param {Record<string, unknown> | undefined} raw - the Loader row's config.
 * @returns {object} resolved config.
 */
function resolveConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const selector = config.selector !== null && typeof config.selector === 'object' ? config.selector : {}
  const probe = config.probe !== null && typeof config.probe === 'object' ? config.probe : {}
  const directory = config.directory !== null && typeof config.directory === 'object' ? config.directory : {}
  const fallback = config.fallback !== null && typeof config.fallback === 'object' ? config.fallback : {}
  const usage = config.usage !== null && typeof config.usage === 'object' ? config.usage : {}
  const chain = Array.isArray(fallback.chain)
    ? fallback.chain.map(entry => cleanString(entry)).filter(entry => entry !== undefined)
    : []
  return {
    selector: { mode: selector.mode === 'native' ? 'native' : 'managed' },
    probe: {
      intervalMs: positiveInt(probe.intervalMs, 1200),
      timeoutMs: positiveInt(probe.timeoutMs, 30000),
      batch: positiveInt(probe.batch, 40),
    },
    directory: { ttlMs: nonNegativeInt(directory.ttlMs, 30 * 60 * 1000) },
    fallback: { enabled: fallback.enabled !== false, chain },
    usage: {
      /** Count real model round-trips into the per-model proficiency ledger. */
      enabled: usage.enabled !== false,
      /** Scan existing session logs once, so a fresh install is not level 1 everywhere. */
      seed: usage.seed !== false,
      flushMs: positiveInt(usage.flushMs, USAGE_FLUSH_MS),
    },
  }
}

/**
 * Parse one `route/model` chain entry.
 * @param {string} entry - configured chain entry.
 * @returns {{ route: string, model: string } | undefined} the parsed pair.
 */
function parseChainEntry(entry) {
  const at = entry.indexOf('/')
  if (at <= 0 || at === entry.length - 1) return undefined
  return { route: entry.slice(0, at).trim(), model: entry.slice(at + 1).trim() }
}

/** One durable overlay file per route, written atomically. */
class OverlayStore {
  /**
   * @param {string} dir - directory holding one JSON document per route.
   */
  constructor(dir) {
    this.dir = dir
    /** @type {Map<string, object>} */
    this.cache = new Map()
    /**
     * Serializes read-modify-write per route. Health recording is deliberately
     * fire-and-forget from an event listener, so without this a health write and
     * a concurrent pin toggle can both build on the same stale snapshot and one
     * of the two mutations is lost.
     * @type {Map<string, Promise<object>>}
     */
    this.pending = new Map()
    /**
     * In-flight first reads per route. Two callers that both miss the cache must
     * share one file read instead of racing to publish the same snapshot.
     * @type {Map<string, Promise<object>>}
     */
    this.reading = new Map()
  }

  /**
   * A safe on-disk file name for one route id.
   * @param {string} route - provider route id.
   * @returns {string} file name.
   */
  fileFor(route) {
    const safe = route.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
    return join(this.dir, `${safe}.json`)
  }

  /**
   * Read one route's overlay, falling back to an empty document.
   * @param {string} route - provider route id.
   * @returns {Promise<object>} the overlay.
   */
  async read(route) {
    const cached = this.cache.get(route)
    if (cached !== undefined) return cached
    const inflight = this.reading.get(route)
    if (inflight !== undefined) return inflight
    const load = (async () => {
      let overlay = emptyOverlay()
      try {
        const parsed = JSON.parse(await readFile(this.fileFor(route), 'utf8'))
        if (parsed !== null && typeof parsed === 'object') overlay = normalizeOverlay(parsed)
      } catch {
        // A missing or unreadable file is the normal first-run state, and a
        // corrupt one must not stop the user from configuring models again.
      }
      this.reading.delete(route)
      // A write may have committed while this read was in flight. Publishing
      // this older snapshot then would silently resurrect it and lose that
      // write, so the committed value wins.
      const latest = this.cache.get(route)
      if (latest !== undefined) return latest
      this.cache.set(route, overlay)
      return overlay
    })()
    this.reading.set(route, load)
    return load
  }

  /**
   * Every route with an overlay document on disk.
   *
   * The ledger is aggregated across routes, and a route whose models are all
   * unavailable is exactly the case a live catalog cannot enumerate — so the
   * directory itself is the source, not the current provider list.
   *
   * The stamped `route` wins over the file name because the name is sanitized:
   * reading it back as an id would invent a route that does not exist.
   * @returns {Promise<string[]>} route ids.
   */
  async routes() {
    let names
    try {
      names = await readdir(this.dir)
    } catch {
      return []
    }
    const found = []
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('__')) continue
      const base = name.slice(0, -'.json'.length)
      try {
        const parsed = JSON.parse(await readFile(this.fileFor(base), 'utf8'))
        found.push(cleanString(parsed?.route) ?? base)
      } catch {
        // An unreadable document still names a route the user configured.
        found.push(base)
      }
    }
    return found.sort()
  }

  /**
   * Apply a mutation to one route's overlay and persist it atomically.
   *
   * Mutations for one route run strictly one after another, so a concurrent
   * caller can never build on a snapshot another mutation has already replaced.
   *
   * @param {string} route - provider route id.
   * @param {(overlay: object) => object} mutate - pure mutation over a clone.
   * @returns {Promise<object>} the stored overlay.
   */
  async update(route, mutate) {
    const previous = this.pending.get(route) ?? Promise.resolve()
    // Chain regardless of the previous outcome: one failed write must not
    // permanently block every later write to the same route.
    const run = previous.then(() => this.commit(route, mutate), () => this.commit(route, mutate))
    // The chain swallows rejections so it stays usable; the caller still sees
    // the real rejection through `run`.
    this.pending.set(route, run.catch(() => {}))
    return run
  }

  /**
   * The actual read-modify-write step, reached only through {@link OverlayStore#update}.
   * @param {string} route - provider route id.
   * @param {(overlay: object) => object} mutate - pure mutation over a clone.
   * @returns {Promise<object>} the stored overlay.
   */
  async commit(route, mutate) {
    const current = await this.read(route)
    const next = normalizeOverlay(mutate(structuredClone(current)))
    next.revision = (current.revision ?? 0) + 1
    next.route = route
    this.cache.set(route, next)
    const file = this.fileFor(route)
    const temp = `${file}.${randomUUID()}.tmp`
    await mkdir(dirname(file), { recursive: true })
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    await rename(temp, file)
    return next
  }
}

/**
 * A fresh overlay document.
 * @returns {object} an empty overlay.
 */
function emptyOverlay() {
  return {
    version: STORE_VERSION,
    revision: 0,
    favorites: [],
    pins: [],
    hidden: [],
    recent: [],
    health: {},
    usage: {},
    seeded: {},
  }
}

/**
 * Keep only the newest per-day buckets.
 *
 * `YYYY-MM-DD` sorts lexicographically, so the window is a string sort rather
 * than a date parse. Dropping a bucket never loses the lifetime total: `uses`
 * holds that separately.
 * @param {Record<string, number>} days - per-day buckets.
 * @returns {Record<string, number>} the pruned buckets.
 */
function pruneDays(days) {
  const keys = Object.keys(days)
  if (keys.length <= USAGE_DAY_WINDOW) return days
  const kept = {}
  for (const key of keys.sort().slice(keys.length - USAGE_DAY_WINDOW)) kept[key] = days[key]
  return kept
}

/**
 * Keep the most-used models and drop the tail, so one enormous catalog cannot
 * grow a route file without end.
 * @param {Record<string, object>} usage - counters keyed by model id.
 * @returns {Record<string, object>} the pruned counters.
 */
function pruneUsage(usage) {
  const keys = Object.keys(usage)
  if (keys.length <= USAGE_LIMIT) return usage
  const kept = {}
  for (const key of keys.sort((left, right) => (usage[right].uses ?? 0) - (usage[left].uses ?? 0)).slice(0, USAGE_LIMIT)) {
    kept[key] = usage[key]
  }
  return kept
}

/**
 * Coerce stored usage counters into the current shape.
 *
 * Only numbers survive: a hand-edited or half-written file must never be able to
 * inject a string into a counter that later arithmetic would turn into `NaN`.
 * @param {unknown} raw - the stored `usage` value.
 * @returns {Record<string, object>} usable counters keyed by model id.
 */
function normalizeUsage(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const usage = {}
  for (const [model, value] of Object.entries(raw)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const days = {}
    if (value.days !== null && typeof value.days === 'object' && !Array.isArray(value.days)) {
      for (const [key, count] of Object.entries(value.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue
        if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) continue
        days[key] = Math.floor(count)
      }
    }
    usage[model] = {
      uses: nonNegativeInt(value.uses, 0),
      attempts: nonNegativeInt(value.attempts, 0),
      in: nonNegativeInt(value.in, 0),
      out: nonNegativeInt(value.out, 0),
      firstAt: nonNegativeInt(value.firstAt, 0),
      lastAt: nonNegativeInt(value.lastAt, 0),
      seededAt: nonNegativeInt(value.seededAt, 0),
      days: pruneDays(days),
    }
  }
  return usage
}

/**
 * The one persisted shape of one route's overlay.
 * @param {object} raw - parsed document.
 * @returns {object} a valid overlay.
 */
function normalizeOverlay(raw) {
  const refs = value => Array.isArray(value)
    ? value.map(entry => (entry !== null && typeof entry === 'object'
      ? { route: cleanString(entry.route), model: cleanString(entry.model) }
      : undefined))
      .filter(entry => entry?.route !== undefined && entry.model !== undefined)
      .slice(0, HEALTH_LIMIT)
    : []
  const health = {}
  if (raw.health !== null && typeof raw.health === 'object' && !Array.isArray(raw.health)) {
    for (const [key, value] of Object.entries(raw.health)) {
      if (value === null || typeof value !== 'object') continue
      health[key] = {
        status: typeof value.status === 'string' ? value.status : REASON.ERROR,
        source: typeof value.source === 'string' ? value.source : 'passive',
        detail: typeof value.detail === 'string' ? value.detail.slice(0, 400) : '',
        scope: typeof value.scope === 'string' ? value.scope : 'model',
        at: typeof value.at === 'number' ? value.at : 0,
      }
    }
  }
  // Backfilled session ids. They live in the overlay so the watermark survives a
  // restart: without it, every start would re-scan the same logs and count them
  // a second time.
  const seeded = {}
  if (raw.seeded !== null && typeof raw.seeded === 'object' && !Array.isArray(raw.seeded)) {
    const entries = Object.entries(raw.seeded)
      .filter(([, at]) => typeof at === 'number' && Number.isFinite(at))
      .sort((left, right) => right[1] - left[1])
      .slice(0, SEED_MARK_LIMIT)
    for (const [id, at] of entries) seeded[id] = at
  }
  return {
    version: STORE_VERSION,
    revision: typeof raw.revision === 'number' ? raw.revision : 0,
    // The file name is sanitized, so it cannot always be turned back into the
    // route id. Stamping the id keeps the document self-describing.
    route: cleanString(raw.route),
    favorites: refs(raw.favorites),
    pins: refs(raw.pins),
    hidden: refs(raw.hidden),
    recent: Array.isArray(raw.recent)
      ? raw.recent
        .map(entry => (entry !== null && typeof entry === 'object'
          ? { route: cleanString(entry.route), model: cleanString(entry.model), at: typeof entry.at === 'number' ? entry.at : 0 }
          : undefined))
        .filter(entry => entry?.route !== undefined && entry.model !== undefined)
        .slice(0, RECENT_LIMIT)
      : [],
    health,
    usage: normalizeUsage(raw.usage),
    seeded,
  }
}

/** Stable overlay key for one model on one route. */
function keyOf(route, model) {
  return `${route}/${model}`
}

/** Whether a ref list contains one exact model. */
function refHas(list, route, model) {
  return list.some(entry => entry.route === route && entry.model === model)
}

/** Remove one exact model from a ref list. */
function refWithout(list, route, model) {
  return list.filter(entry => !(entry.route === route && entry.model === model))
}

/**
 * Mount the Host half.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, unknown> | undefined} rawConfig - the Loader row's config.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const store = new OverlayStore(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'llm-manage'))

  /** Modest in-process cache of route catalogs, keyed by route id. */
  const catalogCache = new Map()
  /** Per-session model override awaiting the retry that consumes it. */
  const pendingOverride = new Map()
  /** Last request config seen per session, so a failure names the model it came from. */
  const lastRequest = new Map()
  /** Automatic switches already spent, per `sessionId/turn`. */
  const fallbacksThisTurn = new Map()
  /** Routes whose gateway directory was fetched, and when. */
  const directoryCache = new Map()
  /** Diagnostics counters, surfaced through the tool so the user can see real behaviour. */
  const diagnostics = { startedAt: Date.now(), observed: 0, classified: {}, fallbacks: 0, refusals: [], bySession: {}, usageCounted: 0, usageSeed: undefined }

  /**
   * Record one health verdict for a model.
   * @param {string} route - provider route id.
   * @param {string} model - model id.
   * @param {object} verdict - classification result.
   * @param {string} source - 'passive' | 'probe' | 'directory'.
   * @param {number} [at] - observation time.
   * @returns {Promise<void>} fulfillment after the write.
   */
  async function recordHealth(route, model, verdict, source, at = Date.now()) {
    await store.update(route, (overlay) => {
      const health = { ...overlay.health }
      health[keyOf(route, model)] = { status: verdict.reason, detail: verdict.detail ?? '', scope: verdict.scope ?? 'model', source, at }
      const keys = Object.keys(health)
      if (keys.length > HEALTH_LIMIT) {
        keys.sort((left, right) => (health[left].at ?? 0) - (health[right].at ?? 0))
        for (const key of keys.slice(0, keys.length - HEALTH_LIMIT)) delete health[key]
      }
      return { ...overlay, health }
    })
  }

  /**
   * Note that a model was actually used, for the recent-use ordering.
   * @param {string} route - provider route id.
   * @param {string} model - model id.
   * @returns {Promise<void>} fulfillment after the write.
   */
  async function recordUse(route, model) {
    await store.update(route, (overlay) => ({
      ...overlay,
      recent: [
        { route, model, at: Date.now() },
        ...overlay.recent.filter(entry => !(entry.route === route && entry.model === model)),
      ].slice(0, RECENT_LIMIT),
    }))
  }

  // ── Proficiency ledger ─────────────────────────────────────────────────────
  //
  // Which models the user actually works with, counted from committed model
  // round-trips rather than from clicks on a menu. The evidence is the session
  // log: `assistant/message` carries `message.source.{provider,model}` and that
  // call's `usage`, and it is appended exactly once per committed response, so a
  // retried request cannot inflate the count. `llm/stream` is deliberately NOT
  // used — its own contract says it wraps every call including retries, so one
  // request would count two or three times.

  /** The overlay document holding the backfill watermark; not a route. */
  const SEED_DOC = '__usage__'

  /** Pending per-route deltas, already in the stored counter shape. @type {Map<string, Map<string, object>>} */
  let usagePending = new Map()
  /** Pending flush timer, or undefined when nothing is waiting. */
  let usageTimer
  /** Serializes flushes so two batches cannot interleave one read-modify-write. */
  let usageChain = Promise.resolve()
  /**
   * `sessionId:seq` of every already-counted event. A resumed session can replay
   * its own tail, and the backfill scans logs the live subscriber may also see.
   * @type {Set<string>}
   */
  const countedUsage = new Set()

  /** A zeroed counter in the stored shape. */
  function blankUsage() {
    return { uses: 0, attempts: 0, in: 0, out: 0, firstAt: 0, lastAt: 0, seededAt: 0, days: {} }
  }

  /**
   * Add one increment to a counter.
   *
   * Both the pending and the stored counters use this shape, so one function
   * serves accumulation, persistence and the retry-after-failure path.
   * @param {object} current - counter to add to.
   * @param {object} incoming - counter to add.
   * @returns {object} the merged counter.
   */
  function mergeUsage(current, incoming) {
    const days = { ...(current.days ?? {}) }
    for (const [day, count] of Object.entries(incoming.days ?? {})) days[day] = (days[day] ?? 0) + count
    return {
      uses: (current.uses ?? 0) + (incoming.uses ?? 0),
      attempts: (current.attempts ?? 0) + (incoming.attempts ?? 0),
      in: (current.in ?? 0) + (incoming.in ?? 0),
      out: (current.out ?? 0) + (incoming.out ?? 0),
      firstAt: (current.firstAt ?? 0) === 0
        ? (incoming.firstAt ?? 0)
        : ((incoming.firstAt ?? 0) === 0 ? current.firstAt : Math.min(current.firstAt, incoming.firstAt)),
      lastAt: Math.max(current.lastAt ?? 0, incoming.lastAt ?? 0),
      seededAt: (incoming.seededAt ?? 0) > 0 ? ((current.seededAt ?? 0) || incoming.seededAt) : (current.seededAt ?? 0),
      days: pruneDays(days),
    }
  }

  /**
   * Build one increment in the stored counter shape.
   * @param {{ uses?: number, attempts?: number, inputTokens?: number, outputTokens?: number, at: number, seeded?: boolean }} input - one observation.
   * @returns {object} the increment.
   */
  function usageIncrement(input) {
    const uses = input.uses ?? 0
    const days = {}
    if (uses > 0) days[dayKeyOf(input.at)] = uses
    return {
      uses,
      attempts: input.attempts ?? 0,
      in: input.inputTokens ?? 0,
      out: input.outputTokens ?? 0,
      firstAt: uses > 0 ? input.at : 0,
      lastAt: input.at,
      seededAt: input.seeded === true ? input.at : 0,
      days,
    }
  }

  /**
   * Accumulate one observation in memory.
   *
   * A model step must never wait for a disk write, and a busy turn produces many
   * steps, so deltas are batched: the timer flushes them, and every read flushes
   * first. Reaching the file on time is not worth stalling a request for.
   * @param {string} route - provider route id.
   * @param {string} model - model id.
   * @param {object} increment - output of {@link usageIncrement}.
   * @returns {void}
   */
  function addUsage(route, model, increment) {
    let byModel = usagePending.get(route)
    if (byModel === undefined) {
      byModel = new Map()
      usagePending.set(route, byModel)
    }
    byModel.set(model, mergeUsage(byModel.get(model) ?? blankUsage(), increment))
    if (usageTimer === undefined) {
      usageTimer = setTimeout(() => { void flushUsage() }, config.usage.flushMs)
      // A pending count must never hold the process open.
      usageTimer.unref?.()
    }
  }

  /**
   * Persist every pending increment.
   * @returns {Promise<void>} fulfillment after each pending route was written.
   */
  async function flushUsage() {
    if (usageTimer !== undefined) {
      clearTimeout(usageTimer)
      usageTimer = undefined
    }
    if (usagePending.size === 0) return usageChain
    const batch = usagePending
    usagePending = new Map()
    usageChain = usageChain.then(async () => {
      for (const [route, byModel] of batch) {
        try {
          await store.update(route, (overlay) => {
            const usage = { ...overlay.usage }
            for (const [model, increment] of byModel) {
              usage[model] = mergeUsage(usage[model] ?? blankUsage(), increment)
            }
            return { ...overlay, usage: pruneUsage(usage) }
          })
        } catch {
          // A failed write must not silently drop counts: fold the batch back so
          // the next flush retries it. Recursion is bounded because the timer is
          // re-armed only by new observations.
          for (const [model, increment] of byModel) {
            let retry = usagePending.get(route)
            if (retry === undefined) {
              retry = new Map()
              usagePending.set(route, retry)
            }
            retry.set(model, mergeUsage(retry.get(model) ?? blankUsage(), increment))
          }
        }
      }
    })
    return usageChain
  }

  /** Whether one event was already counted, marking it when it was not. */
  function firstSight(sessionId, seq) {
    const key = `${sessionId}:${seq}`
    if (countedUsage.has(key)) return false
    // Bounded so a long-lived process cannot grow this set without end. Clearing
    // wholesale only risks one re-count of an ancient event.
    if (countedUsage.size >= 20000) countedUsage.clear()
    countedUsage.add(key)
    return true
  }

  /**
   * Fold one committed `assistant/message` into the ledger.
   * @param {object} event - the session event.
   * @param {string | undefined} sessionId - owning session.
   * @param {boolean} [seeded] - whether this came from the historical scan.
   * @returns {boolean} whether it was counted.
   */
  function countMessageEvent(event, sessionId, seeded = false) {
    if (event?.type !== 'assistant/message') return false
    if (sessionId === undefined || typeof event.seq !== 'number') return false
    const source = event.data?.message?.source
    const route = cleanString(source?.provider)
    const model = cleanString(source?.model)
    if (route === undefined || model === undefined) return false
    if (!firstSight(sessionId, event.seq)) return false
    const usage = event.data?.usage
    addUsage(route, model, usageIncrement({
      uses: 1,
      inputTokens: nonNegativeInt(usage?.inputTokens, 0),
      outputTokens: nonNegativeInt(usage?.outputTokens, 0),
      at: typeof event.time === 'number' ? event.time : Date.now(),
      seeded,
    }))
    return true
  }

  /**
   * Aggregate the ledger across routes.
   *
   * The picker asks "which models do I favour", which is a question about the
   * user rather than about a route, so both halves read this instead of each
   * re-deriving the ordering from per-route files.
   * @param {number} [now] - current time, for the decaying heat.
   * @returns {Promise<{ byKey: Map<string, object>, routes: Array<object> }>} the aggregate.
   */
  async function usageLedger(now = Date.now()) {
    await flushUsage()
    const byKey = new Map()
    const routes = []
    for (const route of await store.routes()) {
      const overlay = await store.read(route)
      const models = Object.entries(overlay.usage ?? {})
      if (models.length === 0) continue
      routes.push({ route, revision: overlay.revision, models: models.length })
      for (const [model, entry] of models) {
        byKey.set(keyOf(route, model), { route, model, ...usageView(entry, now) })
      }
    }
    return { byKey, routes }
  }

  /**
   * The whole ledger as one report: per-model rows plus profile-wide totals.
   *
   * Shared by the tool and the HTTP route so the agent and the panel cannot
   * disagree about a number the user sees in both places.
   * @returns {Promise<object>} the report.
   */
  async function usageReport() {
    const ledger = await usageLedger()
    const models = [...ledger.byKey.values()]
      .filter(entry => entry.uses > 0 || entry.attempts > 0)
      .sort((left, right) => right.heat - left.heat || right.uses - left.uses || left.model.localeCompare(right.model))
    const totals = models.reduce((sum, entry) => ({
      uses: sum.uses + entry.uses,
      attempts: sum.attempts + entry.attempts,
      inputTokens: sum.inputTokens + entry.inputTokens,
      outputTokens: sum.outputTokens + entry.outputTokens,
    }), { uses: 0, attempts: 0, inputTokens: 0, outputTokens: 0 })
    return {
      enabled: config.usage.enabled,
      seed: diagnostics.usageSeed ?? null,
      routes: ledger.routes,
      totals,
      models,
    }
  }

  /**
   * Delete recorded usage, for one model, one route, or the whole profile.
   *
   * The counters are local and describe the user's own habits, so deleting them
   * must not require finding a file. Clearing everything also drops the backfill
   * watermark, so the history is genuinely gone rather than restorable by the
   * next scan.
   * @param {string | undefined} route - one route, or every route when undefined.
   * @param {string | undefined} model - one model, or every model when undefined.
   * @returns {Promise<object>} what was cleared.
   */
  async function resetUsage(route, model) {
    await flushUsage()
    const targets = route === undefined ? await store.routes() : [route]
    const cleared = []
    for (const target of targets) {
      const overlay = await store.read(target)
      if (model === undefined) {
        if (Object.keys(overlay.usage ?? {}).length === 0) continue
        await store.update(target, current => ({ ...current, usage: {} }))
        cleared.push(`${target}/*`)
        continue
      }
      if (overlay.usage?.[model] === undefined) continue
      await store.update(target, (current) => {
        const usage = { ...current.usage }
        delete usage[model]
        return { ...current, usage }
      })
      cleared.push(`${target}/${model}`)
    }
    if (route === undefined && model === undefined) {
      await store.update(SEED_DOC, current => ({ ...current, seeded: {} }))
      diagnostics.usageCounted = 0
    }
    return { ok: true, cleared }
  }

  /**
   * Count the existing session logs once, so a fresh install starts with the
   * history the user already has instead of level 1 everywhere.
   *
   * Sessions are marked as they are counted, so an interrupted pass resumes
   * instead of recounting, and a re-run costs nothing.
   * @param {object} [query] - the `sessionQuery` service, when the host has one.
   * @returns {Promise<object>} a summary of what the pass did.
   */
  async function seedUsage(query = ctx.get('sessionQuery')) {
    if (query === undefined || typeof query.listSessions !== 'function') {
      return { ok: false, reason: 'the sessionQuery service is not available on this host' }
    }
    const watermark = await store.read(SEED_DOC)
    const already = watermark.seeded ?? {}
    let records
    try {
      records = await query.listSessions()
    } catch (error) {
      return { ok: false, reason: `could not list sessions: ${error instanceof Error ? error.message : String(error)}` }
    }
    let scanned = 0
    let counted = 0
    let skipped = 0
    for (const record of records.slice(0, SEED_SESSION_LIMIT)) {
      const sessionId = record?.header?.id
      if (sessionId === undefined) continue
      if (already[sessionId] !== undefined) { skipped += 1; continue }
      let log
      try {
        log = await query.readSession(sessionId)
      } catch {
        // One unreadable or replay-invalid log must not end the pass.
        continue
      }
      let inSession = 0
      for (const event of log?.events ?? []) {
        if (countMessageEvent(event, sessionId, true)) inSession += 1
      }
      counted += inSession
      scanned += 1
      await store.update(SEED_DOC, (overlay) => ({
        ...overlay,
        seeded: { ...overlay.seeded, [sessionId]: Date.now() },
      }))
    }
    await flushUsage()
    return { ok: true, sessions: records.length, scanned, skipped, counted }
  }

  /**
   * The live `llm` service.
   *
   * `ctx.get()` is the optional-access path: it resolves a service without
   * requiring the reading context to have declared it in `inject`. Reading
   * `ctx.llm` directly would throw "cannot get property llm without inject" from
   * every closure here, because they were created in `apply`'s own context,
   * which never injects `llm` — only the listener and tool injection scopes do.
   *
   * @returns {object | undefined} the service, or undefined while unavailable.
   */
  function llm() {
    return ctx.get('llm')
  }

  /**
   * Every group the live registry currently advertises, in registration order.
   * @returns {Promise<Array<{ route: string, name: string, models: string[] }>>} the catalog.
   */
  async function catalog() {
    const groups = []
    const registry = llm()
    if (registry === undefined) return groups
    for (const provider of registry.listProviders()) {
      let models = []
      try {
        models = (await registry.listModels(provider.id)).map(model => model.id)
      } catch {
        models = []
      }
      catalogCache.set(provider.id, { models, at: Date.now() })
      groups.push({ route: provider.id, name: provider.name, models })
    }
    return groups
  }

  /**
   * Follow one dot path into a settings section.
   * @param {unknown} root - the section value.
   * @param {readonly string[]} path - path segments.
   * @returns {unknown} the addressed value, or undefined.
   */
  function walkPath(root, path) {
    let value = root
    for (const segment of path) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
      value = value[segment]
    }
    return value
  }

  /**
   * One route's profile object from the live settings document.
   *
   * `settings` publishes no getter: it reports one descriptor per active profile
   * entry through `describe()`, keyed by entry id, and each descriptor carries
   * the directory's own `settingsPath` from the section root to this provider's
   * profile. Walking that path is why this keeps working when a Loader id prefix
   * or the profile's storage shape changes, instead of assuming `providers[route]`.
   *
   * @param {string} route - provider route id.
   * @param {{ settingsNs?: string, settingsPath?: readonly string[] }} [directoryEntry] - the route's directory entry.
   * @returns {object | undefined} the profile object.
   */
  function profileSection(route, directoryEntry = {}) {
    const settings = ctx.get('settings')
    if (typeof settings?.describe !== 'function') return undefined
    let descriptors = []
    try {
      descriptors = settings.describe({ redactSecrets: true }) ?? []
    } catch {
      return undefined
    }
    // The directory names the namespace; fall back to whichever active entry
    // actually carries this route, so an unexpected id form cannot break it.
    const named = directoryEntry.settingsNs === undefined
      ? undefined
      : descriptors.find(row => row.ns === directoryEntry.settingsNs)
    const candidates = named === undefined ? descriptors : [named]
    const sections = candidates
      .map(row => row.value ?? row.base)
      .filter(section => section !== null && typeof section === 'object')
    // The directory's own path is authoritative. The conventional
    // `providers[route]` shape is tried too, because this plugin must still find
    // the profile if a future directory omits `settingsPath` or projects the
    // section through a narrowed form; a wrong path must degrade to "unknown",
    // never to a silently wrong baseURL.
    const paths = []
    if (Array.isArray(directoryEntry.settingsPath) && directoryEntry.settingsPath.length > 0) {
      paths.push(directoryEntry.settingsPath)
    }
    if (!paths.some(candidate => candidate.length === 2 && candidate[0] === 'providers' && candidate[1] === route)) {
      paths.push(['providers', route])
    }
    for (const section of sections) {
      for (const path of paths) {
        const profile = walkPath(section, path)
        if (profile !== null && typeof profile === 'object') return profile
      }
    }
    return undefined
  }

  /**
   * One route's profile facts from the configurable-provider directory.
   * @param {string} route - provider route id.
   * @returns {{ baseURL?: string, apiKeyEnv?: string, headers?: Record<string, string>, settingsNs?: string } | undefined} the profile.
   */
  function routeProfile(route) {
    const registry = llm()
    if (registry === undefined) return undefined
    let entries = []
    try {
      entries = registry.listConfigurableProviders() ?? []
    } catch {
      return undefined
    }
    const entry = entries.find(candidate => candidate.provider === route)
    if (entry === undefined) return undefined
    const profile = profileSection(route, entry) ?? {}
    return {
      baseURL: cleanString(profile.baseURL),
      apiKeyEnv: cleanString(profile.apiKeyEnv),
      headers: profile.headers !== null && typeof profile.headers === 'object' ? profile.headers : undefined,
      settingsNs: entry.settingsNs,
    }
  }

  /**
   * Resolve one route's credential through the credentials service.
   * @param {string} route - provider route id.
   * @returns {Promise<string | undefined>} the secret value.
   */
  async function routeApiKey(route) {
    const profile = routeProfile(route)
    if (profile?.apiKeyEnv === undefined) return undefined
    const credentials = ctx.get('credentials')
    if (typeof credentials?.resolve !== 'function') return undefined
    try {
      const resolved = await credentials.resolve(profile.apiKeyEnv)
      return typeof resolved?.value === 'string' ? resolved.value : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Fetch one route's gateway directory (`GET {baseURL}/models`) once per TTL.
   * @param {string} route - provider route id.
   * @param {{ force?: boolean, signal?: AbortSignal }} [options] - refresh options.
   * @returns {Promise<{ ok: true, ids: Set<string>, at: number } | { ok: false, error: string }>} the directory.
   */
  async function gatewayDirectory(route, options = {}) {
    const cached = directoryCache.get(route)
    if (options.force !== true && cached !== undefined && Date.now() - cached.at < config.directory.ttlMs) return cached
    const profile = routeProfile(route)
    if (profile?.baseURL === undefined) return { ok: false, error: `route "${route}" exposes no baseURL to read a directory from` }
    const apiKey = await routeApiKey(route)
    const url = `${profile.baseURL.replace(/\/+$/, '')}/models`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.probe.timeoutMs)
    try {
      const headers = { accept: 'application/json' }
      if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`
      for (const [header, value] of Object.entries(profile.headers ?? {})) headers[header] = value
      const response = await fetch(url, { method: 'GET', headers, signal: options.signal ?? controller.signal })
      if (!response.ok) return { ok: false, error: `${url} answered ${response.status}` }
      const body = await response.json()
      const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : undefined
      if (rows === undefined) return { ok: false, error: `${url} answered no model list` }
      const ids = new Set()
      for (const row of rows) {
        const id = typeof row === 'string' ? row : cleanString(row?.id)
        if (id !== undefined) ids.add(id)
      }
      const value = { ok: true, ids, at: Date.now() }
      directoryCache.set(route, value)
      return value
    } catch (error) {
      return { ok: false, error: `${url}: ${error instanceof Error ? error.message : String(error)}` }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Probe one model for reachability with the smallest request the gateway accepts.
   * @param {string} route - provider route id.
   * @param {string} model - model id.
   * @returns {Promise<object>} the classification for this model.
   */
  async function probeModel(route, model) {
    const profile = routeProfile(route)
    if (profile?.baseURL === undefined) {
      return { reason: REASON.ERROR, detail: `route "${route}" exposes no baseURL to probe`, scope: 'route' }
    }
    const apiKey = await routeApiKey(route)
    const url = `${profile.baseURL.replace(/\/+$/, '')}/chat/completions`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.probe.timeoutMs)
    try {
      const headers = { accept: 'application/json', 'content-type': 'application/json' }
      if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`
      for (const [header, value] of Object.entries(profile.headers ?? {})) headers[header] = value
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
        signal: controller.signal,
      })
      const text = (await response.text()).slice(0, 2000)
      if (response.ok) return { reason: REASON.OK, detail: 'HTTP 200', scope: 'model' }
      // The model answered, so it exists and is served: a rejected request body
      // is a shape problem, not an availability problem.
      if (gatewayCode(text) === undefined && !/模型不存在|model not found|model not support/i.test(text)) {
        if (/INVALID_ARGUMENT|参数|failed|invalid/i.test(text)) {
          return { reason: REASON.OK, detail: `reachable, rejected this probe body (HTTP ${response.status})`, scope: 'model' }
        }
      }
      return classifyFailure({ message: text, status: response.status })
    } catch (error) {
      return { reason: REASON.ERROR, detail: error instanceof Error ? error.message : String(error), scope: 'route' }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * The merged view the picker and the panel both read: the live catalog with
   * the overlay applied, every row carrying its own reason when unusable.
   * @param {{ forceDirectory?: boolean }} [options] - refresh options.
   * @returns {Promise<object>} the snapshot the Client renders.
   */
  async function snapshot(options = {}) {
    // Counts still in memory are part of the answer: a user who just used a
    // model must not see yesterday's number until the flush timer fires.
    await flushUsage()
    const now = Date.now()
    const groups = await catalog()
    const directories = new Map()
    const merged = []
    for (const group of groups) {
      const overlay = await store.read(group.route)
      let directory
      try {
        directory = await gatewayDirectory(group.route, { force: options.forceDirectory === true })
      } catch {
        directory = { ok: false, error: 'directory read failed' }
      }
      directories.set(group.route, directory)
      const rows = []
      for (const model of group.models) {
        const health = overlay.health[keyOf(group.route, model)]
        const inDirectory = directory.ok === true ? directory.ids.has(model) : undefined
        // The gateway directory outranks a stale probe: a model the gateway no
        // longer lists is retired no matter what an older probe concluded.
        const status = inDirectory === false
          ? REASON.RETIRED
          : health?.status ?? (inDirectory === true ? REASON.OK : 'unknown')
        rows.push({
          route: group.route,
          model,
          favorite: refHas(overlay.favorites, group.route, model),
          pinned: refHas(overlay.pins, group.route, model),
          hidden: refHas(overlay.hidden, group.route, model),
          status,
          reason: inDirectory === false ? `not listed by ${group.route}'s gateway directory` : health?.detail ?? '',
          source: inDirectory === false ? 'directory' : health?.source ?? 'none',
          scope: health?.scope ?? 'model',
          at: inDirectory === false ? directory.at : health?.at ?? 0,
          inDirectory,
          usage: usageView(overlay.usage?.[model], now),
        })
      }
      merged.push({ ...group, rows })
    }

    const pinnedKeys = new Set()
    for (const group of merged) for (const row of group.rows) if (row.pinned) pinnedKeys.add(keyOf(row.route, row.model))
    const favoriteKeys = new Set()
    for (const group of merged) for (const row of group.rows) if (row.favorite) favoriteKeys.add(keyOf(row.route, row.model))
    const recentKeys = new Map()
    for (const group of merged) {
      const overlay = await store.read(group.route)
      overlay.recent.forEach((entry, index) => {
        const key = keyOf(entry.route, entry.model)
        if (!recentKeys.has(key)) recentKeys.set(key, index)
      })
    }
    const rank = (row) => {
      const key = keyOf(row.route, row.model)
      if (pinnedKeys.has(key)) return [0, 0]
      if (favoriteKeys.has(key)) return [1, 0]
      const recent = recentKeys.get(key)
      if (recent !== undefined) return [2, recent]
      return [3, 0]
    }
    for (const group of merged) {
      group.rows.sort((left, right) => {
        const a = rank(left)
        const b = rank(right)
        if (a[0] !== b[0]) return a[0] - b[0]
        if (a[1] !== b[1]) return a[1] - b[1]
        return left.model.localeCompare(right.model)
      })
    }
    merged.sort((left, right) => left.route.localeCompare(right.route))

    // One model reachable through several routes: report the copies rather than
    // dropping them, so the user knows a model they hid may still arrive from
    // another route.
    const byModel = new Map()
    for (const group of merged) {
      for (const row of group.rows) {
        const list = byModel.get(row.model) ?? []
        list.push(row.route)
        byModel.set(row.model, list)
      }
    }
    for (const group of merged) {
      for (const row of group.rows) row.alsoOn = (byModel.get(row.model) ?? []).filter(route => route !== row.route)
    }

    // "Which models do I actually work with" is a question about the profile,
    // not about one route, so the ranking spans every group and is ordered by
    // decaying heat: the point is current habits, with the lifetime level
    // carried alongside as the trophy.
    const allRows = merged.flatMap(group => group.rows)
    const usageTop = allRows
      .filter(row => row.usage.uses > 0)
      .sort((left, right) => right.usage.heat - left.usage.heat
        || right.usage.uses - left.usage.uses
        || left.model.localeCompare(right.model))
      .slice(0, 10)
      .map(row => ({ route: row.route, model: row.model, ...row.usage }))
    const usageTotals = allRows.reduce((sum, row) => ({
      uses: sum.uses + row.usage.uses,
      inputTokens: sum.inputTokens + row.usage.inputTokens,
      outputTokens: sum.outputTokens + row.usage.outputTokens,
    }), { uses: 0, inputTokens: 0, outputTokens: 0 })

    return {
      revision: await store.read('__global__').then(overlay => overlay.revision),
      selectorMode: config.selector.mode,
      fallbackEnabled: config.fallback.enabled,
      usage: { enabled: config.usage.enabled, top: usageTop, totals: usageTotals },
      groups: merged,
      directory: [...directories.entries()].map(([route, value]) => ({
        route,
        ok: value.ok === true,
        count: value.ok === true ? value.ids.size : 0,
        at: value.ok === true ? value.at : 0,
        error: value.ok === true ? '' : value.error,
      })),
      diagnostics: { ...diagnostics, uptimeMs: Date.now() - diagnostics.startedAt },
    }
  }

  /**
   * Build the fallback order: configured chain first, then pins, then favorites,
   * then catalog order. Unusable and hidden models are skipped.
   * @param {string} route - the route whose model just failed.
   * @param {string} failedModel - the model that failed.
   * @returns {Promise<Array<{ route: string, model: string }>>} the ordered chain.
   */
  async function fallbackChain(route, failedModel) {
    const groups = await catalog()
    const usable = []
    for (const group of groups) {
      const overlay = await store.read(group.route)
      const directory = await gatewayDirectory(group.route)
      for (const model of group.models) {
        const health = overlay.health[keyOf(group.route, model)]
        if (refHas(overlay.hidden, group.route, model)) continue
        if (directory.ok === true && !directory.ids.has(model)) continue
        if (health !== undefined && UNUSABLE_REASONS.has(health.status)) {
          const fresh = Date.now() - (health.at ?? 0) < QUOTA_COOLDOWN_MS
          if (health.status === REASON.QUOTA && !fresh) {
            // A stale quota verdict is retried rather than trusted forever.
          } else {
            continue
          }
        }
        usable.push({ route: group.route, model, overlay })
      }
    }
    const ordered = []
    const seen = new Set()
    const push = (entry) => {
      if (entry.route === route && entry.model === failedModel) return
      const key = keyOf(entry.route, entry.model)
      if (seen.has(key)) return
      seen.add(key)
      ordered.push({ route: entry.route, model: entry.model })
    }
    for (const entry of config.fallback.chain) {
      const parsed = parseChainEntry(entry)
      if (parsed === undefined) continue
      const match = usable.find(candidate => candidate.route === parsed.route && candidate.model === parsed.model)
      if (match !== undefined) push(match)
    }
    for (const candidate of usable.filter(entry => refHas(entry.overlay.pins, entry.route, entry.model))) push(candidate)
    for (const candidate of usable.filter(entry => refHas(entry.overlay.favorites, entry.route, entry.model))) push(candidate)
    // Prefer another model on the same route before crossing to a different
    // provider: the session's credentials and protocol are already proven there.
    for (const candidate of usable.filter(entry => entry.route === route)) push(candidate)
    for (const candidate of usable.filter(entry => entry.route !== route)) push(candidate)
    return ordered
  }

  /**
   * Perform one automatic model switch, or explain why it is refused.
   * @param {object} payload - the `agent/request-error` payload.
   * @returns {Promise<{ ok: true, route: string, model: string } | { ok: false, why: string }>} the outcome.
   */
  async function switchModel(payload) {
    const { agent, turn, provider, failure } = payload
    if (!config.fallback.enabled) return { ok: false, why: 'fallback is disabled in config' }
    const current = lastRequest.get(agent.id)
    const failedModel = current?.model
    if (failedModel === undefined) return { ok: false, why: 'the failing model could not be identified' }
    const verdict = classifyFailure(failure)
    if (!verdict.switchable) {
      return { ok: false, why: `failure scope is ${verdict.scope}; switching models cannot help` }
    }
    const budgetKey = `${agent.id}/${turn}`
    const spent = fallbacksThisTurn.get(budgetKey) ?? 0
    if (spent >= MAX_FALLBACKS_PER_TURN) {
      return { ok: false, why: `already switched ${spent} times this turn` }
    }
    const chain = await fallbackChain(provider, failedModel)
    const next = chain[0]
    if (next === undefined) return { ok: false, why: 'no usable alternative model was found' }
    pendingOverride.set(agent.id, { route: next.route, model: next.model, at: Date.now() })
    fallbacksThisTurn.set(budgetKey, spent + 1)
    diagnostics.fallbacks += 1
    // Record the switch before it happens so the reason it happened is durable
    // even if the retry then fails for an unrelated cause.
    const previous = { route: provider, model: failedModel }
    // Kept per session so the banner appears in the conversation that actually
    // switched, not in every open conversation.
    diagnostics.bySession[agent.id] = {
      at: Date.now(),
      from: previous,
      to: { route: next.route, model: next.model },
      reason: verdict.reason,
      detail: verdict.detail,
    }
    await store.update('__events__', (overlay) => ({
      ...overlay,
      recent: [{ route: next.route, model: next.model, at: Date.now() }, ...overlay.recent].slice(0, RECENT_LIMIT),
    }))
    try {
      ctx.logger?.info?.(
        'llm-manage: %s quota/unusable (%s) — switching %s/%s to %s/%s for turn %d',
        failedModel, verdict.reason, previous.route, previous.model, next.route, next.model, turn,
      )
    } catch {
      // Logging is diagnostic only and must never break recovery.
    }
    return { ok: true, route: next.route, model: next.model, previous, reason: verdict.reason }
  }

  // ── Recovery: capture each request's model, then move it on quota failure ──

  ctx.inject(['llm', 'agents'], (scope) => {
    scope.on('agent/request', async (payload, next) => {
      const decision = await next()
      lastRequest.set(payload.agent.id, { provider: decision.provider, model: decision.model })
      return decision
    })

    scope.on('agent/request-error', async (payload, next) => {
      const verdict = classifyFailure(payload.failure)
      diagnostics.observed += 1
      diagnostics.classified[verdict.reason] = (diagnostics.classified[verdict.reason] ?? 0) + 1
      const current = lastRequest.get(payload.agent.id)
      if (current?.model !== undefined) {
        recordHealth(payload.provider, current.model, verdict, 'passive').catch(() => {})
        // A failed call is not a use — it must not inflate proficiency — but it
        // is the one honest "attempts" signal the host offers, so it is kept
        // apart from `uses` rather than thrown away.
        if (config.usage.enabled) {
          addUsage(payload.provider, current.model, usageIncrement({ attempts: 1, at: Date.now() }))
        }
      }
      // Only a model-scoped, switchable failure is ours; everything else keeps
      // the stock behaviour, including the retry policy for real rate limits.
      if (!verdict.switchable) return next()
      let outcome
      try {
        outcome = await switchModel(payload)
      } catch (error) {
        diagnostics.refusals.push({ at: Date.now(), why: error instanceof Error ? error.message : String(error) })
        return next()
      }
      if (!outcome.ok) {
        diagnostics.refusals.push({ at: Date.now(), why: outcome.why })
        return next()
      }
      // `{ kind: 'retry' }` re-enters the step loop, which re-dispatches
      // `agent/request`; the override below replaces the model there.
      return { kind: 'retry' }
    })

    // Applied last in the waterfall chain by returning `next()`'s decision with
    // the model replaced, so other plugins' request shaping is preserved.
    scope.on('agent/request', async (payload, next) => {
      const decision = await next()
      const override = pendingOverride.get(payload.agent.id)
      if (override === undefined) return decision
      if (Date.now() - override.at > OVERRIDE_TTL_MS) {
        pendingOverride.delete(payload.agent.id)
        return decision
      }
      pendingOverride.delete(payload.agent.id)
      return { ...decision, provider: override.route, model: override.model }
    })

    scope.on('agent/disposed', ({ agent }) => {
      lastRequest.delete(agent.id)
      pendingOverride.delete(agent.id)
      for (const key of fallbacksThisTurn.keys()) if (key.startsWith(`${agent.id}/`)) fallbacksThisTurn.delete(key)
    })
  })

  // ── Counting: every committed model response, exactly once ──

  if (config.usage.enabled) {
    // Plain `ctx.on` at the plugin root, matching how the shipped counters
    // (`token-meter`) observe this event: it is emitted on the session's own
    // scope and reaches the root listener. Injecting a service here would make
    // the count stop entirely on a host that lacks it, for no gain.
    ctx.on('session/event', (session, event) => {
      const sessionId = cleanString(session?.id)
      if (sessionId === undefined) return
      if (countMessageEvent(event, sessionId)) diagnostics.usageCounted += 1
    })

    // One historical pass, so an existing user does not begin at level 1 on
    // every model. It is background work: no request and no panel read waits
    // for it, and it resumes rather than recounting if it is interrupted.
    if (config.usage.seed) {
      void seedUsage()
        .then((result) => { diagnostics.usageSeed = result })
        .catch(() => {})
    }
  }

  // ── Inventory: a tool the agent can call, and an HTTP route the UI reads ──

  ctx.inject(['tools'], (scope) => {
    scope.tools.register({
      name: 'llm_models',
      description: [
        'Inspect and manage this profile\'s LLM model inventory: which models each route advertises,',
        'which are pinned or favorited, and why a model is unusable (retired at the gateway, wrong',
        'protocol for the route, quota exhausted, or a probe failure). Actions: `snapshot` (read the',
        'merged view), `pin`/`unpin`, `favorite`/`unfavorite`, `hide`/`unhide`, `probe` (deep-probe one',
        'model with a minimal request), `sync` (refresh the gateway directory), `usage` (which models',
        'this profile actually uses, with proficiency level and recent heat), `seed-usage` (re-scan',
        'existing session logs to backfill the counters), `reset-usage` (clear one',
        'model\'s counters, or every counter with no `route`). Deep probes cost gateway',
        'rate budget, so probe individual models rather than sweeping a whole catalog.',
      ].join(' '),
      // `tools.register` takes a full ToolDefinition: `parameters` is already
      // JSON Schema here (the field-map form belongs to defineTool), and
      // `output` is mandatory — register throws a TypeError without
      // `output.render`, which would silently leave the tool unregistered.
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['snapshot', 'pin', 'unpin', 'favorite', 'unfavorite', 'hide', 'unhide', 'probe', 'sync', 'usage', 'seed-usage', 'reset-usage', 'diagnostics'],
            description: 'What to do.',
          },
          route: { type: 'string', description: 'Provider route id, such as `my-route`.' },
          model: { type: 'string', description: 'Exact model id, such as `DeepSeek-V3`.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      execute: async (args) => {
        const action = cleanString(args?.action)
        const route = cleanString(args?.route)
        const model = cleanString(args?.model)
        const need = () => {
          if (route === undefined || model === undefined) throw new Error(`action "${action}" needs both \`route\` and \`model\``)
          return { route, model }
        }
        switch (action) {
          case 'snapshot':
            return JSON.stringify(await snapshot(), null, 2)
          case 'diagnostics':
            return JSON.stringify({ ...diagnostics, uptimeMs: Date.now() - diagnostics.startedAt }, null, 2)
          case 'sync': {
            if (route === undefined) throw new Error('action "sync" needs `route`')
            const directory = await gatewayDirectory(route, { force: true })
            return JSON.stringify(directory.ok === true
              ? { route, count: directory.ids.size, at: directory.at }
              : { route, error: directory.error }, null, 2)
          }
          case 'pin':
          case 'favorite':
          case 'hide':
          case 'unhide':
          case 'unpin':
          case 'unfavorite': {
            const target = need()
            const list = action.startsWith('pin') || action === 'unpin'
              ? 'pins'
              : action.startsWith('favorite') || action === 'unfavorite'
                ? 'favorites'
                : 'hidden'
            const remove = action === 'unpin' || action === 'unfavorite' || action === 'unhide'
            await store.update(target.route, (overlay) => ({
              ...overlay,
              [list]: remove
                ? refWithout(overlay[list], target.route, target.model)
                : [...refWithout(overlay[list], target.route, target.model), { route: target.route, model: target.model }],
            }))
            return `${remove ? 'removed' : 'added'} ${target.route}/${target.model} ${remove ? 'from' : 'to'} ${list}`
          }
          case 'probe': {
            const target = need()
            const verdict = await probeModel(target.route, target.model)
            await recordHealth(target.route, target.model, verdict, 'probe')
            return JSON.stringify({ route: target.route, model: target.model, ...verdict }, null, 2)
          }
          case 'usage': {
            return JSON.stringify(await usageReport(), null, 2)
          }
          case 'seed-usage': {
            const result = await seedUsage()
            diagnostics.usageSeed = result
            return JSON.stringify(result, null, 2)
          }
          case 'reset-usage': {
            // Clearing the ledger is a privacy affordance: the counters are local
            // and the user must be able to delete them without hunting for files.
            return JSON.stringify(await resetUsage(route, model), null, 2)
          }
          default:
            throw new Error(`unknown action "${String(args?.action)}"`)
        }
      },
    })
  })

  ctx.inject(['connection'], (scope) => {
    const connection = scope.get('connection')
    const register = typeof connection?.fetch?.register === 'function' ? connection.fetch.register.bind(connection.fetch) : undefined
    if (register === undefined) return
    const json = (value, status = 200) => new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
    scope.effect(() => register({
      path: '/api/llm-manage',
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          if (request.method === 'GET') return json({ ok: true, value: await snapshot() })
          const body = await request.json().catch(() => ({}))
          const action = cleanString(body?.action)
          const route = cleanString(body?.route)
          const model = cleanString(body?.model)
          switch (action) {
            case 'snapshot':
              return json({ ok: true, value: await snapshot({ forceDirectory: body?.forceDirectory === true }) })
            case 'sync': {
              if (route === undefined) return json({ ok: false, message: 'sync needs a route' }, 400)
              const directory = await gatewayDirectory(route, { force: true })
              return json({ ok: true, value: directory.ok === true ? { route, count: directory.ids.size } : { route, error: directory.error } })
            }
            case 'probe': {
              if (route === undefined || model === undefined) return json({ ok: false, message: 'probe needs a route and a model' }, 400)
              const verdict = await probeModel(route, model)
              await recordHealth(route, model, verdict, 'probe')
              return json({ ok: true, value: { route, model, ...verdict }, snapshot: await snapshot() })
            }
            case 'toggle': {
              if (route === undefined || model === undefined) return json({ ok: false, message: 'toggle needs a route and a model' }, 400)
              const list = cleanString(body?.list)
              if (list !== 'pins' && list !== 'favorites' && list !== 'hidden') {
                return json({ ok: false, message: 'toggle needs `list` of pins, favorites or hidden' }, 400)
              }
              await store.update(route, (overlay) => ({
                ...overlay,
                [list]: body?.on === true
                  ? [...refWithout(overlay[list], route, model), { route, model }]
                  : refWithout(overlay[list], route, model),
              }))
              // Every mutating action returns the resulting snapshot under the
              // SAME top-level key. The browser half folds `snapshot` back in
              // after a mutation, so returning the state under `value` instead
              // leaves the UI unchanged until the user reloads by hand.
              return json({
                ok: true,
                value: { route, model, list, on: body?.on === true },
                snapshot: await snapshot(),
              })
            }
            case 'use': {
              if (route === undefined || model === undefined) return json({ ok: false, message: 'use needs a route and a model' }, 400)
              await recordUse(route, model)
              return json({ ok: true, value: true })
            }
            case 'usage':
              return json({ ok: true, value: await usageReport() })
            case 'seed-usage': {
              const result = await seedUsage()
              diagnostics.usageSeed = result
              return json({ ok: true, value: result, snapshot: await snapshot() })
            }
            case 'reset-usage':
              // A mutation, so it returns the resulting snapshot like every other
              // mutating action: the panel folds `snapshot` back in.
              return json({ ok: true, value: await resetUsage(route, model), snapshot: await snapshot() })
            case 'probeBatch': {
              const targets = Array.isArray(body?.targets) ? body.targets.slice(0, config.probe.batch) : []
              const results = []
              for (const target of targets) {
                const targetRoute = cleanString(target?.route)
                const targetModel = cleanString(target?.model)
                if (targetRoute === undefined || targetModel === undefined) continue
                const verdict = await probeModel(targetRoute, targetModel)
                await recordHealth(targetRoute, targetModel, verdict, 'probe')
                results.push({ route: targetRoute, model: targetModel, ...verdict })
                await new Promise(resolve => setTimeout(resolve, config.probe.intervalMs))
              }
              return json({ ok: true, value: { results, count: results.length }, snapshot: await snapshot() })
            }
            case 'fallbackLog': {
              const sessionId = cleanString(body?.sessionId)
              return json({
                ok: true,
                value: sessionId === undefined ? null : diagnostics.bySession[sessionId] ?? null,
                refusals: diagnostics.refusals.slice(-20),
              })
            }
            default:
              return json({ ok: false, message: `unknown action "${String(action)}"` }, 400)
          }
        } catch (error) {
          return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
        }
      },
    }), 'llm-manage: model overlay route')
  })
}
