// Sources: every website, page and search the session used, and the MCP
// services it called, with counts; each URL a link. The counts are a card of
// figures; the searches, the websites and the services each a card.

import type { RenderElement } from 'claude-code'

import type { SourceFilter, SourceKind, SourceRecord } from '../../types'
import { fmtAgo, fmtBytes, fmtDuration, oneLine, statusCodeTone, type Tone } from '../lib/format'
import { fitList, listShareOf } from '../lib/fit'
import { byDomain, summarizeSources } from '../lib/sources'
import { card, cardStack, figure, figureRow, notedFigure, picker, sectionCard, type Actions, type PaneData, type Ui } from './kit'
// --- sources by task ---
import type { SourceView } from '../../types'
import { tasksUsingWeb } from '../lib/tasks'
import { tasksSection, type SiteDrawing } from './sources-tasks'

const VIEW_OPTIONS: readonly { value: SourceView; label: string }[] = [
  { value: 'site', label: 'By website' },
  { value: 'task', label: 'By task' },
]
// --- end sources by task ---

/**
 * The share of the list budget (lib/fit.ts) the searches are sure of, and
 * past it what the websites leave; the websites have the rest. A research
 * session's searches and their results run to hundreds of rows, more than
 * the desktop app draws.
 */
const SEARCHES_SHARE = 0.3

/** The Sources tab's cards: its figures, the searches, the websites and the MCP services. */
export const SOURCES_SUMMARY_KEY = 'card:sources:summary'
export const SEARCHES_CARD_KEY = 'card:sources:searches'
export const WEBSITES_CARD_KEY = 'card:sources:websites'
export const SERVICES_CARD_KEY = 'card:sources:services'

/** A count and its noun, singular for one. */
const counted = (count: number, noun: string, plural = `${noun}s`): string => `${count} ${count === 1 ? noun : plural}`

const KIND_WORD: Record<SourceKind, string> = {
  fetch: 'fetched',
  search: 'search',
  result: 'search result',
  browser: 'browser',
  command: 'in a command',
  mcp: 'MCP tool',
}

const KIND_TONE: Record<SourceKind, Tone> = {
  fetch: 'success',
  search: 'claude',
  result: 'suggestion',
  browser: 'merged',
  command: 'warning',
  mcp: 'permission',
}

const matches = (source: SourceRecord, filter: SourceFilter): boolean =>
  filter === 'all' || source.kind === filter || (filter === 'search' && source.kind === 'result')

/** One search: its query, how many results, how often and when. */
const searchRow = (search: SourceRecord, data: PaneData, ui: Ui): RenderElement => {
  const { Box, Text } = ui
  return (
    <Box flexDirection="row" columnGap={data.space.gap}>
      <Text color="claude">⌕</Text>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text bold>
          {search.query ?? ''}
        </Text>
      </Box>
      <Text dimColor>
        {search.resultCount ?? 0} results{search.count > 1 ? ` · ×${search.count}` : ''}
        {search.durationMs !== undefined ? ` · ${fmtDuration(search.durationMs)}` : ''} · {fmtAgo(search.lastAt, data.now)}
      </Text>
    </Box>
  )
}

/** A website's heading over its URLs: its domain and how many URLs it has. */
const domainHeading = (domain: string, count: number, ui: Ui): RenderElement => {
  const { Text } = ui
  return (
    <Text>
      <Text bold color="suggestion">
        {domain}
      </Text>
      <Text dimColor> · {count}</Text>
    </Text>
  )
}

/** A line of a list, drawn once and weighed against the list budget. */
type Line<T> = { item: T; element: RenderElement; share: number }

const lineOf = <T,>(item: T, element: RenderElement): Line<T> => ({ item, element, share: listShareOf(element) })

const sharesOf = (lines: readonly { share: number }[]): number => lines.reduce((total, line) => total + line.share, 0)

type Site = { domain: string; sources: SourceRecord[] }

