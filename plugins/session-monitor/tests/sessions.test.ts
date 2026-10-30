import type { AgentSpawnInput } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { blankAgent } from '../hooks/lib/agents'
import { startRecord } from '../hooks/lib/commands'
import { keyOf } from '../hooks/lib/format'
import {
  buildSnapshot,
  entryOf,
  historyKey,
  MISSING_COMMIT,
  packSnapshot,
  readEntries,
  readSnapshot,
  sessionDate,
  sessionLabel,
  snapshotKey,
  TODAY_NOTE,
  type SnapshotParts,
} from '../hooks/lib/history'
import { EMPTY_SPEND } from '../hooks/lib/spend'
import { REVEAL_WAITS_MS } from '../hooks/register'
import { agentKey } from '../hooks/view/agents'
import { commitKey, fileKey } from '../hooks/view/commits'
import { touchedKey } from '../hooks/view/files'
import { jumpLabel } from '../hooks/view/kit'
import { OVERVIEW_CARDS } from '../hooks/view/overview'
import { pageStartKey, PROMPTS_NEWER_KEY, PROMPTS_OLDER_KEY, PROMPTS_PAGE, promptKey } from '../hooks/view/prompts'
import { LIVE_SESSION, sessionBackKey, sessionBannerKey, sessionPickerKey } from '../hooks/view/sessions'
import type { TranscriptSession } from '../hooks/lib/transcripts'
import type { CommandRecord, SessionSnapshot } from '../types'
import { heavySession } from './heavy'
import { call, clickRow, debugLines, fail, keysOf, memoryStore, NOW, ok, pageScrollAsked, PANE, SESSION_ID, SHA, shownCode, start, textsIn, transcripts, world, tabButton } from './world'

/** The past session the tests view: two days ago, a prompt, two calls (one still running when saved), an agent, files, two commits and two artifacts. */
const PAST_ID = 'session-past'
const PAST_START = NOW - 2 * 86_400_000
/** A commit git still has, and one it lost (rebased away). */
const KEPT_SHA = 'd'.repeat(40)
const LOST_SHA = 'e'.repeat(40)
const PAST_PAGE = 'https://claude.ai/code/artifact/past-report'
const PAST_FILE = '/repo/out/report.pdf'

const pastCall = (id: string, command: string, at: number, fields: Partial<CommandRecord>): CommandRecord => ({
  ...startRecord(id, 'Bash', { command }, at, undefined, 'engine'),
  promptId: 'task-past',
  ...fields,
})

const record = (fields: Partial<SnapshotParts> & Pick<SnapshotParts, 'id' | 'startedAt'>): SessionSnapshot => {
  const snapshot = buildSnapshot({
    project: '/repo',
    floor: 0,
    prompts: [],
    commands: [],
    agents: [],
    touched: [],
    git: { isRepo: true, root: '/repo', branch: 'main', head: KEPT_SHA, ahead: 0, behind: 0, worktree: [], commits: [], scope: 'session', updatedAt: fields.startedAt },
    artifacts: [],
    usage: { contextWindow: 200_000, rateLimits: [], model: 'claude-opus-5-5', turns: 1, sessionStartedAt: fields.startedAt, updatedAt: fields.startedAt },
    spend: EMPTY_SPEND,
    sources: [],
    models: [],
    ...fields,
  })
  if (snapshot === undefined) {
    throw new Error('expected a record')
  }
  return snapshot
}

const pastRecord = (): SessionSnapshot =>
  record({
    id: PAST_ID,
    startedAt: PAST_START,
    prompts: [
      {
        id: 'past-p1',
        text: 'add a retry to the login test',
        summary: 'Add a retry to the login test',
        isModelSummary: true,
        at: PAST_START + 60_000,
        origin: 'composer',
        taskId: 'task-past',
        run: { turns: 1, workMs: 90_000, endedAt: PAST_START + 150_000, endReason: 'answer', requests: 4, tokens: { input: 900, output: 300, cacheRead: 0, cacheWrite: 0 }, usd: 0.42 },
      },
    ],
    commands: [
      pastCall('toolu_past_1', 'pytest -q', PAST_START + 70_000, {
        summary: 'Run the tests',
        status: 'ok',
        endedAt: PAST_START + 80_000,
        exitCode: 0,
        outputChars: 400,
        outputLines: 5,
        preview: '12 passed in 3.1s',
      }),
      pastCall('toolu_past_2', 'npm run build', PAST_START + 90_000, { summary: 'Build the app', status: 'running' }),
    ],
    agents: [{ ...blankAgent('ag-past', 'subagent', PAST_START + 100_000), label: 'Review the tests', status: 'running', lastActivityAt: PAST_START + 120_000 }],
    touched: [
      { path: '/repo/src/app.py', activity: 'modified', reads: 1, edits: 2, firstAt: PAST_START + 60_000, lastAt: PAST_START + 100_000, editedAt: PAST_START + 100_000, tools: ['Read', 'Edit'] },
      { path: '/repo/README.md', activity: 'read', reads: 1, edits: 0, firstAt: PAST_START + 65_000, lastAt: PAST_START + 65_000, tools: ['Read'] },
    ],
    git: {
      isRepo: true,
      root: '/repo',
      branch: 'retry',
      head: KEPT_SHA,
      ahead: 0,
      behind: 0,
      worktree: [{ path: 'notes.md', status: 'A', added: 4, removed: 0, isBinary: false, isUntracked: true }],
      commits: [
        {
          sha: KEPT_SHA,
          short: 'ddddddd',
          subject: 'feat: retry the login',
          body: 'Flaky on CI.',
          author: 'Ada',
          email: 'ada@example.com',
          date: PAST_START + 140_000,
          parents: ['b'.repeat(40)],
          refs: '',
          files: [{ path: 'src/app.py', status: 'M', added: 5, removed: 2, isBinary: false, isUntracked: false }],
          isSession: true,
        },
        {
          sha: LOST_SHA,
          short: 'eeeeeee',
          subject: 'wip: an experiment',
          body: '',
          author: 'Ada',
          email: 'ada@example.com',
          date: PAST_START + 130_000,
          parents: [KEPT_SHA],
          refs: '',
          files: [{ path: 'src/old.py', status: 'D', added: 0, removed: 9, isBinary: false, isUntracked: false }],
          isSession: true,
        },
      ],
      scope: 'session',
      updatedAt: PAST_START + 150_000,
    },
    artifacts: [
      { id: PAST_PAGE, kind: 'page', title: 'Past report', url: PAST_PAGE, count: 1, firstAt: PAST_START + 145_000, lastAt: PAST_START + 145_000 },
      { id: `file:${PAST_FILE}`, kind: 'file', title: 'report.pdf', path: PAST_FILE, count: 1, firstAt: PAST_START + 146_000, lastAt: PAST_START + 146_000 },
    ],
    usage: {
      costUsd: 4.56,
      contextPct: 61,
      contextTokens: 122_000,
      contextWindow: 200_000,
      rateLimits: [{ kind: 'five_hour', percentUsed: 70 }],
      model: 'claude-sonnet-5',
      turns: 12,
      sessionStartedAt: PAST_START,
      updatedAt: PAST_START + 150_000,
    },
    sources: [{ id: 'https://docs.example.com/a', kind: 'fetch', url: 'https://docs.example.com/a', domain: 'docs.example.com', tool: 'WebFetch', count: 1, firstAt: PAST_START, lastAt: PAST_START, isError: false, taskIds: [] }],
  })

