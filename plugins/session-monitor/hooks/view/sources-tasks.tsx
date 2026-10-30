// Sources by task: each prompt and sub-agent with the searches it ran and the
// pages it used, the newest first, in one card. Opened, a task lists its
// searches and its URLs as links, grouped by website, in a card of its own,
// as many as fit in PANEL_SHARE of the list budget (lib/fit.ts).

import type { RenderElement } from 'claude-code'

import type { SourceRecord, TaskKind } from '../../types'
import { fmtClock, fmtDuration, keyOf, oneLine, shortModel, type Tone } from '../lib/format'
import { fitList, listShareOf } from '../lib/fit'
import { byDomain } from '../lib/sources'
import { KIND_WORD, sourcesByTask, taskCounts, type TaskSources } from '../lib/tasks'
import { rowDetailCard, rowLine, sectionCard, seg, titleSeg, type Actions, type PaneData, type Ui } from './kit'
import type { RowSegment } from './row'

const MAX_TASK_ROWS = 100

/** What of the list budget an open task's searches and websites may take; the other tasks' rows fit in the rest. */
const PANEL_SHARE = 0.7

/** Of that, the least its searches get, or what its websites leave, the larger: as By website shares them. */
const PANEL_SEARCHES_SHARE = 0.3

const KIND_TONE: Record<TaskKind, Tone> = { prompt: 'claude', agent: 'merged', session: 'subtle' }

/** A task row's key: short, stable, free of control characters. */
export const taskKey = (id: string): string => `task:${keyOf(id)}`

/** The By task view's card. */
export const TASKS_CARD_KEY = 'card:sources:tasks'

/** An opened task's card. */
export const taskCardKey = (id: string): string => `card:${taskKey(id)}`

/** A website and its URLs, the busiest first (lib/sources.ts byDomain). */
export type SiteGroup = { domain: string; sources: SourceRecord[] }

/** Websites as By website draws them: what all their lines take of the list budget, and those that fit in a share of it, what was left counted. */
export type SiteDrawing = { share: number; fit: (share: number) => RenderElement[] }

/** What the Sources tab lends this view: how it draws websites and their URLs, and which sources its filter shows. */
export type SourceDrawing = {
  sites: (groups: readonly SiteGroup[]) => SiteDrawing
  isShown: (source: SourceRecord) => boolean
}

const taskSegments = (entry: TaskSources, data: PaneData, isOpen: boolean): RowSegment[] => {
  const task = entry.task
  const counts = taskCounts(entry)
  return [
    seg(KIND_WORD[task.kind], { color: KIND_TONE[task.kind], bold: true, width: 9 }),
    titleSeg(task.label, isOpen),
    seg(fmtClock(task.startedAt, data.now), { dim: true }),
    seg(counts.searches, { color: entry.searches.length > 0 ? 'claude' : 'subtle' }),
    seg(counts.urls, { color: entry.urls.length > 0 ? 'suggestion' : 'subtle' }),
    seg(counts.sites, { dim: true }),
    ...(counts.failed !== undefined ? [seg(counts.failed, { color: 'error' })] : []),
  ]
}

