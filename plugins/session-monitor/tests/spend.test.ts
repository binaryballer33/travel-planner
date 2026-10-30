import { describe, expect, test } from 'claude-code/testing'

import { addParts, addSpend, blockPctOf, EMPTY_PARTS, EMPTY_SPEND, estimateTokens, ownSpend, partsTotal, priceFor, requestSpend, shareOut, shareText, sumShares } from '../hooks/lib/spend'

const usage = (input: number, cacheWrite: number, cacheRead: number, output: number) => ({
  input_tokens: input,
  cache_creation_input_tokens: cacheWrite,
  cache_read_input_tokens: cacheRead,
  output_tokens: output,
})

describe('prices', () => {
  test('match by model id, longest prefix first, suffixes ignored', () => {
    // A cache write kept 5 minutes at 1.25x the input rate, one kept an hour at 2x.
    expect(priceFor('claude-opus-5-5')).toEqual({ input: 4, output: 20, cacheWrite: 5, cacheWrite1h: 8, cacheRead: 0.2 })
    expect(priceFor('claude-opus-5')?.input).toBe(5)
    expect(priceFor('claude-opus-5-5[1m]')?.input).toBe(4)
    expect(priceFor('claude-haiku-5-5-20261001')?.output).toBe(0.5)
    expect(priceFor('claude-fable-5-1')?.cacheRead).toBe(0.25)
    expect(priceFor('gpt-x')).toBeUndefined()
  })

  test("a request's price adds every kind of token at its rate", () => {
    // 1k uncached in at $4, 10k written at $5, 100k read at $0.20, 2k out at $20 per million.
    const spend = requestSpend(usage(1_000, 10_000, 100_000, 2_000), 'claude-opus-5-5')
    expect(Math.round((spend?.usd ?? 0) * 1e6) / 1e6).toBe(0.114)
    expect(spend?.tokens).toBe(113_000)
    // In: the uncached, written and read prompt; of it cached: the read; out: what it wrote.
    expect(spend).toMatchObject({ input: 111_000, cached: 100_000, output: 2_000 })
    expect(requestSpend(usage(1, 1, 1, 1), 'unknown-model')).toBeUndefined()
  })

  test("a request's cost by the kind of token, its writes priced by how long they are kept; the parts add up to its price", () => {
    const micro = (usd: number | undefined): number => Math.round((usd ?? 0) * 1e6)
    // Written for 5 minutes (the API's default): 10k at $5.
    const fiveMinutes = requestSpend(usage(1_000, 10_000, 100_000, 2_000), 'claude-opus-5-5')
    expect(fiveMinutes?.parts).toEqual({
      input: { tokens: 1_000, usd: 0.004 },
      cacheRead: { tokens: 100_000, usd: 0.02 },
      cacheWrite5m: { tokens: 10_000, usd: 0.05 },
      cacheWrite1h: { tokens: 0, usd: 0 },
      output: { tokens: 2_000, usd: 0.04 },
    })
    // Kept an hour: 10k at $8, so the request costs $0.03 more.
    const hour = requestSpend(usage(1_000, 10_000, 100_000, 2_000), 'claude-opus-5-5', 1)
    expect([hour?.parts.cacheWrite5m.tokens, hour?.parts.cacheWrite1h.tokens, micro(hour?.parts.cacheWrite1h.usd), micro(hour?.usd)]).toEqual([0, 10_000, 80_000, 144_000])
    // A transcript's split: a quarter of the writes kept an hour.
    const split = requestSpend(usage(0, 8_000, 0, 0), 'claude-opus-5-5', 0.25)
    expect([split?.parts.cacheWrite5m.tokens, split?.parts.cacheWrite1h.tokens, micro(split?.usd)]).toEqual([6_000, 2_000, 46_000])
    for (const one of [fiveMinutes, hour, split]) {
      expect(one === undefined ? undefined : micro(partsTotal(one.parts).usd)).toBe(micro(one?.usd))
    }
    expect(addParts(undefined, EMPTY_PARTS)).toEqual(EMPTY_PARTS)
    expect(fiveMinutes === undefined ? undefined : addParts(fiveMinutes.parts, fiveMinutes.parts).output).toEqual({ tokens: 4_000, usd: 0.08 })
  })
})