const olderRecord = (id: string, startedAt: number): SessionSnapshot =>
  record({
    id,
    startedAt,
    prompts: [{ id: `${id}-p1`, text: 'set up the project', summary: 'Set up the project', isModelSummary: false, at: startedAt + 1_000, origin: 'composer', taskId: `task-${id}` }],
    spend: { ...EMPTY_SPEND, totalUsd: 0.25, requests: 2 },
  })

/** Keeps records in the store as a session saves them, and lists them for the project, `listed` of them (all by default). */
const keep = (records: readonly SessionSnapshot[], listed: readonly SessionSnapshot[] = records): void => {
  for (const one of records) {
    const stored: unknown = JSON.parse(packSnapshot(one))
    memoryStore.set(snapshotKey(one.id), stored)
  }
  memoryStore.set(
    historyKey('/repo'),
    listed.map(one => entryOf(one, packSnapshot(one).length)),
  )
}

/** The past session and an older one, kept for the project. */
const seedPast = (): { past: SessionSnapshot; older: SessionSnapshot } => {
  const past = pastRecord()
  const older = olderRecord('session-older', NOW - 5 * 86_400_000)
  keep([past, older])
  return { past, older }
}

const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/

test("past sessions: the Prompts tab picks one of the project's earlier sessions, shows its prompts read-only, and goes back", { timeoutMs: 30_000 }, async ($, on) => {
  const toasts: string[] = []
  const clock = world(on, toasts)
  const { past, older } = seedPast()
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:prompts' })
    const picker = await ui.find({ key: sessionPickerKey('prompts') })
    // This session, then the project's earlier ones, the newest first; not this session itself.
    expect(picker?.props.value).toBe(LIVE_SESSION)
    expect(picker?.props.options).toEqual([
      { value: LIVE_SESSION, label: 'This session (live)' },
      { value: PAST_ID, label: sessionLabel(entryOf(past, 0)) },
      { value: older.id, label: sessionLabel(entryOf(older, 0)) },
    ])
    expect(sessionLabel(entryOf(past, 0))).toBe(`${sessionDate(PAST_START)} · Add a retry to the login test · ≈ $4.56`)
    expect(await ui.find({ key: sessionBannerKey('prompts') })).toBeUndefined()

    await ui.select({ key: sessionPickerKey('prompts'), value: PAST_ID })
    await clock.settle()
    expect((await ui.find({ key: sessionPickerKey('prompts') }))?.props.value).toBe(PAST_ID)
    const banner = (await textsIn(ui, sessionBannerKey('prompts'))).join('\n')
    expect(banner).toContain(`Viewing a past session · ${sessionDate(PAST_START)}`)
    expect(banner).toContain('Add a retry to the login test')
    expect(banner).toContain('[Back to this session]')
    expect(banner).toContain(`${jumpLabel(surface, true)} reaches only this session's.`)
    // Its prompt, as a card with what its work came to; done, never running.
    const card = (await textsIn(ui, promptKey('past-p1'))).join('\n')
    expect(card).toContain('Add a retry to the login test')
    expect(card).toContain('✓ Done')
    expect(card).toContain('≈ $0.42')
    // Its conversation is not this one: a Find or Jump says so.
    const before = toasts.length
    await ui.press({ key: `pjump:${keyOf('past-p1')}` })
    expect(toasts.slice(before)).toEqual(['That prompt is from a past session: only this session’s conversation can be searched or scrolled to.'])

    await ui.press({ key: sessionBackKey('prompts') })
    await clock.settle()
    expect((await ui.find({ key: sessionPickerKey('prompts') }))?.props.value).toBe(LIVE_SESSION)
    expect(await ui.find({ key: sessionBannerKey('prompts') })).toBeUndefined()
    expect(await ui.find({ key: promptKey('past-p1') })).toBeUndefined()
    await clock.advance(1_000)
    await ui.unmount()
  }
})

