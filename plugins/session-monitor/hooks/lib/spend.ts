// What model requests cost, and each command's share of the request that read
// its output. Priced at list rates per million tokens; a cache write is billed
// at 1.25x the input rate (5-minute cache), a read at the model's cache rate.

import type { CommandSpend, CostBreakdown, CostPart, SpendBlock, SpendView } from '../../types'
import { fmtSmallPct } from './format'

/** Per million tokens: a cache write kept 5 minutes (`cacheWrite`) is billed at 1.25x the input rate, one kept an hour at 2x. */
export type Prices = { input: number; output: number; cacheWrite: number; cacheWrite1h: number; cacheRead: number }

const rates = (input: number, output: number, cacheRead: number): Prices => ({ input, output, cacheWrite: input * 1.25, cacheWrite1h: input * 2, cacheRead })

/** Longest prefix first, so `claude-opus-5-5` is matched before `claude-opus-5`. */
const PRICES: readonly [string, Prices][] = [
  ['claude-fable-5-1', rates(10, 50, 0.25)],
  ['claude-mythos-5-1', rates(10, 50, 0.25)],
  ['claude-fable-5', rates(10, 50, 1)],
  ['claude-opus-5-5', rates(4, 20, 0.2)],
  ['claude-opus-5', rates(5, 25, 0.5)],
  ['claude-opus-4', rates(5, 25, 0.5)],
  ['claude-sonnet-5-5', rates(2, 10, 0.2)],
  ['claude-sonnet-5', rates(2, 10, 0.2)],
  ['claude-sonnet-4', rates(3, 15, 0.3)],
  ['claude-haiku-5-5', rates(0.1, 0.5, 0.01)],
  ['claude-haiku-4', rates(1, 5, 0.1)],
]

/** The list prices for a model id (date suffixes and `[1m]` ignored); undefined when unknown. */
export const priceFor = (model: string): Prices | undefined => {
  const id = model.toLowerCase().replace(/\[.*\]$/, '')
  return PRICES.find(([prefix]) => id === prefix || id.startsWith(`${prefix}-`) || id.startsWith(`${prefix}@`))?.[1]
}

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/**
 * One request's price and tokens: all of them (`tokens`), the prompt's
 * (`input`, of them `cached` read from the prompt cache) and what it wrote
 * (`output`); `parts`, its cost by the kind of token.
 */
export type RequestSpend = { usd: number; tokens: number; input: number; cached: number; output: number; model: string; parts: CostBreakdown }

const NO_PART: CostPart = { tokens: 0, usd: 0 }

/** No tokens of any kind. */
export const EMPTY_PARTS: CostBreakdown = { input: NO_PART, cacheRead: NO_PART, cacheWrite5m: NO_PART, cacheWrite1h: NO_PART, output: NO_PART }

/** The kinds of token, in the order a breakdown lists them. */
export const PART_KINDS: readonly (keyof CostBreakdown)[] = ['input', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'output']

const mapParts = (parts: CostBreakdown, change: (part: CostPart, kind: keyof CostBreakdown) => CostPart): CostBreakdown => ({
  input: change(parts.input, 'input'),
  cacheRead: change(parts.cacheRead, 'cacheRead'),
  cacheWrite5m: change(parts.cacheWrite5m, 'cacheWrite5m'),
  cacheWrite1h: change(parts.cacheWrite1h, 'cacheWrite1h'),
  output: change(parts.output, 'output'),
})

/** Two breakdowns added up, kind by kind; one alone when the other is absent. */
export const addParts = (sum: CostBreakdown | undefined, more: CostBreakdown): CostBreakdown =>
  sum === undefined ? more : mapParts(sum, (part, kind) => ({ tokens: part.tokens + more[kind].tokens, usd: part.usd + more[kind].usd }))

/** A share of a breakdown: its cost scaled, its tokens rounded. */
export const shareParts = (parts: CostBreakdown, share: number): CostBreakdown => mapParts(parts, part => ({ tokens: Math.round(part.tokens * share), usd: part.usd * share }))

