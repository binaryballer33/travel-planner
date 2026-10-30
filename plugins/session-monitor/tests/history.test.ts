import { describe, expect, test } from 'claude-code/testing'

import { blankAgent } from '../hooks/lib/agents'
import { emptyMetrics, startRecord } from '../hooks/lib/commands'
import {
  buildSnapshot,
  commitExistsArgv,
  entryOf,
  fitSnapshot,
  historyKey,
  HISTORY_CHARS,
  isSha,
  MAX_SESSIONS,
  packSnapshot,
  pastGit,
  pastOutput,
  planHistory,
  planPrune,
  PROMPT_TEXT_CHARS,
  readEntries,
  readSnapshot,
  sessionDate,
  sessionLabel,
  settleSnapshot,
  SNAPSHOT_CAPS,
  SNAPSHOT_CHARS,
  snapshotKey,
  upsertEntry,
  type SnapshotParts,
} from '../hooks/lib/history'
import { EMPTY_SPEND } from '../hooks/lib/spend'
import type { AgentRecord, CommandRecord, CommitInfo, GitView, PromptRecord, SessionEntry, SessionSnapshot, SourceRecord, UsageView } from '../types'
import { NOW } from './world'

const prompt = (id: string, at: number, fields: Partial<PromptRecord> = {}): PromptRecord => ({
  id,
  text: `prompt ${id}`,
  summary: `Prompt ${id}`,
  isModelSummary: false,
  at,
  origin: 'composer',
  taskId: `task-${id}`,
  ...fields,
})

const call = (id: string, at: number, fields: Partial<CommandRecord> = {}): CommandRecord => ({
  ...startRecord(id, 'Bash', { command: `echo ${id}` }, at, undefined, 'engine'),
  status: 'ok',
  endedAt: at + 1_000,
  ...fields,
})

const commit = (sha: string, date: number, fields: Partial<CommitInfo> = {}): CommitInfo => ({
  sha,
  short: sha.slice(0, 7),
  subject: `commit ${sha.slice(0, 4)}`,
  body: '',
  author: 'Ada',
  email: 'ada@example.com',
  date,
  parents: ['b'.repeat(40), 'c'.repeat(40)],
  refs: 'HEAD -> main',
  files: [{ path: 'src/app.py', status: 'M', added: 5, removed: 2, isBinary: false, isUntracked: false }],
  isSession: true,
  ...fields,
})

const usageOf = (fields: Partial<UsageView> = {}): UsageView => ({
  costUsd: 1.23,
  contextPct: 25,
  contextTokens: 50_000,
  contextWindow: 200_000,
  rateLimits: [{ kind: 'five_hour', percentUsed: 40 }],
  model: 'claude-opus-5-5',
  turns: 3,
  sessionStartedAt: NOW - 3_600_000,
  updatedAt: NOW,
  ...fields,
})

const GIT: GitView = {
  isRepo: true,
  root: '/repo',
  branch: 'main',
  head: 'a'.repeat(40),
  ahead: 0,
  behind: 0,
  worktree: [{ path: 'notes.md', status: 'A', added: 4, removed: 0, isBinary: false, isUntracked: true, mtimeMs: NOW }],
  commits: [commit('d'.repeat(40), NOW - 60_000), commit('e'.repeat(40), NOW - 86_400_000, { isSession: false })],
  scope: 'session',
  updatedAt: NOW,
}

const source = (url: string, kind: SourceRecord['kind'], domain: string, lastAt = NOW): SourceRecord => ({
  id: url,
  kind,
  url,
  domain,
  tool: 'WebFetch',
  count: 1,
  firstAt: lastAt,
  lastAt,
  isError: false,
  taskIds: [],
})

const parts = (fields: Partial<SnapshotParts> = {}): SnapshotParts => ({
  id: 'session-1',
  project: '/repo',
  floor: 0,
  startedAt: NOW - 3_600_000,
  prompts: [],
  commands: [],
  agents: [],
  touched: [],
  git: GIT,
  artifacts: [],
  usage: usageOf(),
  spend: EMPTY_SPEND,
  sources: [],
  models: [],
  ...fields,
})

/** A record of one prompt and one call, or with what `fields` give. */
const built = (fields: Partial<SnapshotParts> = {}): SessionSnapshot => {
  const snapshot = buildSnapshot(parts({ prompts: [prompt('p1', NOW - 600_000)], commands: [call('c1', NOW - 500_000)], ...fields }))
  if (snapshot === undefined) {
    throw new Error('expected a record')
  }
  return snapshot
}

