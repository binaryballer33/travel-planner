// Sources by task: each source carries the prompt or sub-agent that used it,
// and the Sources tab lists them by task.

import type { On } from 'claude-code'
import { describe, expect, test, type mock } from 'claude-code/testing'

import type { SourceRecord, TaskLabel } from '../types'
import { fmtClock } from '../hooks/lib/format'
import { extractSources, MAX_TASK_IDS, mergeSources, type ToolUse } from '../hooks/lib/sources'
import {
  addTask,
  agentLabel,
  endTask,
  MAX_TASKS,
  promptLabel,
  relabelTask,
  reopenTask,
  SESSION_TASK,
  sourcesByTask,
  taskCounts,
  taskForTurn,
  taskIdOf,
  taskReportLines,
  tasksUsingWeb,
} from '../hooks/lib/tasks'
import { SOURCES_SUMMARY_KEY } from '../hooks/view/sources'
import { taskKey } from '../hooks/view/sources-tasks'
import { call, clickRow, NOW, PANE, run, start, TASK_AGENT, TASK_PAGE, textsIn, world } from './world'

const T0 = 1_760_000_000_000

const use = (tool: string, input: Record<string, unknown>, result: unknown, extra: Partial<ToolUse> = {}): ToolUse => ({
  tool,
  input,
  result,
  text: '',
  isError: false,
  now: T0,
  durationMs: 120,
  ...extra,
})

const search = (query: string, urls: readonly string[], taskId: string, now = T0): SourceRecord[] =>
  extractSources(use('WebSearch', { query }, { results: [{ content: urls.map(url => ({ title: url, url })) }] }, { taskId, now }))

const fetch = (url: string, taskId: string, now = T0, code = 200): SourceRecord[] =>
  extractSources(use('WebFetch', { url }, { url, code, bytes: 100 }, { taskId, now }))

const prompt = (id: string, label: string, startedAt: number): TaskLabel => ({ id, kind: 'prompt', label, startedAt })

describe('attributing sources to tasks', () => {
  test('every source a call finds carries its task; a call outside any task carries none', () => {
    expect(search('q', ['https://a.com/1'], 't1').map(source => source.taskIds)).toEqual([['t1'], ['t1']])
    expect(fetch('https://a.com/2', 'agent-7')[0]?.taskIds).toEqual(['agent-7'])
    expect(extractSources(use('Bash', { command: 'curl https://z.com' }, undefined))[0]?.taskIds).toEqual([])
  })

  test('merging unions the tasks in order of first use, each once, the latest kept past the cap', () => {
    let list = mergeSources([], fetch('https://a.com/1', 't1'))
    list = mergeSources(list, fetch('https://a.com/1', 't2', T0 + 1))
    list = mergeSources(list, fetch('https://a.com/1', 't1', T0 + 2))
    expect(list[0]).toMatchObject({ count: 3, taskIds: ['t1', 't2'] })
    for (let index = 0; index < MAX_TASK_IDS + 5; index += 1) {
      list = mergeSources(list, fetch('https://a.com/1', `x${index}`, T0 + 10 + index))
    }
    const ids = list[0]?.taskIds ?? []
    expect(ids.length).toBe(MAX_TASK_IDS)
    expect(ids[ids.length - 1]).toBe(`x${MAX_TASK_IDS + 4}`)
    expect(ids).not.toContain('t1')
  })

  test('a call belongs to its sub-agent, else the running prompt, else the session', () => {
    expect(taskIdOf('agent-1', 't1')).toBe('agent-1')
    expect(taskIdOf(undefined, 't1')).toBe('t1')
    expect(taskIdOf(undefined, undefined)).toBe(SESSION_TASK)
    // A turn without typed text continues the last prompt's task.
    expect(taskForTurn('t2', 'look it up', 't1')).toBe('t2')
    expect(taskForTurn('t3', '  ', 't2')).toBe('t2')
    expect(taskForTurn('t1', '', undefined)).toBe('t1')
  })
})