/** A breakdown's tokens and cost, every kind together. */
export const partsTotal = (parts: CostBreakdown): CostPart =>
  PART_KINDS.reduce((total, kind) => ({ tokens: total.tokens + parts[kind].tokens, usd: total.usd + parts[kind].usd }), NO_PART)

/**
 * One request's price and its tokens of every kind; undefined for a model
 * without a price. `hourShare` is how much of what it wrote to the cache was
 * kept an hour (2x the input price) rather than 5 minutes (1.25x): the
 * transcript says, the engine does not (lib/cache.ts learns it per loop).
 */
export const requestSpend = (usage: Usage, model: string, hourShare = 0): RequestSpend | undefined => {
  const prices = priceFor(model)
  if (prices === undefined) {
    return undefined
  }
  const share = Math.min(1, Math.max(0, hourShare))
  const write1h = Math.round(usage.cache_creation_input_tokens * share)
  const write5m = usage.cache_creation_input_tokens - write1h
  const part = (tokens: number, rate: number): CostPart => ({ tokens, usd: (tokens * rate) / 1e6 })
  const parts: CostBreakdown = {
    input: part(usage.input_tokens, prices.input),
    cacheRead: part(usage.cache_read_input_tokens, prices.cacheRead),
    cacheWrite5m: part(write5m, prices.cacheWrite),
    cacheWrite1h: part(write1h, prices.cacheWrite1h),
    output: part(usage.output_tokens, prices.output),
  }
  const input = usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
  return { usd: partsTotal(parts).usd, tokens: input + usage.output_tokens, input, cached: usage.cache_read_input_tokens, output: usage.output_tokens, model, parts }
}

export type Consumed = { id: string; weight: number }

/**
 * A request's price and tokens split over the outputs it read, by each
 * output's size; `+1` keeps an empty output's share above 0. A share's
 * output is what is left of its tokens past its input, so the two always
 * add up to them.
 */
export const shareOut = (request: RequestSpend, consumed: readonly Consumed[], blockKey?: string): Map<string, CommandSpend> => {
  const total = consumed.reduce((sum, one) => sum + one.weight + 1, 0)
  const shares = new Map<string, CommandSpend>()
  for (const one of consumed) {
    const share = total === 0 ? 0 : (one.weight + 1) / total
    const tokens = Math.round(request.tokens * share)
    const input = Math.min(tokens, Math.round(request.input * share))
    shares.set(one.id, {
      usd: request.usd * share,
      tokens,
      input,
      cached: Math.min(input, Math.round(request.cached * share)),
      output: tokens - input,
      parts: shareParts(request.parts, share),
      requestUsd: request.usd,
      requestTokens: request.tokens,
      shares: consumed.length,
      model: request.model,
      blockKey,
    })
  }
  return shares
}

export const EMPTY_SPEND: SpendView = { totalUsd: 0, totalTokens: 0, requests: 0, block: null }

/**
 * Adds a request to the session's spend; a new block key starts the block's
 * figures over. `pct` is the 5-hour limit's percent used as the request's
 * response reported it.
 */
export const addSpend = (view: SpendView, request: RequestSpend, blockKey: string | undefined, pct?: number): SpendView => {
  const block: SpendBlock | null =
    blockKey === undefined
      ? view.block
      : view.block?.key === blockKey
        ? {
            ...view.block,
            usd: view.block.usd + request.usd,
            tokens: view.block.tokens + request.tokens,
            requests: view.block.requests + 1,
            startPct: view.block.startPct ?? pct,
            lastPct: pct ?? view.block.lastPct,
          }
        : { key: blockKey, usd: request.usd, tokens: request.tokens, requests: 1, startPct: pct, lastPct: pct }
  const next: SpendView = {
    totalUsd: view.totalUsd + request.usd,
    totalTokens: view.totalTokens + request.tokens,
    requests: view.requests + 1,
    block,
    pctPerUsd: view.pctPerUsd,
  }
  // Two steps of rise keep a step's rounding to at most half the rate.
  const learned = measuredRate(next, 2)
  return learned === undefined ? next : { ...next, pctPerUsd: learned }
}