const entry = (id: string, startedAt: number, fields: Partial<SessionEntry> = {}): SessionEntry => ({
  id,
  startedAt,
  lastAt: startedAt + 60_000,
  title: `Session ${id}`,
  prompts: 1,
  commands: 2,
  bytes: 1_000,
  ...fields,
})

describe('building a record', () => {
  test('nothing to keep without a prompt or a call', () => {
    expect(buildSnapshot(parts())).toBeUndefined()
    expect(buildSnapshot(parts({ touched: [{ path: '/repo/a', activity: 'read', reads: 1, edits: 0, firstAt: NOW, lastAt: NOW, tools: ['Read'] }] }))).toBeUndefined()
  })

  test('what the tabs draw, trimmed: no outputs, no sampler groups, no live rates, short texts', () => {
    const group = { id: 'p:1', kind: 'bash' as const, label: 'x', pid: 1, procs: 1, startedAt: NOW, mem: 1e6, peakMem: 2e6, cpuPct: 50, watts: 2, netInBps: 9, netOutBps: 9, diskRBps: 0, diskWBps: 0, tot: { cpuS: 1, energyJ: 2, energyEstJ: 0, netIn: 3, netOut: 4, diskR: 0, diskW: 0, netActiveS: 1 } }
    const busy = call('c1', NOW - 500_000, {
      title: 'x'.repeat(5_000),
      preview: 'y'.repeat(300),
      groups: [group],
      metrics: { ...emptyMetrics(), cpuS: 1, cpuPct: 50, watts: 2, mem: 1e6, peakMem: 2e6, procs: 3, isSampled: true },
    })
    const snapshot = built({
      prompts: [prompt('p1', NOW - 600_000, { text: 'z'.repeat(5_000), summary: 'Fix the flaky test' })],
      commands: [busy],
      sources: [source('https://a.example/x', 'fetch', 'a.example'), source('search:spy', 'search', 'search')],
      models: [{ model: 'claude-opus-5-5', effort: 'xhigh', turns: 1, prompts: 1, requests: 2, toolCalls: 1, agentRequests: 0 }],
    })
    const kept = snapshot.commands[0]
    expect(kept?.groups).toEqual([])
    expect(kept?.title.length).toBe(400)
    expect(kept?.preview.length).toBe(160)
    expect(kept?.metrics.cpuS).toBe(1)
    expect(kept?.metrics.peakMem).toBe(2e6)
    expect([kept?.metrics.cpuPct, kept?.metrics.watts, kept?.metrics.mem, kept?.metrics.procs]).toEqual([0, 0, 0, 0])
    expect(snapshot.prompts[0]?.text.length).toBe(PROMPT_TEXT_CHARS)
    expect(snapshot.title).toBe('Fix the flaky test')
    // Only the commits it made, their refs (stale by then) and second parents left out.
    expect(snapshot.commits.map(one => one.sha)).toEqual(['d'.repeat(40)])
    expect(snapshot.commits[0]?.refs).toBe('')
    expect(snapshot.commits[0]?.parents).toEqual(['b'.repeat(40)])
    expect(snapshot.worktree[0]?.mtimeMs).toBeUndefined()
    expect([snapshot.root, snapshot.branch, snapshot.head]).toEqual(['/repo', 'main', 'a'.repeat(40)])
    expect(snapshot.sources).toEqual({ urls: 2, domains: 2, searches: 1 })
    expect(snapshot.usage.costUsd).toBe(1.23)
    expect(snapshot.models.map(one => one.effort)).toEqual(['xhigh'])
    // It began when the session did; its last activity is its call's end.
    expect(snapshot.startedAt).toBe(NOW - 3_600_000)
    expect(snapshot.lastAt).toBe(NOW - 499_000)
  })

  test('each list keeps its newest', () => {
    const calls = Array.from({ length: 200 }, (_, index) => call(`c${index}`, NOW - 1_000_000 + index * 1_000))
    const prompts = Array.from({ length: 80 }, (_, index) => prompt(`p${index}`, NOW - 1_000_000 + index * 1_000))
    const agents: AgentRecord[] = Array.from({ length: 50 }, (_, index) => ({ ...blankAgent(`a${index}`, 'subagent', NOW - 900_000 + index), status: 'completed' }))
    const snapshot = built({ commands: calls, prompts, agents })
    expect(snapshot.commands.length).toBe(SNAPSHOT_CAPS.commands)
    expect(snapshot.commands[0]?.id).toBe('c50')
    expect(snapshot.commands.at(-1)?.id).toBe('c199')
    expect(snapshot.prompts.length).toBe(SNAPSHOT_CAPS.prompts)
    expect(snapshot.prompts[0]?.id).toBe('p20')
    // The title is the first prompt it kept.
    expect(snapshot.title).toBe('Prompt p20')
    expect(snapshot.agents.length).toBe(SNAPSHOT_CAPS.agents)
    expect(snapshot.agents.at(-1)?.id).toBe('a49')
  })

  test('a record begins at its floor: what came before a /clear is not its', () => {
    const snapshot = built({
      floor: NOW - 100_000,
      prompts: [prompt('before', NOW - 200_000), prompt('after', NOW - 50_000)],
      commands: [call('c-before', NOW - 150_000), call('c-after', NOW - 40_000)],
      git: { ...GIT, commits: [commit('d'.repeat(40), NOW - 60_000), commit('f'.repeat(40), NOW - 300_000)] },
    })
    expect(snapshot.prompts.map(one => one.id)).toEqual(['after'])
    expect(snapshot.commands.map(one => one.id)).toEqual(['c-after'])
    expect(snapshot.commits.map(one => one.sha)).toEqual(['d'.repeat(40)])
    expect(snapshot.startedAt).toBe(NOW - 100_000)
    expect(snapshot.title).toBe('Prompt after')
    // Nothing since the floor: nothing to keep.
    expect(buildSnapshot(parts({ floor: NOW, prompts: [prompt('before', NOW - 200_000)] }))).toBeUndefined()
  })

  test('merged into the record saved last: what the live lists no longer hold stays, and the live value wins', () => {
    const previous = built({
      commands: [call('a', NOW - 900_000), call('b', NOW - 800_000, { status: 'running', endedAt: undefined })],
      usage: usageOf({ costUsd: 9.99, turns: 40 }),
      spend: { ...EMPTY_SPEND, requests: 30, totalUsd: 8 },
    })
    const snapshot = built({
      commands: [call('b', NOW - 800_000), call('c', NOW - 100_000)],
      usage: usageOf({ updatedAt: 0, costUsd: undefined }),
      previous,
    })
    expect(snapshot.commands.map(one => [one.id, one.status])).toEqual([
      ['a', 'ok'],
      ['b', 'ok'],
      ['c', 'ok'],
    ])
    // Usage not read yet this time: the record's stands, as does its spend.
    expect(snapshot.usage.costUsd).toBe(9.99)
    expect(snapshot.spend.requests).toBe(30)
    expect(snapshot.startedAt).toBe(previous.startedAt)
    // Another session's record is never merged.
    expect(built({ commands: [call('c', NOW)], previous: { ...previous, id: 'other' } }).commands.map(one => one.id)).toEqual(['c'])
  })
})