describe('task labels', () => {
  test('a prompt reads as its first line, cut to fit and free of control characters', () => {
    expect(promptLabel('fetch the data\nand chart it')).toBe('fetch the data …')
    expect(promptLabel('a\u0007b')).toBe('ab')
    expect(promptLabel('x'.repeat(300)).length).toBe(160)
    expect(promptLabel('   ')).toBe('(continued without a prompt)')
  })

  test('a sub-agent reads as its type and task, or its id when neither is known', () => {
    expect(agentLabel('a1', 'find the docs', 'Explore')).toBe('Explore: find the docs')
    expect(agentLabel('a1', 'find the docs', undefined)).toBe('find the docs')
    expect(agentLabel('a1', '', 'Explore')).toBe('Explore sub-agent')
    expect(agentLabel('a1', undefined, undefined)).toBe('sub-agent a1')
  })

  test('tasks are added once, reopened, ended with their model, relabelled, and capped', () => {
    let list = addTask([], prompt('t1', 'one', T0))
    list = addTask(list, prompt('t1', 'again', T0 + 1))
    expect(list).toEqual([prompt('t1', 'one', T0)])
    list = endTask(list, 't1', T0 + 50, 'claude-opus-5-5')
    expect(list[0]).toMatchObject({ endedAt: T0 + 50, model: 'claude-opus-5-5' })
    expect(reopenTask(list, 't1')[0]?.endedAt).toBeUndefined()
    expect(relabelTask(list, 't1', 'better')[0]?.label).toBe('better')
    for (let index = 0; index < MAX_TASKS + 3; index += 1) {
      list = addTask(list, prompt(`p${index}`, 'p', T0 + index))
    }
    expect(list.length).toBe(MAX_TASKS)
    expect(list.some(task => task.id === 't1')).toBe(false)
  })
})

describe('grouping sources by task', () => {
  const tasks: TaskLabel[] = [prompt('t1', 'research options', T0), prompt('t2', 'no web here', T0 + 10), prompt('t3', 'check one page', T0 + 20)]
  let sources: SourceRecord[] = []
  sources = mergeSources(sources, search('spy options', ['https://a.com/1', 'https://b.com/2'], 't1'))
  sources = mergeSources(sources, fetch('https://a.com/1', 't1', T0 + 1))
  sources = mergeSources(sources, fetch('https://c.com/gone', 't3', T0 + 21, 404))
  sources = mergeSources(sources, fetch('https://a.com/1', 't3', T0 + 22))
  sources = mergeSources(sources, extractSources(use('Bash', { command: 'curl https://z.com/x' }, undefined, { now: T0 - 5 })))

  test('newest task first, each with its searches, URLs, sites and failures', () => {
    const groups = sourcesByTask(tasks, sources, false)
    expect(groups.map(group => group.task.id)).toEqual(['t3', 't1', SESSION_TASK])
    const [t3, t1, session] = groups
    expect(t1?.searches.map(source => source.query)).toEqual(['spy options'])
    expect(t1?.urls.map(source => source.url)).toEqual(['https://a.com/1', 'https://b.com/2'])
    expect(t1 === undefined ? null : taskCounts(t1)).toEqual({ searches: '1 search', urls: '2 URLs', sites: '2 sites', failed: undefined })
    expect(t3 === undefined ? null : taskCounts(t3)).toEqual({ searches: '0 searches', urls: '2 URLs', sites: '2 sites', failed: '1 failed' })
    // A source recorded outside any task counts for the session.
    expect(session?.task).toMatchObject({ kind: 'session', label: 'Outside any prompt', startedAt: T0 - 5 })
    expect(session?.urls.map(source => source.url)).toEqual(['https://z.com/x'])
  })

  test('tasks without sources only when asked for; a task the list dropped still shows', () => {
    expect(sourcesByTask(tasks, sources, true).map(group => group.task.id)).toEqual(['t3', 't2', 't1', SESSION_TASK])
    const dropped = sourcesByTask([], fetch('https://a.com/9', 'old', T0 + 5), false)
    expect(dropped[0]?.task).toMatchObject({ id: 'old', label: 'Task old', startedAt: T0 + 5 })
    expect(tasksUsingWeb(sources)).toBe(3)
    expect(tasksUsingWeb([])).toBe(0)
  })

  test('the report lists each task with its searches, websites and URLs', () => {
    const lines = taskReportLines(tasks, sources, T0)
    expect(lines.slice(0, 3)).toEqual(['', '### Sources by task', ''])
    expect(lines).toContain(`- **research options** (prompt, ${fmtClock(T0, T0)}): 1 search, 2 URLs, 2 sites`)
    expect(lines).toContain('  - searched “spy options”')
    expect(lines).toContain('  - a.com: https://a.com/1')
    expect(lines.some(line => line.includes('no web here'))).toBe(false)
    expect(taskReportLines(tasks, [], T0)).toEqual([])
  })
})