test('past sessions: each session its Prompts tab opens at its newest page, whatever page the other was on', { timeoutMs: 60_000 }, async ($, on) => {
  const clock = world(on)
  const pastPrompts = Array.from({ length: 12 }, (_, index) => ({
    id: `paged-p${index}`,
    text: `past prompt ${index}`,
    summary: `Past prompt ${index}`,
    isModelSummary: false,
    at: PAST_START + (index + 1) * 60_000,
    origin: 'composer',
    taskId: `task-paged-${index}`,
  }))
  keep([record({ id: PAST_ID, startedAt: PAST_START, prompts: pastPrompts })])
  const live = heavySession()
  transcripts.sessions.set(SESSION_ID, live)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const pastKeys = [...pastPrompts].reverse().map(one => promptKey(one.id))
  const liveKeys = [...live.prompts].reverse().map(one => promptKey(`t:${one.id}`))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const drawn = async (keys: readonly string[]): Promise<string[]> => (await keysOf(ui, 'prm:')).filter(key => keys.includes(key))
  await ui.press({ key: 'tab:prompts' })
  await clock.settle()
  for (let page = 0; page < 3; page += 1) {
    await clock.advance(1_000)
    await ui.press({ key: PROMPTS_OLDER_KEY })
    await clock.settle()
  }
  expect((await drawn(liveKeys))[0]).toBe(liveKeys[30])

  // The past session's page starts at its newest prompt, not at the live session's offset.
  await ui.select({ key: sessionPickerKey('prompts'), value: PAST_ID })
  await clock.settle()
  expect((await drawn(pastKeys))[0]).toBe(pastKeys[0])
  expect(await ui.find({ key: PROMPTS_NEWER_KEY })).toBeUndefined()
  await clock.advance(1_000)
  await ui.press({ key: PROMPTS_OLDER_KEY })
  await clock.settle()
  expect((await drawn(pastKeys))[0]).not.toBe(pastKeys[0])

  // And back on this session, its newest prompt again.
  await clock.advance(1_000)
  await ui.press({ key: sessionBackKey('prompts') })
  await clock.settle()
  expect((await drawn(liveKeys))[0]).toBe(liveKeys[0])
  expect(await ui.find({ key: PROMPTS_NEWER_KEY })).toBeUndefined()
  await clock.advance(1_000)
  await ui.unmount()
})

// A call or agent of this session pressed on Overview while a past session is shown brings this session back: at its newest page, not the past one's.
for (const via of ['call', 'agent'] as const) {
  test(`past sessions: one of this session's ${via === 'call' ? 'calls' : 'agents'} pressed on Overview while a past session is on a later page opens this session's Prompts at its newest page`, { timeoutMs: 60_000 }, async ($, on) => {
    on('agent.list', () => ({ value: [] }))
    on('agent.spawn', ($, e) => ({ model: 'claude-haiku-4-5', agentId: e.tool_use_id.replace('toolu_', 'ag-') }))
    const clock = world(on)
    const pastPrompts = Array.from({ length: 12 }, (_, index) => ({
      id: `paged-p${index}`,
      text: `past prompt ${index}`,
      summary: `Past prompt ${index}`,
      isModelSummary: false,
      at: PAST_START + (index + 1) * 60_000,
      origin: 'composer',
      taskId: `task-paged-${index}`,
    }))
    keep([record({ id: PAST_ID, startedAt: PAST_START, prompts: pastPrompts })])
    const live = heavySession()
    transcripts.sessions.set(SESSION_ID, live)
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
    await clock.settle()
    const spawn: AgentSpawnInput = { prompt: 'do it', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false, tool_use_id: 'toolu_x', description: 'Scan the repo', subagentType: 'Explore' }
    await $.agent.spawn(spawn)
    await clock.settle()
    const liveKeys = [...live.prompts].reverse().map(one => promptKey(`t:${one.id}`))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'tab:prompts' })
    await clock.settle()
    await ui.select({ key: sessionPickerKey('prompts'), value: PAST_ID })
    await clock.settle()
    await clock.advance(1_000)
    await ui.press({ key: PROMPTS_OLDER_KEY })
    await clock.settle()
    await ui.press({ key: 'tab:overview' })
    await clock.settle()
    // Most recent commands' call, or the agent's card: both this session's, drawn while the past one is shown.
    const key = via === 'call' ? ((await ui.findAll({ type: 'Client' })).map(client => client.key ?? '').find(one => one.startsWith('recent:')) ?? '') : `ov:${keyOf('ag-x')}`
    expect(key).not.toBe('')
    await clock.advance(1_000)
    await clickRow(ui, key)
    await clock.settle()
    expect((await ui.find({ key: sessionPickerKey(via === 'call' ? 'commands' : 'agents') }))?.props.value ?? LIVE_SESSION).toBe(LIVE_SESSION)
    await clock.advance(1_000)
    await ui.press({ key: 'tab:prompts' })
    await clock.settle()
    expect((await keysOf(ui, 'prm:')).filter(one => liveKeys.includes(one))[0]).toBe(liveKeys[0])
    expect(await ui.find({ key: PROMPTS_NEWER_KEY })).toBeUndefined()
    await clock.advance(1_000)
    await ui.unmount()
  })
}