describe('packing and reading a record', () => {
  test('a packed record reads back as it was, smaller', () => {
    const snapshot = built({
      prompts: [prompt('p1', NOW - 600_000, { run: { turns: 1, workMs: 2_000, requests: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, usd: 0, agents: [] } })],
      commands: [
        call('c1', NOW - 500_000, { exitCode: 0, spend: { usd: 0.01, tokens: 1_200, input: 1_200, cached: 0, output: 0, requestUsd: 0.02, requestTokens: 2_400, shares: 2, model: 'claude-opus-5-5' } }),
        call('c2', NOW - 400_000, { tool: 'Read', access: 'read', exitCode: undefined, spend: { usd: 0.01, tokens: 1_200, requestUsd: 0.02, requestTokens: 2_400, shares: 2, model: 'claude-opus-5-5' } }),
      ],
      usage: usageOf({ costUsd: 0, contextPct: 0 }),
      agents: [{ ...blankAgent('ag', 'subagent', NOW - 300_000), status: 'completed', runs: [{ startedAt: NOW - 300_000, endedAt: NOW - 200_000, requests: 3, reason: 'answer' }] }],
      artifacts: [{ id: 'https://claude.ai/code/artifact/1', kind: 'page', title: 'Report', url: 'https://claude.ai/code/artifact/1', count: 2, firstAt: NOW - 100, lastAt: NOW }],
    })
    const packed = packSnapshot(snapshot)
    expect(packed.length).toBeLessThan(JSON.stringify(snapshot).length)
    const read = readSnapshot(JSON.parse(packed))
    expect(read).toEqual(readSnapshot(JSON.parse(JSON.stringify(snapshot))))
    // Zeros that say something survive packing: an exit code of 0, a cost of $0, a run's empty agent list.
    expect(read?.commands[0]?.exitCode).toBe(0)
    expect(read?.commands[1]?.exitCode).toBeUndefined()
    expect(read?.usage.costUsd).toBe(0)
    expect(read?.usage.contextPct).toBe(0)
    expect(read?.prompts[0]?.run?.agents).toEqual([])
    expect(read?.agents[0]?.runs?.[0]?.requests).toBe(3)
    expect(read?.artifacts[0]?.count).toBe(2)
    expect(read?.commands[1]?.metrics).toEqual(emptyMetrics())
    // A share's tokens in and out read back, its zeros too; a record kept before them reads without.
    expect(read?.commands[0]?.spend).toMatchObject({ tokens: 1_200, input: 1_200, cached: 0, output: 0 })
    expect(read?.commands[1]?.spend?.tokens).toBe(1_200)
    expect(read?.commands[1]?.spend).not.toHaveProperty('input')
  })

  test('reading drops what does not parse', () => {
    const snapshot = JSON.parse(JSON.stringify(built()))
    expect(readSnapshot(undefined)).toBeUndefined()
    expect(readSnapshot('nope')).toBeUndefined()
    expect(readSnapshot({ ...snapshot, v: 2 })).toBeUndefined()
    expect(readSnapshot({ ...snapshot, id: '' })).toBeUndefined()
    const read = readSnapshot({
      ...snapshot,
      commands: [{ id: 'ok', tool: 'Bash', status: 'ok', access: 'execute', startedAt: NOW }, { tool: 'Bash', status: 'ok', access: 'execute', startedAt: NOW }, { id: 'bad', tool: 'Bash', status: 'exploded', access: 'execute', startedAt: NOW }],
      prompts: [{ id: 'p', text: 'hi', at: NOW }, { id: 'no-time', text: 'hi' }, 'junk'],
      agents: [{ id: 'a', kind: 'robot', status: 'running', startedAt: NOW }],
      touched: [{ path: '/repo/a', activity: 'read' }, { path: '/repo/b', activity: 'eaten' }],
      commits: [commit('d'.repeat(40), NOW), { ...commit('d'.repeat(40), NOW), sha: 'not a sha; rm -rf /' }, { ...commit('9'.repeat(40), NOW), parents: ['--output=/tmp/x'] }],
      artifacts: [{ id: 'x', kind: 'page', title: 'X', url: 'javascript:alert(1)' }],
    })
    expect(read?.commands.map(one => one.id)).toEqual(['ok'])
    expect(read?.commands[0]?.actor).toEqual({ kind: 'claude', name: '' })
    expect(read?.prompts.map(one => [one.id, one.summary])).toEqual([['p', 'Hi']])
    expect(read?.agents).toEqual([])
    expect(read?.touched.map(one => one.path)).toEqual(['/repo/a'])
    expect(read?.commits.map(one => one.sha)).toEqual(['d'.repeat(40), '9'.repeat(40)])
    expect(read?.commits[1]?.parents).toEqual([])
    expect(read?.artifacts[0]?.url).toBeUndefined()
  })

  test("a project's list reads each session once, the newest first", () => {
    const list = readEntries([entry('a', NOW - 2_000), entry('b', NOW - 1_000), { id: 'a', startedAt: NOW }, { title: 'no id' }, 'junk', { id: 'c', startedAt: 'yesterday' }])
    expect(list.map(one => one.id)).toEqual(['b', 'a'])
    expect(readEntries(undefined)).toEqual([])
  })
})

