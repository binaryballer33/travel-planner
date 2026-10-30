// The prompt cache, as the session's transcripts tell it (sampler/transcripts.py
// `cache`): what Claude's API keeps of each loop's prompt between requests, how
// long it keeps it, what reading and writing it cost and saved, and what is in
// it. Claude Code writes the main loop's prompt to the cache kept an hour (2x
// the input price) and an agent's kept 5 minutes (1.25x); a read costs a tenth
// and keeps it alive as long again. Pure.

import type { CacheAgent, CacheItem, CacheKinds, CacheLoop, CacheRequest, CacheTotals, CacheView } from '../../types'
import { summarizeInput } from './commands'
import { oneLine } from './format'
import { priceFor, type Prices } from './spend'

/** How long the API keeps a cache entry since its last read or write. */
export const TTL_5M_MS = 5 * 60_000
export const TTL_1H_MS = 60 * 60_000

export const EMPTY_CACHE: CacheView = { state: 'idle', readAt: 0, main: null, agents: [] }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
const str = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '')
const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : [])

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const requestOf = (value: unknown): CacheRequest | undefined =>
  isRecord(value) && str(value.id, 120) !== '' && str(value.model, 120) !== ''
    ? { id: str(value.id, 120), at: num(value.at), model: str(value.model, 120), input: num(value.input), output: num(value.output), read: num(value.read), write5m: num(value.write5m), write1h: num(value.write1h) }
    : undefined

const totalsOf = (value: unknown): CacheTotals | undefined =>
  isRecord(value) && str(value.model, 120) !== ''
    ? { model: str(value.model, 120), requests: num(value.requests), input: num(value.input), output: num(value.output), read: num(value.read), write5m: num(value.write5m), write1h: num(value.write1h) }
    : undefined

const KINDS: readonly CacheItem['kind'][] = ['result', 'input', 'prompt', 'summary']

/** An item as the tab names it: a call by what it did (as a Commands row titles it), a prompt or summary by its opening words. */
const itemOf = (value: unknown): CacheItem | undefined => {
  if (!isRecord(value)) {
    return undefined
  }
  const kind = KINDS.find(one => one === value.kind)
  if (kind === undefined) {
    return undefined
  }
  const tool = str(value.name, 120)
  const title = kind === 'result' || kind === 'input' ? summarizeInput(tool, isRecord(value.input) ? value.input : {}).title : str(value.text, 400)
  return { kind, tool, title: oneLine(title, 160), chars: num(value.chars), at: num(value.at) }
}

const pick = <T>(values: readonly unknown[], read: (value: unknown) => T | undefined): T[] =>
  values.flatMap(value => {
    const one = read(value)
    return one === undefined ? [] : [one]
  })

const kindsOf = (value: unknown): CacheKinds => {
  const fields = isRecord(value) ? value : {}
  return { results: num(fields.results), inputs: num(fields.inputs), prompts: num(fields.prompts), replies: num(fields.replies), summaries: num(fields.summaries) }
}

const loopOf = (value: unknown): CacheLoop | undefined =>
  isRecord(value)
    ? {
        requests: pick(list(value.requests), requestOf),
        totals: pick(list(value.totals), totalsOf),
        rewrites: num(value.rewrites),
        resets: list(value.resets).map(num).filter(at => at > 0),
        startedAt: num(value.startedAt),
        startTokens: num(value.startTokens),
        items: pick(list(value.items), itemOf),
        kinds: kindsOf(value.kinds),
      }
    : undefined

const agentOf = (value: unknown): CacheAgent | undefined => {
  if (!isRecord(value) || !/^[A-Za-z0-9_-]{1,80}$/.test(str(value.id, 80))) {
    return undefined
  }
  const last = requestOf(value.last)
  return last === undefined
    ? undefined
    : { id: str(value.id, 80), label: oneLine(str(value.label, 400), 160), type: str(value.type, 60), requests: num(value.requests), last, totals: pick(list(value.totals), totalsOf) }
}

/** The reader's `cache` answer; undefined for an error or what does not parse. */
export const parseCache = (text: string): { main: CacheLoop; agents: CacheAgent[] } | undefined => {
  const value = parseJson(text)
  const main = isRecord(value) ? loopOf(value.main) : undefined
  return main === undefined || !isRecord(value) ? undefined : { main, agents: pick(list(value.agents), agentOf) }
}

/** The tokens a request wrote to the cache, both kinds. */
export const writtenOf = (request: CacheRequest): number => request.write5m + request.write1h

/** How much of the prompt the cache holds after a request: what it read and what it wrote. */
export const cachedOf = (request: CacheRequest): number => request.read + writtenOf(request)