test("past sessions: Older and Newer on its Prompts tab scroll to the first card of the page they open, one of its prompts", { timeoutMs: 30_000 }, async ($, on) => {
  const clock = world(on)
  // A past session of 12 prompts: Older opens a second page.
  const prompts = Array.from({ length: 12 }, (_, index) => ({
    id: `past-many-${index}`,
    text: `past prompt ${index}`,
    summary: `Past prompt ${index}`,
    isModelSummary: false,
    at: PAST_START + (index + 1) * 60_000,
    origin: 'composer' as const,
    taskId: `task-many-${index}`,
  }))
  const past = record({ id: PAST_ID, startedAt: PAST_START, prompts })
  keep([past])
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab:prompts' })
  await ui.select({ key: sessionPickerKey('prompts'), value: PAST_ID })
  await clock.settle()
  // The page scrolled to starts with the card the tab draws first: the past session's, not this session's.
  expect(pageStartKey(past.prompts, 0)).toBe(promptKey('past-many-11'))
  expect((await keysOf(ui, 'prm:'))[0]).toBe(pageStartKey(past.prompts, 0))
  // The kit scrolls no pane: once the tries are spent, the debug log names the card each pager asked for, the past session's.
  const tries = REVEAL_WAITS_MS.reduce((total, ms) => total + ms, 0)
  await clock.advance(1_000)
  let before = debugLines.length
  await ui.press({ key: PROMPTS_OLDER_KEY })
  await clock.settle()
  expect(pageStartKey(past.prompts, PROMPTS_PAGE)).toBe(promptKey('past-many-1'))
  expect(await keysOf(ui, 'prm:')).toEqual([promptKey('past-many-1'), promptKey('past-many-0')])
  await clock.advance(tries)
  expect(debugLines.slice(before)).toEqual([pageScrollAsked(promptKey('past-many-1'))])
  await clock.advance(1_000)
  before = debugLines.length
  await ui.press({ key: PROMPTS_NEWER_KEY })
  await clock.settle()
  expect((await keysOf(ui, 'prm:'))[0]).toBe(pageStartKey(past.prompts, 0))
  await clock.advance(tries)
  expect(debugLines.slice(before)).toEqual([pageScrollAsked(promptKey('past-many-11'))])
  await clock.advance(1_000)
  await ui.unmount()
})


test('past sessions: Commands and Agents draw its calls and agents, nothing running, an opened call its first line', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = world(on)
  seedPast()
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:commands' })
    const liveRows = (await ui.findAll({ type: 'Client' })).map(client => client.key ?? '').filter(key => key.startsWith('cmd:'))
    expect(liveRows.length).toBe(5)
    await ui.select({ key: sessionPickerKey('commands'), value: PAST_ID })
    await clock.settle()
    const rows = (await ui.findAll({ type: 'Client' })).map(client => client.key ?? '').filter(key => key.startsWith('cmd:'))
    expect(rows.sort()).toEqual(['cmd:toolu_past_1', 'cmd:toolu_past_2'])
    expect((await textsIn(ui, sessionBannerKey('commands'))).join('\n')).toContain('Outputs are not kept: an opened call shows only its first line.')
    // The call still running when the session was saved: stopped, no spinner.
    expect(await ui.find({ in: 'cmd:toolu_past_2', type: 'Text', text: '⊘' })).toBeDefined()
    expect(await ui.find({ in: 'cmd:toolu_past_2', type: 'Text', text: SPINNER })).toBeUndefined()
    // Opened: the first line its record keeps, and why that is all.
    await clickRow(ui, 'cmd:toolu_past_1')
    await clock.settle()
    expect(await ui.find({ type: 'Code', text: /12 passed in 3\.1s/ })).toBeDefined()
    expect(await ui.find({ type: 'Code', text: /keeps only the first line/ })).toBeDefined()
    await clock.advance(1_000)
    await clickRow(ui, 'cmd:toolu_past_1')

    // Its agent: stopped, nothing running now.
    await ui.press({ key: 'tab:agents' })
    expect(await ui.find({ key: sessionBannerKey('agents') })).toBeDefined()
    expect(await ui.find({ in: agentKey('ag-past'), type: 'Text', text: '⊘' })).toBeDefined()
    expect(await ui.find({ in: agentKey('ag-past'), type: 'Text', text: SPINNER })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Nothing running.' })).toBeDefined()
    await ui.press({ key: sessionBackKey('agents') })
    await clock.advance(1_000)
    await ui.unmount()
  }
})

test('past sessions: Commits shows the commits it made; a file opens its diff while git has the commit, and says so when it does not', { timeoutMs: 30_000 }, async ($, on) => {
  // git still has KEPT_SHA; LOST_SHA was rebased away.
  on('process.run', { argv: 'cat-file' }, ($, e) => ({ value: e.argv.includes(`${KEPT_SHA}^{commit}`) ? ok('') : fail() }))
  const clock = world(on)
  seedPast()
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:commits' })
    expect(await ui.find({ key: 'gitscope' })).toBeDefined()
    await ui.select({ key: sessionPickerKey('commits'), value: PAST_ID })
    await clock.settle()
    // The scope and Refresh act on this session's git: not drawn for a past one.
    expect(await ui.find({ key: 'gitscope' })).toBeUndefined()
    expect(await ui.find({ key: 'gitrefresh' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '⎇ retry' })).toBeDefined()
    const rows = (await ui.findAll({ type: 'Client' })).map(client => client.key ?? '')
    expect(rows).toContain(commitKey(KEPT_SHA))
    expect(rows).toContain(commitKey(LOST_SHA))
    expect(rows).not.toContain(commitKey(SHA))
    expect(await ui.find({ in: commitKey(KEPT_SHA), type: 'Text', text: 'feat: retry the login' })).toBeDefined()

    await clickRow(ui, commitKey(KEPT_SHA))
    expect(await ui.find({ type: 'Text', text: 'Flaky on CI.' })).toBeDefined()
    await clickRow(ui, fileKey(KEPT_SHA, 'src/app.py'))
    await clock.settle()
    const shown = await shownCode(ui)
    expect(shown.kind).not.toBe('none')
    expect(shown.text).toContain('new line')
    await ui.press({ key: 'diff:close' })
    await clock.advance(1_000)
    await clickRow(ui, commitKey(KEPT_SHA))
    await clock.advance(1_000)

    await clickRow(ui, commitKey(LOST_SHA))
    await clickRow(ui, fileKey(LOST_SHA, 'src/old.py'))
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: MISSING_COMMIT })).toBeDefined()
    await ui.press({ key: 'diff:close' })
    await clock.advance(1_000)
    await clickRow(ui, commitKey(LOST_SHA))
    await ui.press({ key: sessionBackKey('commits') })
    await clock.advance(1_000)
    await ui.unmount()
  }
})

