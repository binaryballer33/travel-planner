import { describe, expect, test } from 'claude-code/testing'

import { cacheFigures, hoursOf, isRewrite, NO_CACHE_HOURS, parseCache, readHours, TTL_1H_MS, TTL_5M_MS, ttlOf } from '../hooks/lib/cache'
import { CACHE_AGENTS_KEY, CACHE_MAIN_KEY, CACHE_REFRESH_KEY, CACHE_REQUESTS_KEY, CACHE_WHAT_KEY, expiryOf } from '../hooks/view/cache'
import type { CacheRequest } from '../types'
import { desktopSizeOf, isDesktopDrawn } from './heavy'
import { keysOf, memoryStore, NOW, PANE, SESSION_ID, stepUsage, tabButton, textsIn, transcripts, world, clickRow, regionText } from './world'

const MINUTE = 60_000

const request = (id: string, at: number, read: number, write1h: number, write5m = 0, model = 'claude-opus-5-5'): CacheRequest => ({ id, at, model, input: 2, output: 300, read, write5m, write1h })

/**
 * The reader's answer for a session compacted an hour ago: its first request
 * wrote 100k, two more read it, an agent's own cache beside it; `main` and
 * `agents` stand in for parts of it.
 */
const answer = (main: Record<string, unknown> = {}, agents?: readonly unknown[]): Record<string, unknown> => ({
  main: {
    requests: [request('m1', NOW - 50 * MINUTE, 0, 100_000), request('m2', NOW - 40 * MINUTE, 100_000, 5_000), request('m3', NOW - 13 * MINUTE, 105_000, 2_000), { id: '', model: 'x' }],
    totals: [{ model: 'claude-opus-5-5', requests: 3, input: 6, output: 900, read: 205_000, write5m: 0, write1h: 107_000 }],
    rewrites: 1,
    resets: [NOW - 60 * MINUTE],
    startedAt: NOW - 60 * MINUTE,
    startTokens: 100_002,
    items: [
      { kind: 'result', id: 'toolu_1', name: 'Bash', input: { command: 'cat big.log', description: 'Read the log' }, chars: 35_000, at: NOW - 40 * MINUTE },
      { kind: 'prompt', text: 'why does this keep happening', chars: 7_000, at: NOW - 41 * MINUTE },
      { kind: 'bogus', chars: 1 },
    ],
    kinds: { results: 35_000, inputs: 3_500, prompts: 7_000, replies: 700, summaries: 3_500 },
    ...main,
  },
  agents: agents ?? [
    { id: 'a1b2c3', label: 'Find the config', type: 'Explore', requests: 4, last: request('x1', NOW - 2 * MINUTE, 9_000, 0, 1_000, 'claude-sonnet-5-5'), totals: [{ model: 'claude-sonnet-5-5', requests: 4, input: 8, output: 400, read: 27_000, write5m: 10_000, write1h: 0 }] },
    { id: '../bad', label: 'x', type: '', requests: 1, last: request('x2', NOW, 1, 0), totals: [] },
  ],
})