/** How long a loop's cache is kept: as long as its latest write asked (an hour, or 5 minutes); 5 minutes, the API's default, before any. */
export const ttlOf = (requests: readonly CacheRequest[]): number => {
  const written = [...requests].reverse().find(one => writtenOf(one) > 0)
  return written !== undefined && written.write1h > 0 ? TTL_1H_MS : TTL_5M_MS
}

/**
 * A request that wrote most of its prompt again, more than 20k tokens: the
 * cache had expired or its prompt changed before it (a compaction, a new
 * system prompt), so it paid to write what a read would have served.
 */
export const isRewrite = (request: CacheRequest): boolean => writtenOf(request) > 20_000 && writtenOf(request) >= 0.5 * cachedOf(request)

/** What a loop's cache came to, as the tab shows it. */
export type CacheFigures = {
  /** Tokens the cache holds after the latest request. */
  cached: number
  ttlMs: number
  lastAt: number
  expiresAt: number
  requests: number
  read: number
  written: number
  /** The prompt's tokens that were neither read nor written. */
  uncached: number
  /** Of the prompts' tokens, the share read from the cache. */
  hitPct: number
  readUsd: number
  writeUsd: number
  /** What the reads would have cost at the input price, less what they did. */
  savedUsd: number
  /** What the next request pays to read it, and to write it all again once it has expired. */
  nextReadUsd: number
  rewriteUsd: number
  /** Requests that wrote most of their prompt again, of `requests`. */
  rewrites: number
}

/**
 * How much of each kind of loop's cache writes is kept an hour (0 to 1): the
 * main loop's and the agents'. The engine reports a request's writes without
 * their kind, so the live figures price them by this, learned from the
 * transcripts; 0 (5 minutes, the API's default) until they have shown it.
 */
export type CacheHours = { main: number; agents: number }

export const NO_CACHE_HOURS: CacheHours = { main: 0, agents: 0 }

const hourShareOf = (requests: readonly CacheRequest[]): number | undefined => {
  const written = requests.reduce((total, one) => total + writtenOf(one), 0)
  return written === 0 ? undefined : requests.reduce((total, one) => total + one.write1h, 0) / written
}

/** The hours a reading shows: the main loop's latest write, the agents' latest writes together; what was known for a kind it shows nothing of. */
export const hoursOf = (main: CacheLoop, agents: readonly CacheAgent[], known: CacheHours): CacheHours => {
  const latest = [...main.requests].reverse().find(one => writtenOf(one) > 0)
  return {
    main: (latest === undefined ? undefined : hourShareOf([latest])) ?? known.main,
    agents: hourShareOf(agents.map(one => one.last)) ?? known.agents,
  }
}

/** Hours as the store keeps them; none for what does not parse. */
export const readHours = (value: unknown): CacheHours => {
  const share = (field: unknown): number => (typeof field === 'number' && Number.isFinite(field) ? Math.min(1, Math.max(0, field)) : 0)
  return isRecord(value) ? { main: share(value.main), agents: share(value.agents) } : NO_CACHE_HOURS
}

/** A loop's figures: its latest request's cache, and every request summed and priced by its model (an unknown model's at none). */
export const cacheFigures = (requests: readonly CacheRequest[], totals: readonly CacheTotals[], rewrites?: number): CacheFigures | undefined => {
  const last = requests.at(-1)
  if (last === undefined) {
    return undefined
  }
  const ttlMs = ttlOf(requests)
  const sum = (field: 'read' | 'write5m' | 'write1h' | 'input' | 'requests'): number => totals.reduce((total, one) => total + one[field], 0)
  const usd = (pricing: (one: CacheTotals, prices: Prices) => number): number =>
    totals.reduce((total, one) => {
      const prices = priceFor(one.model)
      return total + (prices === undefined ? 0 : pricing(one, prices) / 1e6)
    }, 0)
  const read = sum('read')
  const written = sum('write5m') + sum('write1h')
  const uncached = sum('input')
  const prices = priceFor(last.model)
  const cached = cachedOf(last)
  return {
    cached,
    ttlMs,
    lastAt: last.at,
    expiresAt: last.at + ttlMs,
    requests: sum('requests'),
    read,
    written,
    uncached,
    hitPct: read + written + uncached > 0 ? (read / (read + written + uncached)) * 100 : 0,
    readUsd: usd((one, price) => one.read * price.cacheRead),
    writeUsd: usd((one, price) => one.write5m * price.cacheWrite + one.write1h * price.cacheWrite1h),
    savedUsd: usd((one, price) => one.read * (price.input - price.cacheRead)),
    nextReadUsd: prices === undefined ? 0 : (cached * prices.cacheRead) / 1e6,
    rewriteUsd: prices === undefined ? 0 : (cached * (ttlMs === TTL_1H_MS ? prices.cacheWrite1h : prices.cacheWrite)) / 1e6,
    // The reader counts them over every request; the requests at hand otherwise.
    rewrites: rewrites ?? requests.filter(isRewrite).length,
  }
}