test('past sessions: Files lists the files it touched; one opens as it is today, said so', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = world(on)
  seedPast()
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:files' })
    expect(await ui.find({ key: 'files:activity' })).toBeDefined()
    await ui.select({ key: sessionPickerKey('files'), value: PAST_ID })
    await clock.settle()
    // The folder is today's: its switch is not drawn for a past session.
    expect(await ui.find({ key: 'files:activity' })).toBeUndefined()
    const rows = (await ui.findAll({ type: 'Client' })).map(client => client.key ?? '')
    expect(rows).toContain(touchedKey('/repo/src/app.py'))
    expect(rows).toContain(touchedKey('/repo/README.md'))
    expect(rows).toContain(touchedKey('/repo/notes.md'))
    expect(rows).not.toContain(touchedKey('/outside/notes.md'))
    expect((await textsIn(ui, sessionBannerKey('files'))).join('\n')).toContain('A file opens as it is today: it may have changed since.')
    // A file it only read: its text today.
    await clickRow(ui, touchedKey('/repo/README.md'))
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: TODAY_NOTE })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'The file is empty.' })).toBeDefined()
    await ui.press({ key: 'diff:close' })
    await clock.advance(1_000)
    // What it left uncommitted, which git still sees: today's diff.
    await clickRow(ui, touchedKey('/repo/notes.md'))
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: TODAY_NOTE })).toBeDefined()
    expect((await shownCode(ui)).text).toContain('new line')
    await ui.press({ key: 'diff:close' })
    await ui.press({ key: sessionBackKey('files') })
    await clock.advance(1_000)
    await ui.unmount()
  }
})

test("past sessions: Overview's Session and Artifacts cards show a past session's usage and artifacts; its other cards stay this session's", { timeoutMs: 30_000 }, async ($, on) => {
  const opened: string[][] = []
  on('fs.exists', { path: PAST_FILE }, () => ({ value: true }))
  on('process.run', { argv: 'open' }, ($, e) => {
    opened.push([...e.argv])
    return { value: ok('') }
  })
  const clock = world(on)
  seedPast()
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const live = (await textsIn(ui, OVERVIEW_CARDS.session)).join('\n')
    expect(live).toContain('$1.23')
    expect(live).toContain('[Alerts on]')
    await ui.select({ key: sessionPickerKey('session'), value: PAST_ID })
    await clock.settle()
    const session = (await textsIn(ui, OVERVIEW_CARDS.session)).join('\n')
    expect(session).toContain('$4.56')
    expect(session).toContain('claude-sonnet-5 · 12 turns')
    expect(session).toContain('1 URLs on 1 sites')
    expect(session).toContain('Its figures as it last saved them.')
    // Charts, compact and alerts act on this session: not on a past one's card.
    expect(session).not.toContain('[Alerts on]')
    expect(session).not.toContain('[Charts in Compute]')
    // The one choice serves the Artifacts card too.
    expect((await ui.find({ key: sessionPickerKey('artifacts') }))?.props.value).toBe(PAST_ID)
    expect((await ui.findAll({ type: 'Link' })).map(link => link.props.label)).toContain('Past report')
    expect((await textsIn(ui, OVERVIEW_CARDS.artifacts)).join('\n')).toContain('report.pdf')
    await ui.press({ key: `art:${keyOf(`file:${PAST_FILE}`)}` })
    await clock.settle()
    expect(opened.at(-1)).toEqual(['open', '-R', PAST_FILE])
    // The other cards are this session's.
    expect(await ui.find({ type: 'Text', text: 'Opus 5.5' })).toBeDefined()
    // A call of this session pressed meanwhile (Most recent commands): this session again, in Commands.
    const recent = (await ui.findAll({ type: 'Client' })).map(client => client.key ?? '').find(key => key.startsWith('recent:')) ?? ''
    expect(recent).not.toBe('')
    await clickRow(ui, recent)
    await clock.settle()
    expect((await tabButton(ui, 'commands'))?.props.variant).toBe('primary')
    expect((await ui.find({ key: sessionPickerKey('commands') }))?.props.value).toBe(LIVE_SESSION)
    await clock.advance(1_000)
    await clickRow(ui, `cmd:${recent.slice('recent:'.length)}`)
    await ui.press({ key: 'tab:overview' })
    await clock.advance(1_000)
    await ui.unmount()
  }
})

/** A session the monitor kept no record of (it ran before the monitor did), as its transcript holds it. */
const T_ID = 'session-from-transcript'
const T_START = NOW - 3 * 86_400_000

const unrecorded = (): TranscriptSession => ({
  id: T_ID,
  title: 'Wire up the export',
  cwd: '/repo',
  branch: 'main',
  startedAt: T_START,
  lastAt: T_START + 120_000,
  prompts: [{ id: 'tp1', text: 'wire up the export', at: T_START }],
  calls: [
    {
      id: 'toolu_t1',
      name: 'Bash',
      input: { command: 'python export.py', description: 'Run the export' },
      startedAt: T_START + 10_000,
      endedAt: T_START + 40_000,
      isError: false,
      output: 'rows written: 42\nthe last line of the output',
      promptId: 'tp1',
    },
    { id: 'toolu_t2', name: 'Read', input: { file_path: '/repo/export.py' }, startedAt: T_START + 50_000, endedAt: T_START + 51_000, isError: true, output: 'File does not exist.', promptId: 'tp1' },
  ],
})