/** An open task: its searches, the latest first, then its URLs grouped by website, the busiest first, as many as fit in PANEL_SHARE of the list budget. */
const taskPanel = (entry: TaskSources, data: PaneData, ui: Ui, draw: SourceDrawing): RenderElement => {
  const { Box, Text } = ui
  const task = entry.task
  const sites = draw.sites(byDomain(entry.urls))
  // The latest first (lib/tasks.ts): those past the share are the oldest.
  const searchLines = entry.searches.map(search => {
    const element = (
      <Box flexDirection="row" columnGap={data.space.gap}>
        <Text color="claude">⌕</Text>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text bold>{oneLine(search.query ?? '', 200)}</Text>
        </Box>
        <Text dimColor>{search.resultCount ?? 0} results</Text>
      </Box>
    )
    return { element, share: listShareOf(element) }
  })
  const searches = fitList(searchLines, line => line.share, () => false, Math.max(PANEL_SHARE * PANEL_SEARCHES_SHARE, PANEL_SHARE - sites.share))
  const searchShare = searches.reduce((total, line) => total + line.share, 0)
  const unsearched = entry.searches.length - searches.length
  return rowDetailCard(ui, data, taskCardKey(task.id), [
    <Box flexDirection="column" rowGap={0}>
      <Text dimColor>
        {KIND_WORD[task.kind]} · started {fmtClock(task.startedAt, data.now)}
        {task.endedAt !== undefined ? ` · took ${fmtDuration(task.endedAt - task.startedAt)}` : ' · still running'}
        {task.model !== undefined ? ` · ${oneLine(shortModel(task.model), 40)}` : ''}
      </Text>
      {searches.map(line => line.element)}
      {unsearched > 0 && <Text dimColor>{`… ${unsearched} older ${unsearched === 1 ? 'search' : 'searches'} not drawn`}</Text>}
      {entry.urls.length > 0 && (
        <Box flexDirection="column" marginTop={1} rowGap={1}>
          {sites.fit(PANEL_SHARE - searchShare)}
        </Box>
      )}
      {entry.searches.length + entry.urls.length === 0 && <Text dimColor>No web sources in this task.</Text>}
    </Box>,
  ])
}

/** The By task view of the Sources tab: one clickable row per task, the newest first. */
export const tasksSection = (data: PaneData, ui: Ui, act: Actions, draw: SourceDrawing): RenderElement => {
  const { Box, Text, Button } = ui
  const shown = data.sources.filter(source => draw.isShown(source))
  const all = sourcesByTask(data.tasks, shown, true)
  const withSources = all.filter(entry => entry.searches.length + entry.urls.length > 0)
  const withoutCount = all.length - withSources.length
  const listed = data.ui.showEmptyTasks ? all : withSources
  const lines = listed.slice(0, MAX_TASK_ROWS).map(entry => {
    const id = entry.task.id
    const isOpen = data.ui.openTask === id
    const element = (
      <Box flexDirection="column">
        {rowLine(ui, data, taskKey(id), { kind: 'task', id, path: '' }, taskSegments(entry, data, isOpen), () => act.toggleTask(id), isOpen)}
        {isOpen && taskPanel(entry, data, ui, draw)}
      </Box>
    )
    return { isOpen, element, share: listShareOf(element) }
  })
  // As many rows as fit in the list budget (lib/fit.ts), the open one's always: where a row is plain
  // elements (VS Code, mobile) some 80 of them pass what the app draws, and the notice drawn in place
  // of the tab would hide the View picker and the switch that could narrow the list.
  const rows = fitList(lines, line => line.share, line => line.isOpen, 1)
  return sectionCard(ui, data, TASKS_CARD_KEY, 'Tasks', `${withSources.length} used the web · newest first`, [
    listed.length === 0 ? (
      <Text dimColor>
        {data.sources.length === 0 ? 'No web sources yet. Each prompt and sub-agent appears here with the searches and pages it used.' : 'Nothing matches.'}
      </Text>
    ) : (
      <Box flexDirection="column" rowGap={data.space.row}>
        {rows.map(line => line.element)}
        {rows.length < listed.length && <Text dimColor>{`… ${listed.length - rows.length} more tasks not drawn`}</Text>}
      </Box>
    ),
    ...(withoutCount > 0
      ? [
          <Box flexDirection="row">
            <Button
              key="emptytasks"
              label={data.ui.showEmptyTasks ? 'Hide tasks without sources' : `Show ${withoutCount} ${withoutCount === 1 ? 'task' : 'tasks'} without sources`}
              onPress={() => act.toggleEmptyTasks()}
            />
          </Box>,
        ]
      : []),
  ])
}
