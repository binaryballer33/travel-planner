import { describe, expect, test } from 'claude-code/testing'

import { startRecord } from '../hooks/lib/commands'
import { buildSnapshot, entryOf, packSnapshot, pastOutput, readSnapshot } from '../hooks/lib/history'
import { EMPTY_SPEND } from '../hooks/lib/spend'
import {
  commandOfTranscript,
  joinTranscript,
  MAX_LISTED,
  mergeEntries,
  parseSession,
  parseSummaries,
  PROMPT_SLACK_MS,
  runOfTranscript,
  snapshotOfTranscript,
  type TranscriptCall,
  type TranscriptSession,
  type TranscriptSummary,
} from '../hooks/lib/transcripts'
import type { SessionSnapshot } from '../types'
import { NOW } from './world'

const summary = (id: string, lastAt: number, fields: Partial<TranscriptSummary> = {}): TranscriptSummary => ({
  id,
  startedAt: lastAt - 60_000,
  lastAt,
  title: `Session ${id}`,
  prompts: 2,
  calls: 5,
  cwd: '/repo',
  branch: 'main',
  ...fields,
})

const transcriptCall = (id: string, at: number, fields: Partial<TranscriptCall> = {}): TranscriptCall => ({
  id,
  name: 'Bash',
  input: { command: `echo ${id}`, description: `Echo ${id}` },
  startedAt: at,
  endedAt: at + 2_000,
  isError: false,
  output: `${id} said hello\nsecond line`,
  model: 'claude-opus-5-5',
  promptId: 'p1',
  ...fields,
})

const session = (fields: Partial<TranscriptSession> = {}): TranscriptSession => ({
  id: 'session-t',
  title: 'Fix the flaky test',
  cwd: '/repo',
  branch: 'main',
  startedAt: NOW - 600_000,
  lastAt: NOW - 100_000,
  prompts: [
    { id: 'p1', text: 'fix the flaky test', at: NOW - 600_000 },
    { id: 'p2', text: 'now run it again', at: NOW - 300_000 },
  ],
  calls: [transcriptCall('toolu_1', NOW - 590_000), transcriptCall('toolu_2', NOW - 290_000, { isError: true, output: 'exit code 1', promptId: 'p2' })],
  ...fields,
})

/** A record the monitor kept: its first prompt at `firstAt`, holding call `toolu_2` and one of its own. */
const stored = (firstAt: number): SessionSnapshot => {
  const snapshot = buildSnapshot({
    id: 'session-t',
    project: '/repo',
    floor: 0,
    startedAt: NOW - 700_000,
    prompts: [{ id: 'mon-p2', text: 'now run it again', summary: 'Run it again', isModelSummary: true, at: firstAt, origin: 'composer', taskId: 'turn-2' }],
    commands: [
      { ...startRecord('toolu_2', 'Bash', { command: 'pytest' }, NOW - 290_000, undefined, 'engine'), status: 'error', endedAt: NOW - 288_000, outputChars: 11, preview: 'exit code 1' },
      { ...startRecord('toolu_3', 'Read', { file_path: '/repo/a.py' }, NOW - 200_000, undefined, 'engine'), status: 'ok', endedAt: NOW - 199_000 },
    ],
    agents: [],
    touched: [],
    git: { isRepo: true, root: '/repo', branch: 'main', head: 'a'.repeat(40), ahead: 0, behind: 0, worktree: [], commits: [], scope: 'session', updatedAt: NOW },
    artifacts: [],
    usage: { contextWindow: 200_000, rateLimits: [], model: 'claude-opus-5-5', turns: 2, sessionStartedAt: NOW - 700_000, updatedAt: NOW, costUsd: 2.5 },
    spend: EMPTY_SPEND,
    sources: [],
    models: [],
  })
  if (snapshot === undefined) {
    throw new Error('expected a record')
  }
  return snapshot
}