describe('fitting a record into its budget', () => {
  test('a record over its budget loses its oldest calls first; one within it is left as it was', () => {
    const calls = Array.from({ length: 150 }, (_, index) => call(`c${index}`, NOW - 1_000_000 + index * 1_000, { title: `${index} ${'x'.repeat(390)}` }))
    const snapshot = built({ commands: calls })
    const whole = fitSnapshot(snapshot, 1_000_000)
    expect(whole.snapshot).toBe(snapshot)
    expect(whole.json).toBe(packSnapshot(snapshot))
    const fitted = fitSnapshot(snapshot, 30_000)
    expect(fitted.json.length).toBeLessThanOrEqual(30_000)
    expect(fitted.json).toBe(packSnapshot(fitted.snapshot))
    expect(fitted.snapshot.commands.length).toBeLessThan(150)
    expect(fitted.snapshot.commands.at(-1)?.id).toBe('c149')
    // Its prompt was not touched: the calls were enough.
    expect(fitted.snapshot.prompts).toEqual(snapshot.prompts)
  })

  test('the largest record a session can make fits its budget once fitted', () => {
    const long = (prefix: string): string => `${prefix} ${'x'.repeat(5_000)}`
    const flow = { after: Array.from({ length: 5 }, (_, index) => ({ id: `f${index}`, tool: 'Read', summary: long('s'), uses: [long('u'), long('u'), long('u')] })), said: long('said'), asked: Array.from({ length: 9 }, () => long('a')) }
    const snapshot = built({
      prompts: Array.from({ length: 100 }, (_, index) =>
        prompt(`p${index}`, NOW - 900_000 + index, { text: long('p'), summary: long('s'), run: { turns: 1, workMs: 1, requests: 1, tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, usd: 1, agents: Array.from({ length: 50 }, (_, at) => `agent-${at}`) } }),
      ),
      commands: Array.from({ length: 400 }, (_, index) =>
        call(`c${index}`, NOW - 800_000 + index, { title: long('t'), description: long('d'), summary: long('s'), preview: long('o'), filePath: long('/f'), flow, spend: { usd: 1, tokens: 1, input: 1, cached: 1, output: 1, requestUsd: 1, requestTokens: 1, shares: 1, model: 'claude-opus-5-5', blockKey: 'k' } }),
      ),
      agents: Array.from({ length: 200 }, (_, index) => ({ ...blankAgent(`a${index}`, 'subagent', NOW - 700_000 + index), status: 'completed' as const, label: long('l'), brief: long('b'), lastAnswer: long('a'), description: long('d') })),
      touched: Array.from({ length: 400 }, (_, index) => ({ path: `/repo/${'dir/'.repeat(40)}${index}.ts`, activity: 'modified' as const, reads: 1, edits: 1, firstAt: NOW, lastAt: NOW - 600_000 + index, tools: ['Read', 'Edit', 'Write', 'MultiEdit', 'Bash', 'Grep', 'Glob'] })),
      git: {
        ...GIT,
        worktree: Array.from({ length: 300 }, (_, index) => ({ path: `${'dir/'.repeat(40)}${index}.ts`, status: 'M' as const, added: 1, removed: 1, isBinary: false, isUntracked: false })),
        commits: Array.from({ length: 60 }, (_, index) =>
          commit(`${index.toString(16).padStart(2, '0')}${'a'.repeat(38)}`, NOW - 500_000 + index, {
            body: long('b'),
            subject: long('s'),
            files: Array.from({ length: 200 }, (_, at) => ({ path: `${'dir/'.repeat(20)}${at}.ts`, status: 'M' as const, added: 1, removed: 1, isBinary: false, isUntracked: false })),
          }),
        ),
      },
      artifacts: Array.from({ length: 200 }, (_, index) => ({ id: `https://claude.ai/code/artifact/${index}`, kind: 'page' as const, title: long('t'), url: `https://claude.ai/code/artifact/${index}`, caption: long('c'), count: 1, firstAt: NOW, lastAt: NOW + index })),
    })
    const fitted = fitSnapshot(snapshot, SNAPSHOT_CHARS)
    expect(fitted.json.length).toBeLessThanOrEqual(SNAPSHOT_CHARS)
    expect(readSnapshot(JSON.parse(fitted.json))?.commands.at(-1)?.id).toBe('c399')
    // Ten such records stay within every project's budget.
    expect(MAX_SESSIONS * SNAPSHOT_CHARS).toBeLessThanOrEqual(HISTORY_CHARS)
  })

  test('past the calls: files, agents, commits and the prompts’ words go next, each down to a floor', () => {
    const prompts = Array.from({ length: 60 }, (_, index) => prompt(`p${index}`, NOW - 1_000_000 + index, { text: 'w'.repeat(1_000) }))
    const fitted = fitSnapshot(built({ prompts }), 8_000)
    expect(fitted.json.length).toBeLessThanOrEqual(8_000)
    expect(fitted.snapshot.prompts.length).toBe(20)
    expect(fitted.snapshot.prompts.at(-1)?.id).toBe('p59')
    expect(fitted.snapshot.prompts.every(one => one.text.length <= 280)).toBe(true)
  })
})