// --------------------------------------------------------------------------- //
// The pane
// --------------------------------------------------------------------------- //

const SECOND = TASK_PAGE
const GUIDE = 'https://docs.example.com/guide'

/** The shared world, plus an agent list that names sub-agent `a1`. */
const tasksWorld = (on: On): ReturnType<typeof mock.clock> => {
  const clock = world(on)
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'find the docs', type: 'Explore', status: 'running' as const }] }))
  return clock
}

/** The scripted session (prompt t1), then a second prompt with its own fetch, and two sub-agents. */
const twoPrompts = async ($: Parameters<typeof start>[0], clock: ReturnType<typeof mock.clock>): Promise<void> => {
  await start($, clock)
  await $.turn.start({ text: 'read the second page', turnId: 't2' })
  await clock.settle()
  await clock.advance(1_000)
  await call($, { tool: 'WebFetch', url: SECOND, prompt: 'summarize' })
  await clock.advance(1_000)
  // a1 is named only by the agent list; a2 by the Agent call that launched it.
  await call($, { tool: 'WebFetch', url: GUIDE, prompt: 'summarize', agentId: 'a1' })
  await clock.advance(1_000)
  await call($, { tool: 'Agent', description: TASK_AGENT, prompt: 'Check the guide.', subagent_type: 'general-purpose' })
  await call($, { tool: 'WebSearch', query: 'spy options', agentId: 'a2' })
  await $.turn.complete({ answer: 'done', durationMs: 3_000, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.settle()
}

const hrefs = async (ui: { findAll: (query: { type: 'Link' }) => Promise<{ props: Record<string, unknown> }[]> }): Promise<unknown[]> =>
  (await ui.findAll({ type: 'Link' })).map(link => link.props.href)

test('sources by task: each prompt and sub-agent, newest first, with counts; a click lists its links', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = tasksWorld(on)
  await twoPrompts($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:sources' })
    // The Tasks figure counts the four that used the web.
    expect((await textsIn(ui, SOURCES_SUMMARY_KEY)).join('\n')).toContain('Tasks\n4\nused the web')
    // By website lists every link; By task lists the tasks, closed.
    expect(await hrefs(ui)).toContain(SECOND)
    await ui.select({ key: 'sourceview', value: 'task' })
    await clock.settle()
    const rows = (await ui.findAll({ type: 'Client' })).flatMap(client => (client.key?.startsWith('task:') === true ? [client.key] : []))
    expect(rows).toEqual([taskKey('a2'), taskKey('a1'), taskKey('t2'), taskKey('t1')])
    expect(await hrefs(ui)).toEqual([])

    const first = taskKey('t1')
    expect(await ui.find({ in: first, type: 'Text', text: 'fetch the data' })).toBeDefined()
    expect(await ui.find({ in: first, type: 'Text', text: 'prompt' })).toBeDefined()
    expect(await ui.find({ in: first, type: 'Text', text: fmtClock(NOW, NOW) })).toBeDefined()
    expect(await ui.find({ in: first, type: 'Text', text: '1 search' })).toBeDefined()
    // Two search results, the fetched guide and the URL in the curl command, on three sites.
    expect(await ui.find({ in: first, type: 'Text', text: '4 URLs' })).toBeDefined()
    expect(await ui.find({ in: first, type: 'Text', text: '3 sites' })).toBeDefined()
    const second = taskKey('t2')
    expect(await ui.find({ in: second, type: 'Text', text: 'read the second page' })).toBeDefined()
    expect(await ui.find({ in: second, type: 'Text', text: '0 searches' })).toBeDefined()
    expect(await ui.find({ in: second, type: 'Text', text: '1 URL' })).toBeDefined()
    expect(await ui.find({ in: taskKey('a1'), type: 'Text', text: 'Explore: find the docs' })).toBeDefined()
    expect(await ui.find({ in: taskKey('a1'), type: 'Text', text: 'sub-agent' })).toBeDefined()
    expect(await ui.find({ in: taskKey('a2'), type: 'Text', text: 'general-purpose: check the guide' })).toBeDefined()

    // A click on the second prompt lists its page as a link, and only its own.
    await clickRow(ui, second)
    await clock.settle()
    expect(await hrefs(ui)).toEqual([SECOND])
    // A click on the first opens it in its place: its searches and links grouped by site.
    await clock.advance(1_000)
    await clickRow(ui, first)
    await clock.settle()
    const links = await hrefs(ui)
    expect(links).toContain(GUIDE)
    expect(links).toContain('https://learn.example.org/options')
    expect(links).toContain('https://example.com/data.zip')
    expect(links).not.toContain(SECOND)
    expect(await ui.find({ type: 'Text', text: 'spy options' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'learn.example.org' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: `prompt · started ${fmtClock(NOW, NOW)} · took 2.0s · Opus 5.5` })).toBeDefined()
    await clock.advance(1_000)
    await clickRow(ui, first)
    await clock.settle()
    expect(await hrefs(ui)).toEqual([])

    // The filter still applies: only searches leaves the tasks that searched.
    await ui.select({ key: 'sourcefilter', value: 'search' })
    await clock.settle()
    const searched = (await ui.findAll({ type: 'Client' })).flatMap(client => (client.key?.startsWith('task:') === true ? [client.key] : []))
    expect(searched).toEqual([taskKey('a2'), first])
    expect((await ui.find({ key: 'emptytasks' }))?.props.label).toBe('Show 2 tasks without sources')
    await ui.press({ key: 'emptytasks' })
    await clock.settle()
    expect((await ui.findAll({ type: 'Client' })).filter(client => client.key?.startsWith('task:') === true).length).toBe(4)
    await clock.advance(1_000)
    await ui.press({ key: 'emptytasks' })
    await ui.select({ key: 'sourcefilter', value: 'all' })
    await ui.select({ key: 'sourceview', value: 'site' })
    await clock.settle()
  }
})

test('sources by task: a title button opens a task where no Client is drawn; the report lists sources by task', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = tasksWorld(on)
  await twoPrompts($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.press({ key: 'tab:sources' })
  await ui.select({ key: 'sourceview', value: 'task' })
  await clock.settle()
  await ui.press({ key: taskKey('t2') })
  await clock.settle()
  expect(await hrefs(ui)).toEqual([SECOND])

  const report = await run($, 'monitor-report', '')
  expect(report).toContain('### Sources by task')
  expect(report).toContain('**read the second page** (prompt')
  expect(report).toContain(`  - news.example.net: ${SECOND}`)
  expect(report).toContain('**Explore: find the docs** (sub-agent')
  expect(report).toContain('**fetch the data** (prompt')
})