describe('the prompt cache, as the transcripts tell it', () => {
  test('the answer read: what does not parse is left out; a call named as its row would be, a prompt by its words', () => {
    const read = parseCache(JSON.stringify(answer()))
    expect(read?.main.requests.map(one => one.id)).toEqual(['m1', 'm2', 'm3'])
    expect(read?.main.items).toEqual([
      { kind: 'result', tool: 'Bash', title: 'cat big.log', chars: 35_000, at: NOW - 40 * MINUTE },
      { kind: 'prompt', tool: '', title: 'why does this keep happening', chars: 7_000, at: NOW - 41 * MINUTE },
    ])
    expect(read?.agents.map(one => one.id)).toEqual(['a1b2c3'])
    expect(parseCache('{"error": "no transcript for that session"}')).toBeUndefined()
    expect(parseCache('not json')).toBeUndefined()
  })

  test("a loop's figures: how much it holds, kept how long, what it cost and saved at its model's prices", () => {
    const read = parseCache(JSON.stringify(answer()))
    const figures = read === undefined ? undefined : cacheFigures(read.main.requests, read.main.totals)
    // Opus 5.5: $4 in, $0.20 a read, $8 a write kept an hour, per million tokens.
    expect(figures).toMatchObject({ cached: 107_000, ttlMs: TTL_1H_MS, lastAt: NOW - 13 * MINUTE, expiresAt: NOW + 47 * MINUTE, requests: 3, read: 205_000, written: 107_000, uncached: 6, rewrites: 1 })
    const cents = (usd: number | undefined): number => Math.round((usd ?? 0) * 1e4)
    expect([figures?.readUsd, figures?.writeUsd, figures?.savedUsd, figures?.nextReadUsd, figures?.rewriteUsd].map(cents)).toEqual([410, 8_560, 7_790, 214, 8_560])
    expect(Math.round((figures?.hitPct ?? 0) * 10)).toBe(657)
    // Kept as long as its latest write asked; 5 minutes before any.
    expect(ttlOf([request('a', 0, 0, 0, 3_000), request('b', 1, 3_000, 0)])).toBe(TTL_5M_MS)
    expect(ttlOf([request('a', 0, 0, 0)])).toBe(TTL_5M_MS)
    // A rewrite: more than 20k written, half its prompt or more.
    expect([isRewrite(request('a', 0, 0, 30_000)), isRewrite(request('b', 0, 100_000, 30_000)), isRewrite(request('c', 0, 0, 10_000))]).toEqual([true, false, false])
    expect(cacheFigures([], [])).toBeUndefined()
    // The reader's count over every request stands in for the one over those at hand.
    expect(read === undefined ? undefined : cacheFigures(read.main.requests, read.main.totals, 7)?.rewrites).toBe(7)
  })

  test('how much of each loop’s cache writes is kept an hour: the main loop’s latest write, the agents’ latest together; what was known otherwise', () => {
    const read = parseCache(JSON.stringify(answer()))
    // The main loop's latest write (2k) was kept an hour; the agent's (1k) 5 minutes.
    expect(read === undefined ? undefined : hoursOf(read.main, read.agents, NO_CACHE_HOURS)).toEqual({ main: 1, agents: 0 })
    // A reading with no writes keeps what was known.
    const quiet = parseCache(JSON.stringify(answer({ requests: [request('r', NOW, 9_000, 0)] }, [])))
    expect(quiet === undefined ? undefined : hoursOf(quiet.main, quiet.agents, { main: 1, agents: 0.5 })).toEqual({ main: 1, agents: 0.5 })
    expect(readHours({ main: 1, agents: 0.25 })).toEqual({ main: 1, agents: 0.25 })
    expect(readHours({ main: 9, agents: 'x' })).toEqual({ main: 1, agents: 0 })
    expect(readHours(undefined)).toEqual(NO_CACHE_HOURS)
  })

  test('when it expires: in how long, amber in its last stretch, red once past', () => {
    expect(expiryOf(NOW + 47 * MINUTE, TTL_1H_MS, NOW)).toEqual({ text: 'in 47m 00s', tone: 'success', isExpired: false })
    expect(expiryOf(NOW + 4 * MINUTE, TTL_1H_MS, NOW).tone).toBe('warning')
    expect(expiryOf(NOW + 30_000, TTL_5M_MS, NOW).tone).toBe('warning')
    expect(expiryOf(NOW - 90_000, TTL_1H_MS, NOW)).toEqual({ text: 'expired 1m 30s ago', tone: 'error', isExpired: true })
  })
})