describe('shares', () => {
  test('a request is split over the outputs it read by their size', () => {
    const parts = {
      input: { tokens: 100, usd: 0.0004 },
      cacheRead: { tokens: 9_000, usd: 0.0018 },
      cacheWrite5m: { tokens: 500, usd: 0.0025 },
      cacheWrite1h: { tokens: 0, usd: 0 },
      output: { tokens: 400, usd: 0.008 },
    }
    const request = { usd: 0.2, tokens: 10_000, input: 9_600, cached: 9_000, output: 400, model: 'claude-opus-5-5', parts }
    const shares = shareOut(request, [{ id: 'a', weight: 299 }, { id: 'b', weight: 99 }], 'block-1')
    // Each share's cost by kind is the request's, split alike.
    expect(shares.get('a')?.parts?.cacheRead).toEqual({ tokens: 6_750, usd: 0.0018 * 0.75 })
    expect(shares.get('b')?.parts?.output).toEqual({ tokens: 100, usd: 0.008 * 0.25 })
    expect(Math.round((shares.get('a')?.usd ?? 0) * 1e6) / 1e6).toBe(0.15)
    expect(shares.get('b')?.tokens).toBe(2_500)
    // Each share's in and out are the request's, split alike, and add up to its tokens.
    expect(shares.get('a')).toMatchObject({ tokens: 7_500, input: 7_200, cached: 6_750, output: 300 })
    expect(shares.get('b')).toMatchObject({ input: 2_400, cached: 2_250, output: 100 })
    const odd = shareOut({ ...request, tokens: 10, input: 7, cached: 7, output: 3 }, [{ id: 'a', weight: 0 }, { id: 'b', weight: 0 }, { id: 'c', weight: 0 }])
    for (const one of odd.values()) {
      expect([one.tokens, (one.input ?? 0) + (one.output ?? 0), (one.cached ?? 0) <= (one.input ?? 0)]).toEqual([one.tokens, one.tokens, true])
    }
    expect(shares.get('a')).toMatchObject({ requestUsd: 0.2, requestTokens: 10_000, shares: 2, model: 'claude-opus-5-5', blockKey: 'block-1' })
    expect(shareOut(request, []).size).toBe(0)
  })

  test("the session's spend, and the 5-hour block's starting over at a new reset", () => {
    const request = { usd: 0.1, tokens: 1_000, input: 900, cached: 0, output: 100, model: 'm', parts: EMPTY_PARTS }
    let view = addSpend(EMPTY_SPEND, request, 'r1')
    view = addSpend(view, request, 'r1')
    expect(view.block).toMatchObject({ key: 'r1', usd: 0.2, tokens: 2_000, requests: 2 })
    view = addSpend(view, request, 'r2')
    expect(view.block).toMatchObject({ key: 'r2', usd: 0.1, tokens: 1_000, requests: 1 })
    expect(Math.round(view.totalUsd * 100) / 100).toBe(0.3)
    expect(view.requests).toBe(3)
    expect(addSpend(EMPTY_SPEND, request, undefined).block).toBeNull()
    expect(estimateTokens(700)).toBe(200)
  })

  test("the 5-hour limit's rise while the session spent, and a command's part of it", () => {
    const request = { usd: 1, tokens: 1_000, input: 900, cached: 0, output: 100, model: 'm', parts: EMPTY_PARTS }
    let view = addSpend(EMPTY_SPEND, request, 'r1', 10)
    view = addSpend(view, request, 'r1', undefined)
    view = addSpend(view, request, 'r1', 16)
    expect(view.block).toMatchObject({ startPct: 10, lastPct: 16, usd: 3 })
    const spend = { usd: 0.5, tokens: 10, requestUsd: 1, requestTokens: 20, shares: 2, model: 'm', blockKey: 'r1' }
    // A sixth of the block's spend, of a 6-point rise.
    expect(blockPctOf(spend, view)).toEqual({ pct: 1, basis: 'measured' })
    // Six points over $3 is learned for windows to come.
    expect(view.pctPerUsd).toBe(2)
    expect(blockPctOf({ ...spend, blockKey: 'r0' }, view)).toEqual({ pct: 1, basis: 'learned' })
    // Before the window moves, at most what one point over the session's spend would be.
    expect(blockPctOf(spend, addSpend(EMPTY_SPEND, request, 'r1', 10))).toEqual({ pct: 0.5, basis: 'at most' })
    // A limit read in tenths moves in tenths.
    expect(Math.round((blockPctOf(spend, addSpend(EMPTY_SPEND, request, 'r1', 10.5))?.pct ?? 0) * 1000)).toBe(50)
    expect(blockPctOf(spend, EMPTY_SPEND)).toBeUndefined()
    expect(shareText({ pct: 0.0421, basis: 'measured' })).toBe('≈ 0.042%')
    expect(shareText({ pct: 0.5, basis: 'at most' })).toBe('< 0.50%')
    expect(sumShares([{ pct: 0.2, basis: 'measured' }, undefined, { pct: 0.1, basis: 'at most' }])).toEqual({ pct: 0.30000000000000004, basis: 'at most' })
    // One step of rise measures; it takes two to learn.
    const once = addSpend(addSpend(EMPTY_SPEND, request, 'r9', 10), request, 'r9', 11)
    expect(blockPctOf({ ...spend, blockKey: 'r9' }, once)).toEqual({ pct: 0.25, basis: 'measured' })
    expect(once.pctPerUsd).toBeUndefined()
  })

  test("a command's own tokens: its input written at the output rate, its output as a cache write", () => {
    // 35 characters in = 10 tokens at $20/M; 3,500 out = 1,000 tokens at $5/M.
    const own = ownSpend(35, 3_500, 'claude-opus-5-5')
    expect(own?.tokens).toBe(1_010)
    expect(Math.round((own?.usd ?? 0) * 1e6)).toBe(5_200)
    expect(ownSpend(35, 3_500, 'unknown')).toBeUndefined()
  })
})