describe("the reader's answers", () => {
  test('a listing keeps the sessions that parse, each once (its latest), the newest first', () => {
    const text = JSON.stringify([
      summary('a', NOW - 5_000),
      summary('b', NOW - 1_000),
      { id: '../etc', startedAt: NOW, lastAt: NOW },
      { id: 'no-start', lastAt: NOW },
      'not a session',
      summary('a', NOW - 500, { title: 'Later copy' }),
    ])
    expect(parseSummaries(text).map(one => [one.id, one.title])).toEqual([
      ['a', 'Later copy'],
      ['b', 'Session b'],
    ])
    expect(parseSummaries('not json')).toEqual([])
    expect(parseSummaries('{"error": "no such project"}')).toEqual([])
  })

  test("a session's prompts and calls are read; what does not parse is left out", () => {
    const text = JSON.stringify({
      ...session(),
      prompts: [...session().prompts, { id: 'p3', text: '' }, 7],
      calls: [...session().calls, { id: 'toolu_x' }, { name: 'Bash' }, null],
    })
    const read = parseSession(text)
    expect(read?.prompts.map(one => one.id)).toEqual(['p1', 'p2'])
    expect(read?.calls.map(one => one.id)).toEqual(['toolu_1', 'toolu_2'])
    expect(read?.calls[1]?.isError).toBe(true)
    expect(parseSession(JSON.stringify({ error: 'not found' }))).toBeUndefined()
    expect(parseSession(JSON.stringify({ ...session(), id: 'bad id!' }))).toBeUndefined()
    expect(parseSession('')).toBeUndefined()
  })

  test("a session's requests are read: each prompt's by model, when it ended, and which read each output; what does not parse is left out", () => {
    const opus = { model: 'claude-opus-5-5', requests: 2, input: 8, output: 600, cacheRead: 20_000, cacheWrite: 23_500 }
    const text = JSON.stringify({
      ...session(),
      prompts: [
        { id: 'p1', text: 'fix the flaky test', at: NOW - 600_000, endedAt: NOW - 500_000, usage: [opus, { model: '', requests: 1 }, { model: 'x', requests: 0 }, 'junk'] },
        { id: 'p2', text: 'now run it again', at: NOW - 300_000, usage: 'none' },
      ],
      calls: [{ ...transcriptCall('toolu_1', NOW), outputChars: 9_000, readBy: 'msg_2' }, { ...transcriptCall('toolu_2', NOW), readBy: '../x' }],
      requests: { msg_2: { ...opus, requests: 1 }, 'bad id': opus, msg_3: { requests: 1 } },
    })
    const read = parseSession(text)
    expect(read?.prompts[0]).toMatchObject({ endedAt: NOW - 500_000, usage: [opus] })
    expect(read?.prompts[1]).not.toHaveProperty('usage')
    expect(read?.calls.map(one => [one.outputChars, one.readBy])).toEqual([
      [9_000, 'msg_2'],
      [undefined, undefined],
    ])
    expect(Object.keys(read?.requests ?? {})).toEqual(['msg_2'])
    // An older reader's answer has none of them.
    expect(parseSession(JSON.stringify(session()))?.requests).toEqual({})
  })
})

describe("the picker's list", () => {
  test("a record wins over its transcript and borrows its title when it has none; the running session is left out; a transcript's own is marked", () => {
    const record = { ...entryOf(stored(NOW - 300_000), 900), title: '' }
    const merged = mergeEntries([record], [summary('session-t', NOW - 100_000, { title: 'From the transcript' }), summary('other', NOW - 50_000), summary('live', NOW)], 'live')
    expect(merged.map(one => [one.id, one.title, one.source ?? 'record', one.bytes])).toEqual([
      ['other', 'Session other', 'transcript', 0],
      ['session-t', 'From the transcript', 'record', 900],
    ])
  })

  test(`at most ${MAX_LISTED} sessions are listed, the newest`, () => {
    const many = Array.from({ length: MAX_LISTED + 5 }, (_, at) => summary(`s${at}`, NOW - at * 1_000))
    const merged = mergeEntries([], many, 'live')
    expect(merged.length).toBe(MAX_LISTED)
    expect(merged.at(-1)?.id).toBe(`s${MAX_LISTED - 1}`)
  })
})