/** The recorded past session's transcript: a call from before its record, and its calls' whole outputs. */
const pastTranscript = (): TranscriptSession => ({
  id: PAST_ID,
  title: 'add a retry to the login test',
  cwd: '/repo',
  branch: 'retry',
  startedAt: PAST_START,
  lastAt: PAST_START + 150_000,
  prompts: [{ id: 'tp-past', text: 'add a retry to the login test', at: PAST_START + 60_000 }],
  calls: [
    { id: 'toolu_past_0', name: 'Bash', input: { command: 'git status' }, startedAt: PAST_START + 30_000, endedAt: PAST_START + 31_000, isError: false, output: 'nothing to commit', promptId: 'tp-past' },
    { id: 'toolu_past_1', name: 'Bash', input: { command: 'pytest -q' }, startedAt: PAST_START + 70_000, endedAt: PAST_START + 80_000, isError: false, output: 'collected 12 items\n12 passed in 3.1s', promptId: 'tp-past' },
  ],
})

test("past sessions: those the monitor kept no record of are listed from Claude Code's transcripts and open with their prompts, calls and outputs", { timeoutMs: 30_000 }, async ($, on) => {
  const clock = world(on)
  const { past, older } = seedPast()
  transcripts.list = [
    { id: T_ID, startedAt: T_START, lastAt: T_START + 120_000, title: 'Wire up the export', prompts: 1, calls: 2, cwd: '/repo', branch: 'main' },
    { id: PAST_ID, startedAt: PAST_START, lastAt: PAST_START + 150_000, title: 'add a retry', prompts: 1, calls: 3, cwd: '/repo', branch: 'retry' },
    { id: SESSION_ID, startedAt: NOW - 3_600_000, lastAt: NOW, title: 'fetch the data', prompts: 1, calls: 5, cwd: '/repo', branch: 'main' },
  ]
  transcripts.sessions.set(T_ID, unrecorded())
  transcripts.sessions.set(PAST_ID, pastTranscript())
  await start($, clock)
  expect(transcripts.runs).toContainEqual(['list', '/repo'])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:prompts' })
    // The records and the transcripts together, each session once, the newest first; never this one.
    expect((await ui.find({ key: sessionPickerKey('prompts') }))?.props.options).toEqual([
      { value: LIVE_SESSION, label: 'This session (live)' },
      { value: PAST_ID, label: sessionLabel(entryOf(past, 0)) },
      { value: T_ID, label: `${sessionDate(T_START)} · Wire up the export` },
      { value: older.id, label: sessionLabel(entryOf(older, 0)) },
    ])
    await ui.select({ key: sessionPickerKey('prompts'), value: T_ID })
    await clock.settle()
    expect((await ui.find({ key: sessionPickerKey('prompts') }))?.props.value).toBe(T_ID)
    expect((await textsIn(ui, promptKey('t:tp1'))).join('\n')).toContain('Wire up the export')

    // Its calls, an opened one with its output as the transcript kept it.
    await ui.press({ key: 'tab:commands' })
    const rows = (await ui.findAll({ type: 'Client' })).map(client => client.key ?? '').filter(key => key.startsWith('cmd:'))
    expect(rows.sort()).toEqual(['cmd:toolu_t1', 'cmd:toolu_t2'])
    expect((await textsIn(ui, sessionBannerKey('commands'))).join('\n')).toContain('Outputs are as Claude Code’s transcript kept them')
    await clickRow(ui, 'cmd:toolu_t1')
    await clock.settle()
    expect(await ui.find({ type: 'Code', text: /rows written: 42\nthe last line of the output/ })).toBeDefined()
    await clock.advance(1_000)
    await clickRow(ui, 'cmd:toolu_t1')

    // Overview's Session card says where its figures went.
    await ui.press({ key: 'tab:overview' })
    expect((await textsIn(ui, OVERVIEW_CARDS.session)).join('\n')).toContain('Read from Claude Code’s transcript')

    // A recorded session: its record's calls and the one its transcript adds, with whole outputs.
    await ui.press({ key: 'tab:commands' })
    await ui.select({ key: sessionPickerKey('commands'), value: PAST_ID })
    await clock.settle()
    const pastRows = (await ui.findAll({ type: 'Client' })).map(client => client.key ?? '').filter(key => key.startsWith('cmd:'))
    expect(pastRows.sort()).toEqual(['cmd:toolu_past_0', 'cmd:toolu_past_1', 'cmd:toolu_past_2'])
    await clickRow(ui, 'cmd:toolu_past_1')
    await clock.settle()
    expect(await ui.find({ type: 'Code', text: /collected 12 items\n12 passed in 3\.1s/ })).toBeDefined()
    expect(await ui.find({ type: 'Code', text: /keeps only the first line/ })).toBeUndefined()
    await clock.advance(1_000)
    await clickRow(ui, 'cmd:toolu_past_1')
    await ui.press({ key: sessionBackKey('commands') })
    await clock.advance(1_000)
    await ui.unmount()
  }
})