describe("a project's list of past sessions", () => {
  test('newest first, capped; the session saving is always kept', () => {
    const list = [entry('a', NOW - 3_000), entry('b', NOW - 2_000), entry('c', NOW - 1_000)]
    const added = upsertEntry(list, entry('d', NOW), 3)
    expect(added.kept.map(one => one.id)).toEqual(['d', 'c', 'b'])
    expect(added.dropped).toEqual(['a'])
    const replaced = upsertEntry(list, entry('b', NOW - 2_000, { title: 'New title' }), 3)
    expect(replaced.kept.map(one => [one.id, one.title])).toEqual([
      ['c', 'Session c'],
      ['b', 'New title'],
      ['a', 'Session a'],
    ])
    expect(replaced.dropped).toEqual([])
    // A long session started before the others still keeps its own line.
    const oldest = upsertEntry(list, entry('z', NOW - 9_000), 2)
    expect(oldest.kept.map(one => one.id)).toEqual(['c', 'z'])
    expect(oldest.dropped).toEqual(['b', 'a'])
  })

  test("every project's records within a budget: the least recently active go first, never the running session", () => {
    const indexes = [
      { project: '/a', entries: [entry('a1', NOW - 10_000, { bytes: 400, lastAt: NOW - 5_000 }), entry('a2', NOW - 50_000, { bytes: 400, lastAt: NOW - 40_000 })] },
      { project: '/b', entries: [entry('b1', NOW - 90_000, { bytes: 400, lastAt: NOW - 80_000 })] },
    ]
    expect(planPrune(indexes, 'live', 1_200)).toEqual([])
    expect(planPrune(indexes, 'live', 1_000)).toEqual([{ project: '/b', id: 'b1' }])
    expect(planPrune(indexes, 'live', 500)).toEqual([
      { project: '/b', id: 'b1' },
      { project: '/a', id: 'a2' },
    ])
    expect(planPrune(indexes, 'b1', 500)).toEqual([
      { project: '/a', id: 'a2' },
      { project: '/a', id: 'a1' },
    ])
  })

  test("a session's start mends the lists: lines without records go, records without lines come back, and the store is pruned", () => {
    const orphan = { ...built({ id: 'orphan' }), project: '/repo' }
    const lists = new Map([
      ['/repo', [entry('kept', NOW - 1_000), entry('gone', NOW - 2_000)]],
      ['/other', Array.from({ length: MAX_SESSIONS + 2 }, (_, index) => entry(`o${index}`, NOW - index * 1_000))],
    ])
    const keys = [historyKey('/repo'), historyKey('/other'), snapshotKey('kept'), snapshotKey('orphan'), snapshotKey('junk'), ...Array.from({ length: MAX_SESSIONS + 2 }, (_, index) => snapshotKey(`o${index}`))]
    const plan = planHistory(
      lists,
      keys,
      [
        { key: snapshotKey('orphan'), snapshot: orphan, bytes: 500 },
        { key: snapshotKey('junk'), snapshot: undefined, bytes: 4 },
        { key: snapshotKey('misfiled'), snapshot: { ...orphan, id: 'someone-else' }, bytes: 500 },
      ],
      'live',
    )
    expect(plan.lists.get('/repo')?.map(one => one.id)).toEqual(['kept', 'orphan'])
    expect(plan.lists.get('/other')?.length).toBe(MAX_SESSIONS)
    expect([...plan.changed].sort()).toEqual(['/other', '/repo'])
    expect(plan.deletes).toEqual([snapshotKey('junk'), snapshotKey('misfiled'), snapshotKey(`o${MAX_SESSIONS}`), snapshotKey(`o${MAX_SESSIONS + 1}`)])
    // Over the budget: the least recently active go, whatever their project.
    const heavy = planHistory(new Map([['/repo', [entry('new', NOW, { bytes: HISTORY_CHARS / 2 }), entry('old', NOW - 9_000, { bytes: HISTORY_CHARS })]]]), [snapshotKey('new'), snapshotKey('old')], [], 'live')
    expect(heavy.lists.get('/repo')?.map(one => one.id)).toEqual(['new'])
    expect(heavy.deletes).toEqual([snapshotKey('old')])
  })
})

