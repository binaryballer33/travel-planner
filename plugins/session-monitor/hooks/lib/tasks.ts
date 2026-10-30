// Sources by task: which prompt or sub-agent used each web source.
//
// A task is a prompt the person typed (a main-loop turn; a turn that starts
// without typed text continues the prompt before it), a sub-agent (its tool
// calls carry its id), or the session itself for calls outside both.

import type { SourceRecord, TaskKind, TaskLabel } from '../../types'
import { fmtClock, oneLine } from './format'
import { byDomain } from './sources'

export const MAX_TASKS = 100
export const SESSION_TASK = 'session'
const LABEL_CHARS = 160

/** The task a tool call belongs to: its sub-agent's, else the running prompt's, else the session's. */
export const taskIdOf = (agentId: string | undefined, promptTask: string | undefined): string => agentId ?? promptTask ?? SESSION_TASK

/** The task a main-loop turn works on: a prompt starts its own, a turn without typed text continues the last one. */
export const taskForTurn = (turnId: string, text: string, previous: string | undefined): string =>
  text.trim() === '' && previous !== undefined ? previous : turnId

/** A prompt's label: its first line, cut to fit. */
export const promptLabel = (text: string): string => (text.trim() === '' ? '(continued without a prompt)' : oneLine(text.trim(), LABEL_CHARS))

/** A sub-agent's label: its type and the description of its task, or its id when neither is known. */
export const agentLabel = (agentId: string, description: string | undefined, type: string | undefined): string => {
  const what = oneLine(description?.trim() ?? '', LABEL_CHARS)
  const kind = oneLine(type?.trim() ?? '', 40)
  if (what === '' && kind === '') {
    return `sub-agent ${oneLine(agentId, 24)}`
  }
  return kind === '' ? what : what === '' ? `${kind} sub-agent` : `${kind}: ${what}`
}

/** Adds a task the list does not hold yet; the oldest drop past MAX_TASKS. */
export const addTask = (list: readonly TaskLabel[], task: TaskLabel): TaskLabel[] =>
  list.some(one => one.id === task.id) ? [...list] : [...list, task].slice(-MAX_TASKS)

/** Marks a task running again (a continuation of its prompt). */
export const reopenTask = (list: readonly TaskLabel[], id: string): TaskLabel[] =>
  list.map(one => (one.id === id ? { ...one, endedAt: undefined } : one))

/** Marks a task ended, with the model that answered last when known. */
export const endTask = (list: readonly TaskLabel[], id: string, now: number, model: string | undefined): TaskLabel[] =>
  list.map(one => (one.id === id ? { ...one, endedAt: now, model: model ?? one.model } : one))

/** Gives a task a better label (a sub-agent's, once its Agent call is known). */
export const relabelTask = (list: readonly TaskLabel[], id: string, label: string): TaskLabel[] =>
  list.map(one => (one.id === id ? { ...one, label } : one))

/** The tasks a source counts for; one recorded before tasks were kept counts for the session. */
export const taskIdsOf = (source: SourceRecord): readonly string[] => (source.taskIds.length > 0 ? source.taskIds : [SESSION_TASK])

/** How many tasks used at least one web source. */
export const tasksUsingWeb = (sources: readonly SourceRecord[]): number => new Set(sources.flatMap(source => taskIdsOf(source))).size

/** One task with the searches it ran and the pages it used, newest first. */
export type TaskSources = {
  task: TaskLabel
  searches: SourceRecord[]
  urls: SourceRecord[]
  sites: number
  failed: number
}

/** A task the sources name that the list no longer holds (dropped past the cap, or the session's own). */
const unknownTask = (id: string, startedAt: number): TaskLabel =>
  id === SESSION_TASK
    ? { id, kind: 'session', label: 'Outside any prompt', startedAt }
    : { id, kind: 'prompt', label: `Task ${oneLine(id, 24)}`, startedAt }

const newestFirst = (a: SourceRecord, b: SourceRecord): number => b.lastAt - a.lastAt

/**
 * Every task with the sources it used, the newest task first. Tasks that used
 * none are left out unless `withEmpty`.
 */