/** The websites' lines, the busiest first: each its heading, then its URLs. */
const siteLinesOf = (groups: readonly Site[], data: PaneData, ui: Ui): Line<Site>[] =>
  groups.flatMap(group => [
    lineOf(group, domainHeading(group.domain, group.sources.length, ui)),
    ...group.sources.map(source => lineOf(group, urlRow(source, data, ui))),
  ])

/**
 * The websites' lines (siteLinesOf): as many as fit in `share` of the list
 * budget, in order; the first line that does not fit ends the list, and
 * what was left is counted.
 */
const siteList = (groups: readonly Site[], lines: readonly Line<Site>[], ui: Ui, share: number): RenderElement[] => {
  const { Box, Text } = ui
  const kept = fitList(lines, line => line.share, () => false, share)
  const shown = groups.flatMap(group => {
    // Its heading, then its URLs that fit; a heading whose URLs all fell past the budget is not drawn either.
    const own = kept.filter(line => line.item === group)
    return own.length > 1 ? [{ group, own }] : []
  })
  const left = groups.filter(group => !shown.some(site => site.group === group))
  const leftUrls = left.reduce((total, group) => total + group.sources.length, 0)
  return [
    ...shown.map(({ group, own }) => (
      <Box flexDirection="column">
        {own.map(line => line.element)}
        {own.length - 1 < group.sources.length && <Text dimColor>… {group.sources.length - (own.length - 1)} more</Text>}
      </Box>
    )),
    ...(left.length > 0
      ? [
          <Text dimColor>
            … {counted(left.length, 'more website')} ({counted(leftUrls, 'URL')}) not drawn: Show above narrows the list
          </Text>,
        ]
      : []),
  ]
}

/** Websites as By task draws an open task's (sources-tasks.tsx): their lines, weighed, and those that fit a share. */
const siteDrawing = (groups: readonly Site[], data: PaneData, ui: Ui): SiteDrawing => {
  const lines = siteLinesOf(groups, data, ui)
  return { share: sharesOf(lines), fit: share => siteList(groups, lines, ui, share) }
}

const urlRow = (source: SourceRecord, data: PaneData, ui: Ui): RenderElement => {
  const { Box, Text, Link } = ui
  const url = source.url ?? ''
  return (
    <Box flexDirection="row" columnGap={data.space.gap}>
      <Box width={5} flexShrink={0}>
        <Text color={source.isError ? 'error' : statusCodeTone(source.status)} bold>
          {source.status !== undefined ? String(source.status) : source.isError ? '✗' : '·'}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0} flexDirection="column">
        <Link href={url} label={oneLine(url, 160)} />
        {source.title !== undefined && <Text dimColor>{oneLine(source.title, 140)}</Text>}
      </Box>
      <Box flexShrink={0}>
        <Text>
          <Text color={KIND_TONE[source.kind]}>{KIND_WORD[source.kind]}</Text>
          <Text dimColor>
            {source.count > 1 ? ` ×${source.count}` : ''}
            {source.bytes !== undefined ? ` · ${fmtBytes(source.bytes)}` : ''}
            {source.durationMs !== undefined ? ` · ${fmtDuration(source.durationMs)}` : ''} · {fmtAgo(source.lastAt, data.now)}
          </Text>
        </Text>
      </Box>
    </Box>
  )
}