test("reopening: this session's earlier prompts, calls and agents come back from its record and transcript, settled, with outputs; a reload doubles nothing", { timeoutMs: 30_000 }, async ($, on) => {
  const clock = world(on)
  keep([
    record({
      id: SESSION_ID,
      startedAt: NOW - 3_600_000,
      prompts: [{ id: 'mon-p2', text: 'now deploy it', summary: 'Deploy it', isModelSummary: true, at: NOW - 1_800_000, origin: 'composer', taskId: 'turn-2' }],
      commands: [{ ...pastCall('toolu_r2', 'npm run deploy', NOW - 1_790_000, { status: 'running' }), promptId: 'turn-2' }],
      agents: [{ ...blankAgent('ag-r', 'subagent', NOW - 1_780_000), label: 'Check the deploy', status: 'running', lastActivityAt: NOW - 1_700_000 }],
    }),
  ])
  transcripts.sessions.set(SESSION_ID, {
    id: SESSION_ID,
    title: 'Build the app',
    cwd: '/repo',
    branch: 'main',
    startedAt: NOW - 3_600_000,
    lastAt: NOW - 1_700_000,
    prompts: [
      { id: 'tp1', text: 'build the app', at: NOW - 3_000_000, endedAt: NOW - 2_970_000, usage: [{ model: 'claude-opus-5-5', requests: 2, input: 10, output: 900, cacheRead: 40_000, cacheWrite: 5_000 }] },
      { id: 'tp2', text: 'now deploy it', at: NOW - 1_800_500 },
    ],
    calls: [
      { id: 'toolu_r1', name: 'Bash', input: { command: 'npm run build', description: 'Build the app' }, startedAt: NOW - 2_990_000, endedAt: NOW - 2_980_000, isError: false, output: 'built in 9.8s\ndist/app.js 120 kB', promptId: 'tp1', readBy: 'msg_r' },
      { id: 'toolu_r2', name: 'Bash', input: { command: 'npm run deploy' }, startedAt: NOW - 1_790_000, isError: false, output: '', promptId: 'tp2' },
    ],
    requests: { msg_r: { model: 'claude-opus-5-5', requests: 1, input: 5, output: 400, cacheRead: 20_000, cacheWrite: 2_500 } },
  })
  const reopen = async (): Promise<void> => {
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
  }
  await reopen()
  expect(transcripts.runs).toContainEqual(['read', '/repo', SESSION_ID])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:commands' })
  const rows = async (): Promise<string[]> => (await ui.findAll({ type: 'Client' })).map(client => client.key ?? '').filter(key => key.startsWith('cmd:')).sort()
  expect(await rows()).toEqual(['cmd:toolu_r1', 'cmd:toolu_r2'])
  // The call running when the app closed: stopped, no spinner.
  expect(await ui.find({ in: 'cmd:toolu_r2', type: 'Text', text: '⊘' })).toBeDefined()
  expect(await ui.find({ in: 'cmd:toolu_r2', type: 'Text', text: SPINNER })).toBeUndefined()
  // Its tokens from the transcript: all of the request that read it, the only output it read; none for a call no request read.
  expect(await ui.find({ in: 'cmd:toolu_r1', type: 'Text', text: '23k in · 400 out' })).toBeDefined()
  expect(await ui.find({ in: 'cmd:toolu_r2', type: 'Text', text: / out$/ })).toBeUndefined()
  // A call from before the record: its output, from the transcript.
  await clickRow(ui, 'cmd:toolu_r1')
  await clock.settle()
  expect(await ui.find({ type: 'Code', text: /dist\/app\.js 120 kB/ })).toBeDefined()
  await clock.advance(1_000)
  await clickRow(ui, 'cmd:toolu_r1')
  // The prompts: the transcript's from before the record, then the record's own (seen by both, kept once).
  await ui.press({ key: 'tab:prompts' })
  expect(await ui.find({ key: promptKey('t:tp1') })).toBeDefined()
  // Its two requests' tokens, settled: done, not running.
  const restored = (await textsIn(ui, promptKey('t:tp1'))).join('\n')
  for (const text of ['Tokens\n45k in (40k cached) · 900 out', 'Requests\n2', '✓ Done']) {
    expect(restored).toContain(text)
  }
  expect(await ui.find({ key: promptKey('mon-p2') })).toBeDefined()
  expect(await ui.find({ key: promptKey('t:tp2') })).toBeUndefined()
  // Its agent: stopped.
  await ui.press({ key: 'tab:agents' })
  expect(await ui.find({ in: agentKey('ag-r'), type: 'Text', text: '⊘' })).toBeDefined()
  // The mod reloaded with the pane holding them: nothing put back twice.
  await reopen()
  await ui.press({ key: 'tab:commands' })
  expect(await rows()).toEqual(['cmd:toolu_r1', 'cmd:toolu_r2'])
  expect(transcripts.runs.filter(one => one[0] === 'read').length).toBe(1)
  await clock.advance(1_000)
  await ui.unmount()
})

test("saving: the record is kept at each turn's end, then at most every 45 s while things change; the session is no past session of its own", { timeoutMs: 30_000 }, async ($, on) => {
  const clock = world(on)
  await start($, clock)
  const saved = readSnapshot(memoryStore.get(snapshotKey(SESSION_ID)))
  expect(saved?.title).toBe('Fetch the data')
  expect(saved?.prompts.map(one => one.summary)).toEqual(['Fetch the data'])
  expect(saved?.commands.map(one => one.tool)).toEqual(['Read', 'Write', 'WebSearch', 'WebFetch', 'Bash'])
  expect(saved?.commands.every(one => one.groups.length === 0)).toBe(true)
  expect(saved?.touched.map(one => one.path).sort()).toEqual(['/outside/notes.md', '/repo/src/app.py'])
  expect(saved?.commits.map(one => one.sha)).toEqual([SHA])
  expect(saved?.worktree.map(one => one.path)).toEqual(['src/app.py', 'notes.md'])
  expect(saved?.usage.costUsd).toBe(1.23)
  expect(saved?.sources).toEqual({ urls: 4, domains: 3, searches: 1 })
  expect(readEntries(memoryStore.get(historyKey('/repo'))).map(one => [one.id, one.title, one.usd])).toEqual([[SESSION_ID, 'Fetch the data', 1.23]])

  // A call later: not written at once, but within 45 s.
  const first = JSON.stringify(memoryStore.get(snapshotKey(SESSION_ID)))
  await call($, { tool: 'Read', file_path: '/repo/README.md' })
  await clock.settle()
  await clock.advance(30_000)
  await clock.settle()
  expect(JSON.stringify(memoryStore.get(snapshotKey(SESSION_ID)))).toBe(first)
  await clock.advance(15_000)
  await clock.settle()
  expect(readSnapshot(memoryStore.get(snapshotKey(SESSION_ID)))?.commands.at(-1)?.title).toBe('/repo/README.md')

  // The only session of the project: no picker anywhere.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const tab of ['prompts', 'commands', 'agents', 'files', 'commits'] as const) {
    await ui.press({ key: `tab:${tab}` })
    expect(await ui.find({ key: sessionPickerKey(tab) })).toBeUndefined()
  }
  await ui.press({ key: 'tab:overview' })
  expect(await ui.find({ key: sessionPickerKey('session') })).toBeUndefined()
})