export const sourcesByTask = (tasks: readonly TaskLabel[], sources: readonly SourceRecord[], withEmpty: boolean): TaskSources[] => {
  const used = new Map<string, SourceRecord[]>()
  for (const source of sources) {
    for (const id of taskIdsOf(source)) {
      const list = used.get(id)
      if (list === undefined) {
        used.set(id, [source])
      } else {
        list.push(source)
      }
    }
  }
  const all: TaskLabel[] = [...tasks]
  const known = new Set(tasks.map(task => task.id))
  for (const [id, list] of used) {
    if (!known.has(id)) {
      all.push(unknownTask(id, Math.min(...list.map(source => source.firstAt))))
    }
  }
  return all
    .map((task, index) => {
      const list = used.get(task.id) ?? []
      const urls = list.filter(source => source.url !== undefined).sort(newestFirst)
      const entry: TaskSources = {
        task,
        searches: list.filter(source => source.kind === 'search').sort(newestFirst),
        urls,
        sites: new Set(urls.map(source => source.domain)).size,
        failed: list.filter(source => source.isError).length,
      }
      return { entry, index }
    })
    .filter(({ entry }) => withEmpty || entry.searches.length + entry.urls.length > 0)
    .sort((a, b) => b.entry.task.startedAt - a.entry.task.startedAt || b.index - a.index)
    .map(({ entry }) => entry)
}

export const KIND_WORD: Record<TaskKind, string> = { prompt: 'prompt', agent: 'sub-agent', session: 'session' }

const count = (value: number, one: string, many: string): string => `${value} ${value === 1 ? one : many}`

/** A task's figures in words: `2 searches`, `3 URLs`, `2 sites`, and `1 failed` when any did. */
export type TaskCounts = { searches: string; urls: string; sites: string; failed?: string }

export const taskCounts = (entry: TaskSources): TaskCounts => ({
  searches: count(entry.searches.length, 'search', 'searches'),
  urls: count(entry.urls.length, 'URL', 'URLs'),
  sites: count(entry.sites, 'site', 'sites'),
  failed: entry.failed > 0 ? `${entry.failed} failed` : undefined,
})

const countsText = (counts: TaskCounts): string =>
  [counts.searches, counts.urls, counts.sites, ...(counts.failed !== undefined ? [counts.failed] : [])].join(', ')

const REPORT_TASKS = 15
const REPORT_DOMAINS = 6
const REPORT_URLS = 5

/** The /monitor-report section: each task that used the web, its searches, websites and URLs (capped). */
export const taskReportLines = (tasks: readonly TaskLabel[], sources: readonly SourceRecord[], now: number): string[] => {
  const groups = sourcesByTask(tasks, sources, false)
  if (groups.length === 0) {
    return []
  }
  const lines = ['', '### Sources by task', '']
  for (const entry of groups.slice(0, REPORT_TASKS)) {
    const task = entry.task
    lines.push(`- **${oneLine(task.label, 120)}** (${KIND_WORD[task.kind]}, ${fmtClock(task.startedAt, now)}): ${countsText(taskCounts(entry))}`)
    if (entry.searches.length > 0) {
      const queries = entry.searches.slice(0, REPORT_URLS).map(search => `“${oneLine(search.query ?? '', 80)}”`)
      lines.push(`  - searched ${queries.join(', ')}${entry.searches.length > REPORT_URLS ? `, … ${entry.searches.length - REPORT_URLS} more` : ''}`)
    }
    const domains = byDomain(entry.urls)
    for (const group of domains.slice(0, REPORT_DOMAINS)) {
      const urls = group.sources.slice(0, REPORT_URLS).map(source => source.url ?? '')
      const more = group.sources.length > REPORT_URLS ? `, … ${group.sources.length - REPORT_URLS} more` : ''
      lines.push(`  - ${group.domain}: ${urls.join(', ')}${more}`)
    }
    if (domains.length > REPORT_DOMAINS) {
      lines.push(`  - … ${domains.length - REPORT_DOMAINS} more websites`)
    }
  }
  if (groups.length > REPORT_TASKS) {
    lines.push(`- … ${groups.length - REPORT_TASKS} more tasks`)
  }
  return lines
}