describe('a transcript as a record', () => {
  test('a call is finished with its outcome: ok, an error, or stopped when no result came', () => {
    const done = commandOfTranscript(transcriptCall('toolu_1', NOW))
    expect([done.status, done.endedAt, done.preview, done.outputLines, done.model, done.promptId, done.title]).toEqual([
      'ok',
      NOW + 2_000,
      'toolu_1 said hello',
      2,
      'claude-opus-5-5',
      'p1',
      'echo toolu_1',
    ])
    expect(commandOfTranscript(transcriptCall('toolu_2', NOW, { isError: true, output: 'exit code 2' })).status).toBe('error')
    const { endedAt: _ended, ...unanswered } = transcriptCall('toolu_3', NOW)
    expect(commandOfTranscript(unanswered)).toMatchObject({ status: 'denied', endedAt: NOW })
  })

  test("its prompts carry their prompt id as their task, which their calls name; outputs ride beside it and are never stored", () => {
    const snapshot = snapshotOfTranscript(session(), '/repo')
    expect(snapshot.source).toBe('transcript')
    expect(snapshot.prompts.map(one => [one.id, one.taskId, one.summary])).toEqual([
      ['t:p1', 'p1', 'Fix the flaky test'],
      ['t:p2', 'p2', 'Now run it again'],
    ])
    expect(snapshot.commands.map(one => one.promptId)).toEqual(['p1', 'p2'])
    expect(snapshot.outputs).toEqual({ toolu_1: 'toolu_1 said hello\nsecond line', toolu_2: 'exit code 1' })
    expect(pastOutput(snapshot.commands[0]!, snapshot.outputs)).toBe('toolu_1 said hello\nsecond line')
    const reread = readSnapshot(JSON.parse(packSnapshot(snapshot)))
    expect(reread?.outputs).toBeUndefined()
    expect(reread?.source).toBeUndefined()
  })

  test("a prompt's run is its requests' tokens and price, ended at its last record; none without a request", () => {
    const run = runOfTranscript({
      id: 'p1',
      text: 'x',
      at: NOW - 600_000,
      endedAt: NOW - 500_000,
      usage: [
        { model: 'claude-sonnet-5-5', requests: 1, input: 0, output: 1_000, cacheRead: 0, cacheWrite: 0 },
        { model: 'claude-opus-5-5', requests: 3, input: 1_000, output: 500, cacheRead: 20_000, cacheWrite: 2_000 },
      ],
    })
    // Opus: (1k × $4 + 2k × $5 + 20k × $0.20 + 500 × $20) / 1M = $0.028; Sonnet: 1k × $10 / 1M = $0.01.
    expect(run).toMatchObject({ requests: 4, endedAt: NOW - 500_000, model: 'claude-opus-5-5', tokens: { input: 1_000, output: 1_500, cacheRead: 20_000, cacheWrite: 2_000 } })
    expect(Math.round((run?.usd ?? 0) * 1e6)).toBe(38_000)
    // Never running: it has ended, however its last record was stamped.
    expect(runOfTranscript({ id: 'p', text: 'x', at: NOW, endedAt: NOW - 5, usage: [{ model: 'm', requests: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }] })?.endedAt).toBe(NOW)
    expect(runOfTranscript({ id: 'p', text: 'x', at: NOW })).toBeUndefined()
    // Its cost by the kind of token, each write at the rate of how long it was kept: of Opus's 2k written, 1.5k kept an hour ($8), 500 5 minutes ($5).
    const split = runOfTranscript({ id: 'p', text: 'x', at: NOW, usage: [{ model: 'claude-opus-5-5', requests: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 2_000, cacheWrite1h: 1_500 }] })
    expect([split?.parts?.cacheWrite1h, split?.parts?.cacheWrite5m]).toEqual([
      { tokens: 1_500, usd: 0.012 },
      { tokens: 500, usd: 0.0025 },
    ])
    expect(Math.round((split?.usd ?? 0) * 1e6)).toBe(14_500)
    expect(runOfTranscript({ id: 'p', text: 'x', at: NOW, usage: [] })).toBeUndefined()
  })

  test('its prompts carry their runs, and its calls their shares of the request that read them, split by size as the live session splits them', () => {
    const request = { model: 'claude-opus-5-5', requests: 1, input: 1_000, output: 500, cacheRead: 20_000, cacheWrite: 2_000 }
    const snapshot = snapshotOfTranscript(
      session({
        prompts: [{ id: 'p1', text: 'fix the flaky test', at: NOW - 600_000, endedAt: NOW - 550_000, usage: [request] }, { id: 'p2', text: 'now run it again', at: NOW - 300_000 }],
        calls: [
          transcriptCall('toolu_1', NOW - 590_000, { output: 'cut', outputChars: 2_987, readBy: 'msg_2' }),
          transcriptCall('toolu_2', NOW - 589_000, { output: 'short', outputChars: 987, readBy: 'msg_2' }),
          transcriptCall('toolu_3', NOW - 588_000, { readBy: 'msg_9' }),
          transcriptCall('toolu_4', NOW - 587_000, { readBy: 'msg_x' }),
        ],
        requests: { msg_2: request, msg_9: { ...request, model: 'gpt-x' } },
      }),
      '/repo',
    )
    const [first, second] = snapshot.prompts
    expect(first?.run).toMatchObject({ requests: 1, tokens: { input: 1_000, output: 500, cacheRead: 20_000, cacheWrite: 2_000 } })
    expect(Math.round((first?.run?.usd ?? 0) * 1e6)).toBe(28_000)
    expect(second?.run).toBeUndefined()
    const [one, two, three, four] = snapshot.commands
    // Its whole output's size, not the cut text's.
    expect(one?.outputChars).toBe(2_987)
    // Each output, its title (`echo toolu_1`, 12) and 1: 3,000 and 1,000, so three quarters and a quarter of 23.5k tokens.
    expect(one?.spend).toMatchObject({ tokens: 17_625, input: 17_250, cached: 15_000, output: 375, requestTokens: 23_500, shares: 2, model: 'claude-opus-5-5' })
    expect(two?.spend).toMatchObject({ tokens: 5_875, input: 5_750, output: 125 })
    expect(Math.round(((one?.spend?.usd ?? 0) + (two?.spend?.usd ?? 0)) * 1e6)).toBe(28_000)
    // Read by a request of a model with no price, or one the reader did not list: no share.
    expect([three?.spend, four?.spend]).toEqual([undefined, undefined])
    // The run and the shares are kept like the live session's.
    const reread = readSnapshot(JSON.parse(packSnapshot(snapshot)))
    expect(reread?.prompts[0]?.run?.tokens.cacheRead).toBe(20_000)
    expect(reread?.commands[0]?.spend?.input).toBe(17_250)
  })

  test('joined with its record: the transcript adds what came before the record and what it dropped, each once, and the outputs', () => {
    const record = stored(NOW - 300_000 + 1_000)
    const joined = joinTranscript(record, session(), '/repo')
    // p2 is the record's first prompt, seen by both a second apart: one prompt, the record's.
    expect(joined?.prompts.map(one => one.id)).toEqual(['t:p1', 'mon-p2'])
    expect(joined?.commands.map(one => one.id)).toEqual(['toolu_1', 'toolu_2', 'toolu_3'])
    // The record's own figures stay; the outputs come from the transcript.
    expect(joined?.commands.find(one => one.id === 'toolu_2')?.preview).toBe('exit code 1')
    expect(joined?.usage.costUsd).toBe(2.5)
    expect(joined?.source).toBeUndefined()
    expect(joined?.outputs?.toolu_1).toBe('toolu_1 said hello\nsecond line')
    // A transcript prompt further back than the slack is another prompt.
    expect(joinTranscript(stored(NOW - 300_000 + PROMPT_SLACK_MS + 1), session(), '/repo')?.prompts.map(one => one.id)).toEqual(['t:p1', 't:p2', 'mon-p2'])
    expect(joinTranscript(record, undefined, '/repo')).toBe(record)
    expect(joinTranscript(undefined, session(), '/repo')?.source).toBe('transcript')
    expect(joinTranscript(undefined, undefined, '/repo')).toBeUndefined()
  })

  test('a record without a title takes the transcript’s', () => {
    expect(joinTranscript({ ...stored(NOW), title: '' }, session(), '/repo')?.title).toBe('Fix the flaky test')
  })

  test('a record keeps only the first line of an output where no transcript was read', () => {
    const record = stored(NOW)
    const call = record.commands[0]!
    expect(pastOutput(call)).toContain('keeps only the first line')
    expect(pastOutput(call, {})).toContain('keeps only the first line')
  })
})