describe('pricing cache writes by how long they are kept', () => {
  test('once the first turn ends the transcript says the main loop’s writes are kept an hour, and its requests are priced so from then on', { timeoutMs: 30_000 }, async ($, on) => {
    const clock = world(on)
    transcripts.cache = answer()
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
    const turn = async (turnId: string, text: string): Promise<void> => {
      await $.turn.start({ text, turnId })
      await clock.settle()
      stepUsage.value = { input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 2_000, model: 'claude-opus-5-5' }
      for await (const chunk of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 3 })) {
        expect(chunk).toBeDefined()
      }
      await $.turn.complete({ answer: 'done', durationMs: 1_000, isAborted: false, turnId, reason: 'answer' })
      await clock.settle()
    }
    // Before any reading: the API's default, 5 minutes.
    await turn('t1', 'first')
    expect(memoryStore.get('cacheHours')).toEqual({ main: 1, agents: 0 })
    expect(transcripts.runs.filter(run => run[0] === 'cache')).toHaveLength(1)
    await clock.advance(60_000)
    await turn('t2', 'second')
    // Read once a session.
    expect(transcripts.runs.filter(run => run[0] === 'cache')).toHaveLength(1)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:prompts' })
    await clock.settle()
    const breakdowns: string[][] = []
    for (const text of ['first', 'second']) {
      const prompt = (await ui.findAll({ type: 'Text', text: `“${text}”` }))[0]
      expect(prompt).toBeDefined()
    }
    // One card open at a time: each expanded in turn, its breakdown read.
    for (const key of await keysOf(ui, 'pfull:')) {
      await clock.advance(1_000)
      await clickRow(ui, key)
      await clock.settle()
      const [open] = await keysOf(ui, 'pparts:')
      breakdowns.push(open === undefined ? [] : await textsIn(ui, open))
    }
    // Newest first: the second's 2k written kept an hour at $8, the first's 5 minutes at $5.
    expect(breakdowns.map(lines => lines.filter(line => line.startsWith('Cache writes')))).toEqual([['Cache writes (kept 1 hour)'], ['Cache writes (kept 5 min)']])
    expect(breakdowns.map(lines => lines[lines.indexOf('Total') + 2])).toEqual(['$0.03', '$0.03'])
    expect(breakdowns[0]?.[breakdowns[0].indexOf('Cache writes (kept 1 hour)') + 2]).toBe('$0.02')
    await ui.unmount()
  })
})