describe('showing a record', () => {
  test('settled: nothing in it runs any more', () => {
    const snapshot = built({
      prompts: [prompt('open', NOW - 600_000, { run: { turns: 1, workMs: 0, requests: 1, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, usd: 0.01 } })],
      commands: [
        call('running', NOW - 500_000, { status: 'running', endedAt: undefined }),
        call('background', NOW - 400_000, { status: 'background', isBackground: true }),
        call('failed', NOW - 300_000, { status: 'error' }),
      ],
      agents: [
        { ...blankAgent('working', 'subagent', NOW - 200_000), status: 'running', lastActivityAt: NOW - 100_000, phase: { kind: 'tool', since: NOW, detail: 'x' } },
        { ...blankAgent('idle', 'teammate', NOW - 200_000), status: 'idle' },
      ],
    })
    const settled = settleSnapshot(snapshot)
    expect(settled.commands.map(one => [one.id, one.status])).toEqual([
      ['running', 'denied'],
      ['background', 'ok'],
      ['failed', 'error'],
    ])
    expect(settled.commands[0]?.endedAt).toBe(snapshot.lastAt)
    expect(settled.agents.map(one => [one.id, one.status, one.endedAt, one.phase])).toEqual([
      ['working', 'killed', NOW - 100_000, undefined],
      ['idle', 'idle', undefined, undefined],
    ])
    expect(settled.prompts[0]?.run?.endedAt).toBe(snapshot.lastAt)
    expect(settled.prompts[0]?.run?.endReason).toBe('aborted')
  })

  test('as git saw it: its commits and what it left uncommitted', () => {
    const snapshot = built()
    const view = pastGit(snapshot)
    expect(view.isRepo).toBe(true)
    expect(view.commits).toBe(snapshot.commits)
    expect(view.worktree).toBe(snapshot.worktree)
    expect([view.root, view.branch, view.head, view.scope, view.updatedAt]).toEqual(['/repo', 'main', 'a'.repeat(40), 'session', snapshot.lastAt])
  })

  test("an opened call's output: the first line a record keeps, said so", () => {
    expect(pastOutput(call('c', NOW, { outputChars: 0 }))).toBe('')
    expect(pastOutput(call('c', NOW, { outputChars: 300, preview: 'downloaded data.zip' }))).toBe("downloaded data.zip\n\n(A past session keeps only the first line of a call's output.)")
    expect(pastOutput(call('c', NOW, { outputChars: 300, preview: '' }))).toMatch(/^…\n/)
  })

  test("the picker's labels: when it began, its first prompt and what it cost", () => {
    const at = new Date(2026, 9, 14, 16, 52).getTime()
    expect(sessionDate(at)).toBe('Oct 14, 4:52 PM')
    expect(sessionDate(new Date(2026, 0, 3, 0, 5).getTime())).toBe('Jan 3, 12:05 AM')
    expect(sessionLabel(entry('a', at, { title: 'Fix the flaky test', usd: 1.234 }))).toBe('Oct 14, 4:52 PM · Fix the flaky test · ≈ $1.23')
    expect(sessionLabel(entry('a', at, { title: '', usd: 0 }))).toBe('Oct 14, 4:52 PM · No prompts')
    expect(sessionLabel(entry('a', at, { title: 'T' }))).toBe('Oct 14, 4:52 PM · T')
  })

  test("a record's line in its project's list", () => {
    const snapshot = built({ usage: usageOf({ costUsd: undefined }), spend: { ...EMPTY_SPEND, totalUsd: 0.5, requests: 3 } })
    expect(entryOf(snapshot, 1_234)).toEqual({
      id: 'session-1',
      startedAt: snapshot.startedAt,
      lastAt: snapshot.lastAt,
      title: 'Prompt p1',
      usd: 0.5,
      prompts: 1,
      commands: 1,
      bytes: 1_234,
    })
    expect(entryOf(built(), 1).usd).toBe(1.23)
  })

  test('only a commit id reaches git', () => {
    expect(commitExistsArgv('d'.repeat(40))).toEqual(['git', '-c', 'core.quotePath=false', '--no-pager', 'cat-file', '-e', `${'d'.repeat(40)}^{commit}`])
    expect(isSha('abc1234')).toBe(true)
    expect(isSha('--help')).toBe(false)
    expect(isSha('abc')).toBe(false)
  })
})