export const sourcesTab = (data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Text, Button } = ui
  const filter = data.ui.sourceFilter
  const summary = summarizeSources(data.sources)
  const searches = data.sources.filter(source => source.kind === 'search').sort((a, b) => b.lastAt - a.lastAt)
  const visible = data.sources.filter(source => source.url !== undefined && matches(source, filter))
  const groups = byDomain(visible)
  const used = data.services
  const allUrls = data.sources.flatMap(source => (source.url !== undefined ? [source.url] : []))
  const options: { value: SourceFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'fetch', label: 'Fetched pages' },
    { value: 'search', label: 'Searches & results' },
    { value: 'browser', label: 'Browser' },
    { value: 'command', label: 'In commands' },
    { value: 'mcp', label: 'MCP tools' },
  ]
  // --- sources by task ---
  const view = data.ui.sourceView
  const isByTask = view === 'task'
  const taskCount = tasksUsingWeb(data.sources)
  // --- end sources by task ---
  const figures = [
    notedFigure(ui, data, 'URLs', String(summary.urls), `on ${counted(summary.domains, 'website')}`, 'suggestion'),
    figure(ui, data, 'Searches', String(summary.searches), 'claude'),
    notedFigure(ui, data, 'Pages opened', String(summary.fetched), fmtBytes(summary.fetchedBytes), 'success'),
    ...(summary.errors > 0 ? [figure(ui, data, 'Failed', String(summary.errors), 'error')] : []),
    // --- sources by task ---
    ...(taskCount > 0 ? [notedFigure(ui, data, 'Tasks', String(taskCount), 'used the web', 'merged')] : []),
    // --- end sources by task ---
    ...(used.length > 0 ? [figure(ui, data, 'MCP services', String(used.length), 'permission')] : []),
  ]
  // The searches and the websites share the list budget: the searches up to their share or what the websites leave, the larger; the websites what is left.
  const isSearching = searches.length > 0 && (filter === 'all' || filter === 'search')
  const siteLines = groups.length === 0 ? [] : siteLinesOf(groups, data, ui)
  const searchShare = Math.max(SEARCHES_SHARE, 1 - sharesOf(siteLines))
  const searchLines = isSearching ? fitList(searches.map(search => lineOf(search, searchRow(search, data, ui))), line => line.share, () => false, searchShare) : []
  const bySite: RenderElement[] = [
    ...(isSearching
      ? [
          sectionCard(
            ui,
            data,
            SEARCHES_CARD_KEY,
            'Searches',
            `${counted(searches.length, 'search', 'searches')}, the latest first`,
            [
              ...searchLines.map(line => line.element),
              ...(searchLines.length < searches.length ? [<Text dimColor>… {counted(searches.length - searchLines.length, 'older search', 'older searches')} not drawn</Text>] : []),
            ],
          ),
        ]
      : []),
    sectionCard(
      ui,
      data,
      WEBSITES_CARD_KEY,
      'Websites',
      groups.length === 0 ? '' : `${counted(groups.length, 'website')}, the busiest first`,
      groups.length === 0
        ? [<Text dimColor>{data.sources.length === 0 ? 'No web sources yet. Pages, searches and URLs appear here as Claude uses them.' : 'Nothing matches.'}</Text>]
        : siteList(groups, siteLines, ui, 1 - sharesOf(searchLines)),
    ),
  ]
  return cardStack(ui, data, [
    <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap} rowGap={data.space.row} alignItems="center">
      {/* --- sources by task --- */}
      {picker(ui, 'sourceview', 'View', view, VIEW_OPTIONS, value => act.setSourceView(value))}
      {/* --- end sources by task --- */}
      {picker(ui, 'sourcefilter', 'Show', filter, options, value => act.setSourceFilter(value))}
      {allUrls.length > 0 && <Button key="copyurls" label={`Copy all ${allUrls.length} URLs`} onPress={press => act.copy(allUrls.join('\n'), press)} />}
    </Box>,
    card(ui, data, SOURCES_SUMMARY_KEY, [figureRow(ui, data, figures)]),
    // --- sources by task ---
    ...(isByTask ? [tasksSection(data, ui, act, { sites: groups => siteDrawing(groups, data, ui), isShown: source => matches(source, filter) })] : bySite),
    // --- end sources by task ---
    ...(used.length > 0
      ? [
          sectionCard(
            ui,
            data,
            SERVICES_CARD_KEY,
            'MCP services',
            `${counted(used.length, 'server')} called`,
            used.map(service => (
              <Box flexDirection="row" columnGap={data.space.gap}>
                <Box width={24} flexShrink={0}>
                  <Text color="permission" bold>
                    {service.server}
                  </Text>
                </Box>
                <Text>{service.calls} calls</Text>
                <Text dimColor>{fmtDuration(service.totalMs)} total</Text>
                {service.errors > 0 && <Text color="error">✗ {service.errors}</Text>}
                <Text dimColor>{fmtAgo(service.lastAt, data.now)}</Text>
              </Box>
            )),
          ),
        ]
      : []),
  ])
}