describe('the Cache tab', () => {
  test('its cards: the cache now, what is in it, the requests, the agents’; it counts down to expiry and reads the transcripts again only while open', { timeoutMs: 60_000 }, async ($, on) => {
    const clock = world(on)
    transcripts.cache = answer()
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
    const reads = (): number => transcripts.runs.filter(run => run[0] === 'cache').length
    expect(reads()).toBe(0)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    // The last tab in the bar, on h.
    expect((await tabButton(ui, 'cache'))?.props.hotkey).toBe('h')
    await ui.press({ key: 'tab:cache' })
    await clock.settle()
    expect(transcripts.runs).toContainEqual(['cache', '/repo', SESSION_ID])

    const main = await textsIn(ui, CACHE_MAIN_KEY)
    const valueOf = (name: string): string | undefined => main[main.indexOf(name) + 1]
    expect(valueOf('Cached now')).toBe('107k tokens')
    expect(valueOf('Kept for')).toBe('1 hour after each use')
    expect(valueOf('Expires')).toBe('in 47m 00s')
    expect(valueOf('Next request reads it')).toBe('≈ $0.02')
    expect(valueOf('Hit rate')).toBe('66% read from it')
    expect(valueOf('Saved')).toBe('≈ $0.78')
    expect(valueOf('Written')).toBe('107k tokens · ≈ $0.86')
    expect(valueOf('Requests')).toBe('3 · 1 wrote it again')
    expect(valueOf('Compacted')).toMatch(/^1 time · last /)

    const what = (await textsIn(ui, CACHE_WHAT_KEY)).join('\n')
    expect(what).toContain('since it was compacted at')
    expect(what).toContain('It began at ≈ 100k tokens')
    // Its biggest item: the log the Bash call printed, ≈ 10k of its 107k.
    expect(what).toContain('output\nBash cat big.log\n≈ 10k\n9.3%')
    expect(what).toContain('prompt\nwhy does this keep happening')

    // The newest request first; the first, which wrote its prompt whole, flagged.
    const requests = await textsIn(ui, CACHE_REQUESTS_KEY)
    expect(requests.filter(text => text.startsWith('read '))).toEqual(['read 105k', 'read 100k', 'read 0'])
    expect(requests.filter(text => text === 'wrote it again')).toHaveLength(1)
    expect(requests).toContain('wrote 100k (1h)')

    // An agent's own cache: kept 5 minutes, two of them left.
    const agents = (await textsIn(ui, CACHE_AGENTS_KEY)).join('\n')
    expect(agents).toContain('Find the config')
    expect(agents).toContain('10k cached · kept 5 minutes · in 3m 00s')

    // No new read before 30 s; one after, while the tab is open.
    const before = reads()
    await clock.advance(10_000)
    await clock.settle()
    expect(reads()).toBe(before)
    await clock.advance(30_000)
    await clock.settle()
    expect(reads()).toBe(before + 1)
    // Refresh reads at once.
    await ui.press({ key: CACHE_REFRESH_KEY })
    await clock.settle()
    expect(reads()).toBe(before + 2)

    // Past its hour: expired, and the next request would write it all again.
    await clock.advance(47 * MINUTE)
    await clock.settle()
    const late = await textsIn(ui, CACHE_MAIN_KEY)
    expect(late[late.indexOf('Expires') + 1]).toMatch(/^expired /)
    expect(late[late.indexOf('Next request writes it again') + 1]).toBe('≈ $0.86')

    // Another tab: no more reads.
    await ui.press({ key: 'tab:overview' })
    await clock.settle()
    const away = reads()
    await clock.advance(5 * MINUTE)
    await clock.settle()
    expect(reads()).toBe(away)
    await ui.unmount()
  })

  test('at its fullest (100 requests, 15 items, 40 agents) it is a drawing every app draws, the lists fitted', { timeoutMs: 60_000 }, async ($, on) => {
    const clock = world(on)
    const requests = Array.from({ length: 100 }, (_, n) => request(`m${n}`, NOW - (100 - n) * MINUTE, 500_000 + n * 1_000, 1_000))
    const items = Array.from({ length: 15 }, (_, n) => ({ kind: 'result', id: `toolu_${n}`, name: 'Bash', input: { command: `python3 - <<'EOF'\n${'print(1)\n'.repeat(80)}EOF` }, chars: 40_000 - n, at: NOW - n }))
    const agents = Array.from({ length: 40 }, (_, n) => ({ id: `agent${n}`, label: `confirm:${n}:${'a long finding about the pane '.repeat(4)}`, type: 'workflow-subagent', requests: 60, last: request(`a${n}`, NOW - n * MINUTE, 150_000, 0, 2_000, 'claude-opus-5-5'), totals: [{ model: 'claude-opus-5-5', requests: 60, input: 120, output: 9_000, read: 4_000_000, write5m: 150_000, write1h: 0 }] }))
    transcripts.cache = answer({ requests, items }, agents)
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
    await clock.settle()
    for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: 54 } })
      await ui.press({ key: 'tab:cache' })
      await clock.settle()
      expect(await ui.find({ key: 'pane:toobig' })).toBeUndefined()
      const size = desktopSizeOf(await ui.drawn())
      expect([surface, isDesktopDrawn(size)]).toEqual([surface, true])
      // The lists said what they left out.
      expect(await ui.find({ type: 'Text', text: /^… \d+ more not drawn$/ })).toBeDefined()
      await clock.advance(1_000)
      await ui.unmount()
    }
  })

  test('says so when the transcript cannot be read, or holds no request yet', { timeoutMs: 30_000 }, async ($, on) => {
    const clock = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:cache' })
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: 'The session’s transcript could not be read.' })).toBeDefined()
    // The note stands in for the cards, Refresh with them: the tab reads again on its own.
    transcripts.cache = { main: { requests: [], totals: [], resets: [], startedAt: 0, startTokens: 0, items: [], kinds: {} }, agents: [] }
    await clock.advance(31_000)
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: 'No model request yet: the cache fills with the first.' })).toBeDefined()
    await ui.unmount()
  })
})