test("the project's list: its newest 10 sessions kept; at a start, lines without records go and records without lines come back", { timeoutMs: 30_000 }, async ($, on) => {
  const clock = world(on)
  const olds = Array.from({ length: 10 }, (_, index) => olderRecord(`old-${index}`, NOW - (index + 2) * 86_400_000))
  const orphan = olderRecord('orphan', NOW - 86_400_000)
  // Every old one listed, old-3 without its record; the orphan's record listed nowhere; and a record that does not parse.
  keep([...olds.filter(one => one.id !== 'old-3'), orphan], olds)
  memoryStore.set(snapshotKey('junk'), 'not a record')
  await start($, clock)
  // The orphan came back, old-3's line went; this session's save then pruned the oldest past ten.
  expect(readEntries(memoryStore.get(historyKey('/repo'))).map(one => one.id)).toEqual([
    SESSION_ID,
    'orphan',
    'old-0',
    'old-1',
    'old-2',
    'old-4',
    'old-5',
    'old-6',
    'old-7',
    'old-8',
  ])
  expect(memoryStore.has(snapshotKey('old-9'))).toBe(false)
  expect(memoryStore.has(snapshotKey('junk'))).toBe(false)
  expect(memoryStore.has(snapshotKey('orphan'))).toBe(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:prompts' })
  const options = (await ui.find({ key: sessionPickerKey('prompts') }))?.props.options
  expect(Array.isArray(options) ? options.length : 0).toBe(10)
})

test('a past session whose record and transcript cannot be read is taken off the list, said so', { timeoutMs: 30_000 }, async ($, on) => {
  const toasts: string[] = []
  const clock = world(on, toasts)
  const { past } = seedPast()
  memoryStore.set(snapshotKey('broken'), { v: 99, id: 'broken' })
  memoryStore.set(historyKey('/repo'), [...readEntries(memoryStore.get(historyKey('/repo'))), { id: 'broken', startedAt: NOW - 86_400_000, lastAt: NOW - 86_400_000, title: 'Broken', prompts: 1, commands: 0, bytes: 30 }])
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:prompts' })
  await ui.select({ key: sessionPickerKey('prompts'), value: 'broken' })
  await clock.settle()
  expect(toasts.at(-1)).toBe('That session could not be read (its record and transcript are gone), so it was taken off the list.')
  expect((await ui.find({ key: sessionPickerKey('prompts') }))?.props.value).toBe(LIVE_SESSION)
  expect(readEntries(memoryStore.get(historyKey('/repo'))).map(one => one.id)).not.toContain('broken')
  expect(memoryStore.has(snapshotKey('broken'))).toBe(false)
  expect(readEntries(memoryStore.get(historyKey('/repo'))).map(one => one.id)).toContain(past.id)
})

test('the end of a session saves it; after a /clear the next record begins at the clear', { timeoutMs: 30_000 }, async ($, on) => {
  const ids = { value: SESSION_ID }
  on('session.id', {}, () => ({ value: ids.value }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  const clock = world(on)
  await start($, clock)
  await call($, { tool: 'Read', file_path: '/repo/README.md' })
  await clock.advance(1_000)
  await clock.settle()
  // Not yet saved: the end saves it.
  expect(readSnapshot(memoryStore.get(snapshotKey(SESSION_ID)))?.commands.at(-1)?.title).not.toBe('/repo/README.md')
  await $.session.end({ reason: 'clear', sessionId: SESSION_ID, resume: { id: SESSION_ID } })
  await clock.settle()
  expect(readSnapshot(memoryStore.get(snapshotKey(SESSION_ID)))?.commands.at(-1)?.title).toBe('/repo/README.md')

  // The process goes on under a new id: its record holds only what came after the clear.
  ids.value = 'session-2222'
  await clock.advance(1_000)
  await call($, { tool: 'Read', file_path: '/repo/after.md' })
  await clock.advance(45_000)
  await clock.settle()
  const next = readSnapshot(memoryStore.get(snapshotKey('session-2222')))
  expect(next?.commands.map(one => one.title)).toEqual(['/repo/after.md'])
  expect(next?.prompts).toEqual([])
  expect(readEntries(memoryStore.get(historyKey('/repo'))).map(one => one.id)).toEqual(['session-2222', SESSION_ID])
  // The cleared session is a past one now.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:commands' })
  const options = (await ui.find({ key: sessionPickerKey('commands') }))?.props.options
  expect(Array.isArray(options) ? options.map(option => (typeof option === 'object' && option !== null && 'value' in option ? option.value : '')) : []).toEqual([LIVE_SESSION, SESSION_ID])
})