/** The smallest rise the limit reports: a point, or a tenth where it reports tenths. */
const stepOf = (block: SpendBlock): number =>
  Number.isInteger(block.startPct ?? 0) && Number.isInteger(block.lastPct ?? 0) ? 1 : 0.1

/** Percent of the 5-hour limit per dollar, from how far the limit rose over what this session spent; once it rose `steps` steps. */
export const measuredRate = (view: SpendView, steps = 1): number | undefined => {
  const block = view.block
  if (block === null || block.startPct === undefined || block.lastPct === undefined || block.usd <= 0) {
    return undefined
  }
  const rise = block.lastPct - block.startPct
  return rise >= stepOf(block) * steps - 1e-9 ? rise / block.usd : undefined
}

/** How a window share was reached: measured in this window, at the rate learned earlier, or an upper bound before the limit moved. */
export type WindowBasis = 'measured' | 'learned' | 'at most'

export type WindowShare = { pct: number; basis: WindowBasis }

/**
 * About how much of the 5-hour limit some spend took (a command's, an
 * agent's): at the rate measured in this window once the limit rose, else at
 * the rate learned in an earlier one, else at most what one step of rise
 * over this session's spend in the window would be.
 */
export const windowShare = (usd: number, blockKey: string | undefined, view: SpendView): WindowShare | undefined => {
  const block = view.block
  if (usd <= 0) {
    return undefined
  }
  const isCurrent = block !== null && blockKey !== undefined && blockKey === block.key
  const measured = isCurrent ? measuredRate(view) : undefined
  if (measured !== undefined) {
    return { pct: usd * measured, basis: 'measured' }
  }
  if (view.pctPerUsd !== undefined) {
    return { pct: usd * view.pctPerUsd, basis: 'learned' }
  }
  if (isCurrent && block.usd > 0 && block.startPct !== undefined && block.lastPct !== undefined) {
    return { pct: (Math.min(usd, block.usd) / block.usd) * stepOf(block), basis: 'at most' }
  }
  return undefined
}

/** How a share was reached, in a few words. */
export const BASIS_WORDS: Readonly<Record<WindowBasis, string>> = {
  measured: 'measured in this window',
  learned: 'at the rate learned in an earlier window',
  'at most': 'the window has not risen a step yet',
}

/** `≈ 0.042%`, or `< 0.09%` for an upper bound. */
export const shareText = (share: WindowShare): string => `${share.basis === 'at most' ? '<' : '≈'} ${fmtSmallPct(share.pct)}`

/** Several shares added up (a workflow's agents): an upper bound if any part is one, measured only if all are. */
export const sumShares = (shares: readonly (WindowShare | undefined)[]): WindowShare | undefined => {
  const known = shares.filter((share): share is WindowShare => share !== undefined)
  if (known.length === 0) {
    return undefined
  }
  const basis: WindowBasis = known.some(one => one.basis === 'at most') ? 'at most' : known.some(one => one.basis === 'learned') ? 'learned' : 'measured'
  return { pct: known.reduce((total, one) => total + one.pct, 0), basis }
}

/** A command's share; see `windowShare`. */
export const blockPctOf = (spend: CommandSpend, view: SpendView): WindowShare | undefined => windowShare(spend.usd, spend.blockKey, view)

/**
 * What a command's own tokens cost: its input, which the model wrote (output
 * rate), and its output, which entered the context (a cache write).
 */
export const ownSpend = (inputChars: number, outputChars: number, model: string): { usd: number; tokens: number; input: number; output: number } | undefined => {
  const prices = priceFor(model)
  if (prices === undefined) {
    return undefined
  }
  // The model writes the call (its output tokens) and reads what it returns (its input tokens).
  const written = estimateTokens(inputChars)
  const read = estimateTokens(outputChars)
  return { usd: (written * prices.output + read * prices.cacheWrite) / 1e6, tokens: written + read, input: read, output: written }
}

/** About how many tokens a text is (the tokenizer averages ~3.5 characters a token on code and logs). */
export const estimateTokens = (characters: number): number => Math.ceil(Math.max(0, characters) / 3.5)
