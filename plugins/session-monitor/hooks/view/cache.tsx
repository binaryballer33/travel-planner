// Cache: what Claude's API keeps of the session's prompt between requests
// (lib/cache.ts), as cards: the main loop's cache (how big, kept how long,
// when it expires, what it cost and saved), what is in it, its latest
// requests' reads and writes, and each agent's own cache.

import type { RenderElement } from 'claude-code'

import type { CacheAgent, CacheItem, CacheKinds, CacheLoop, CacheRequest } from '../../types'
import { cacheFigures, cachedOf, isRewrite, TTL_1H_MS, writtenOf, type CacheFigures } from '../lib/cache'
import { fitList, listShareOf } from '../lib/fit'
import { fmtClock, fmtDuration, fmtPct, fmtTokens, fmtUsd, meter, oneLine, shortModel, type Tone } from '../lib/format'
import { estimateTokens } from '../lib/spend'
import { cardStack, figure, figureRow, sectionCard, type Actions, type PaneData, type Ui } from './kit'

export const CACHE_MAIN_KEY = 'cache:main'
export const CACHE_WHAT_KEY = 'cache:what'
export const CACHE_REQUESTS_KEY = 'cache:requests'
export const CACHE_AGENTS_KEY = 'cache:agents'
export const CACHE_REFRESH_KEY = 'cache:refresh'

/** What of the list budget each list may take: the requests, the biggest items, the agents. */
const REQUESTS_SHARE = 0.3
const ITEMS_SHARE = 0.2
const AGENTS_SHARE = 0.3

/** `1 hour` or `5 minutes`. */
const ttlText = (ttlMs: number): string => (ttlMs === TTL_1H_MS ? '1 hour' : '5 minutes')

/** When a cache expires, from now: in how long (amber in its last stretch), or how long ago (red). */
export const expiryOf = (expiresAt: number, ttlMs: number, now: number): { text: string; tone: Tone; isExpired: boolean } => {
  const left = expiresAt - now
  if (left <= 0) {
    return { text: `expired ${fmtDuration(-left)} ago`, tone: 'error', isExpired: true }
  }
  return { text: `in ${fmtDuration(left)}`, tone: left < Math.min(5 * 60_000, ttlMs / 5) ? 'warning' : 'success', isExpired: false }
}

/** The main loop's cache as figures: how big, kept how long, when it was used and expires, what the next request pays, and what it all cost and saved. */
const mainCard = (loop: CacheLoop, figures: CacheFigures, data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Text, Button } = ui
  const expiry = expiryOf(figures.expiresAt, figures.ttlMs, data.now)
  return sectionCard(
    ui,
    data,
    CACHE_MAIN_KEY,
    'Prompt cache',
    'this session',
    [
      figureRow(ui, data, [
        figure(ui, data, 'Cached now', `${fmtTokens(figures.cached)} tokens`, 'suggestion'),
        figure(ui, data, 'Kept for', `${ttlText(figures.ttlMs)} after each use`),
        figure(ui, data, 'Last used', `${fmtClock(figures.lastAt, data.now)} (${fmtDuration(Math.max(0, data.now - figures.lastAt))} ago)`),
        figure(ui, data, 'Expires', expiry.text, expiry.tone),
        expiry.isExpired
          ? figure(ui, data, 'Next request writes it again', `≈ ${fmtUsd(figures.rewriteUsd)}`, 'warning')
          : figure(ui, data, 'Next request reads it', `≈ ${fmtUsd(figures.nextReadUsd)}`, 'success'),
        figure(ui, data, 'Hit rate', `${fmtPct(figures.hitPct)} read from it`, figures.hitPct >= 90 ? 'success' : figures.hitPct >= 60 ? 'warning' : 'error'),
        figure(ui, data, 'Saved', `≈ ${fmtUsd(figures.savedUsd)}`, 'success'),
        figure(ui, data, 'Read', `${fmtTokens(figures.read)} tokens · ≈ ${fmtUsd(figures.readUsd)}`),
        figure(ui, data, 'Written', `${fmtTokens(figures.written)} tokens · ≈ ${fmtUsd(figures.writeUsd)}`, 'warning'),
        figure(ui, data, 'Requests', `${figures.requests}${figures.rewrites > 0 ? ` · ${figures.rewrites} wrote it again` : ''}`),
        figure(ui, data, 'Compacted', loop.resets.length === 0 ? 'never' : `${loop.resets.length} time${loop.resets.length === 1 ? '' : 's'} · last ${fmtClock(loop.resets.at(-1) ?? 0, data.now)}`),
      ]),
      <Text dimColor>
        Each request sends the whole conversation; the cache serves the part sent before at a tenth of the input price, and every read keeps it {ttlText(figures.ttlMs)} more.
        {figures.ttlMs === TTL_1H_MS ? ' Writing it kept an hour costs twice the input price.' : ' Writing it costs 1.25 times the input price.'} Past expiry, the next request writes it all again.
      </Text>,
    ],
    { action: <Button key={CACHE_REFRESH_KEY} label="Refresh" dimColor onPress={() => act.refreshCache()} /> },
  )
}

const KIND_ROWS: readonly { key: keyof CacheKinds; name: string; tone: Tone }[] = [
  { key: 'results', name: 'Tool outputs', tone: 'suggestion' },
  { key: 'inputs', name: 'Calls Claude wrote', tone: 'claude' },
  { key: 'summaries', name: 'Compaction summary', tone: 'merged' },
  { key: 'replies', name: 'Claude’s replies', tone: 'success' },
  { key: 'prompts', name: 'Your prompts', tone: 'warning' },
]

const ITEM_WORDS: Readonly<Record<CacheItem['kind'], string>> = { result: 'output', input: 'call', prompt: 'prompt', summary: 'summary' }

/**
 * What the cached prompt holds since it began (the session's start or its
 * last compaction): what it began with, then what it took in, by kind and
 * its biggest items, sized by their characters.
 */
const whatCard = (loop: CacheLoop, figures: CacheFigures, data: PaneData, ui: Ui): RenderElement => {
  const { Box, Text } = ui
  const added = Math.max(0, figures.cached - loop.startTokens)
  const visible = KIND_ROWS.reduce((total, row) => total + loop.kinds[row.key], 0)
  const items = loop.items.map(item => {
    const tokens = estimateTokens(item.chars)
    const element = (
      <Box flexDirection="row" columnGap={data.space.gap}>
        <Box width={8} flexShrink={0}>
          <Text dimColor>{ITEM_WORDS[item.kind]}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text>
            {item.tool !== '' && <Text color="suggestion">{item.tool} </Text>}
            {oneLine(item.title, 120)}
          </Text>
        </Box>
        <Text bold>≈ {fmtTokens(tokens)}</Text>
        <Text dimColor>{figures.cached > 0 ? fmtPct((tokens / figures.cached) * 100) : ''}</Text>
      </Box>
    )
    return { element, share: listShareOf(element) }
  })
  const shown = fitList(items, item => item.share, () => false, ITEMS_SHARE)
  return sectionCard(ui, data, CACHE_WHAT_KEY, 'What is in it', loop.resets.length > 0 ? `since it was compacted at ${fmtClock(loop.startedAt, data.now)}` : `since ${fmtClock(loop.startedAt, data.now)}`, [
    <Text>
      It began at <Text bold>≈ {fmtTokens(loop.startTokens)} tokens</Text>
      <Text dimColor> (the system prompt, the tools and {loop.resets.length > 0 ? 'the compaction’s summary' : 'the first message'})</Text>, and has taken in
      <Text bold> ≈ {fmtTokens(added)}</Text> since. By their text:
    </Text>,
    <Box flexDirection="column">
      {KIND_ROWS.map(row => {
        const chars = loop.kinds[row.key]
        return (
          <Box flexDirection="row" columnGap={data.space.gap}>
            <Box width={20} flexShrink={0}>
              <Text>{row.name}</Text>
            </Box>
            <Text color={row.tone}>{meter(visible > 0 ? chars / visible : 0, 12)}</Text>
            <Text bold>≈ {fmtTokens(estimateTokens(chars))}</Text>
            <Text dimColor>{visible > 0 ? fmtPct((chars / visible) * 100) : ''}</Text>
          </Box>
        )
      })}
    </Box>,
    <Text dimColor>
      Counted from the text the transcript keeps, about 3.5 characters a token; Claude’s thinking and what Claude Code adds are in the measured figure but not here.
    </Text>,
    ...(shown.length > 0
      ? [
          <Text bold>Its biggest items</Text>,
          <Box flexDirection="column">{shown.map(item => item.element)}</Box>,
          ...(shown.length < items.length ? [<Text dimColor>{`… ${items.length - shown.length} more not drawn`}</Text>] : []),
        ]
      : []),
  ])
}

/** A request's line: when, which model, what it read, what it wrote (for how long), what was new, what it wrote back; a rewrite flagged. */
const requestRow = (request: CacheRequest, data: PaneData, ui: Ui): RenderElement => {
  const { Box, Text } = ui
  const written = writtenOf(request)
  const isAgain = isRewrite(request)
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap}>
      <Text dimColor>{fmtClock(request.at, data.now)}</Text>
      <Text dimColor>{shortModel(request.model)}</Text>
      <Text color="success">read {fmtTokens(request.read)}</Text>
      <Text color={isAgain ? 'warning' : undefined} bold={isAgain}>
        wrote {fmtTokens(written)}
        {written > 0 ? (request.write1h >= request.write5m ? ' (1h)' : ' (5m)') : ''}
      </Text>
      <Text dimColor>new {fmtTokens(request.input)}</Text>
      <Text dimColor>out {fmtTokens(request.output)}</Text>
      {isAgain && <Text color="warning">wrote it again</Text>}
    </Box>
  )
}

/** The main loop's latest requests, the newest first, as many as fit. */
const requestsCard = (loop: CacheLoop, data: PaneData, ui: Ui): RenderElement => {
  const { Box, Text } = ui
  const rows = [...loop.requests].reverse().map(request => {
    const element = requestRow(request, data, ui)
    return { element, share: listShareOf(element) }
  })
  const shown = fitList(rows, row => row.share, () => false, REQUESTS_SHARE)
  return sectionCard(ui, data, CACHE_REQUESTS_KEY, 'Requests', `the latest ${shown.length}, the newest first`, [
    <Box flexDirection="column">{shown.map(row => row.element)}</Box>,
    <Text dimColor>Read: served from the cache. Wrote: added to it. New: sent uncached. A request that wrote most of its prompt again found the cache expired or its prompt changed.</Text>,
  ])
}

/** Each agent's own cache: its last request's, kept 5 minutes (an hour when it asked), with its requests summed; the most recently at work first. */
const agentsCard = (agents: readonly CacheAgent[], data: PaneData, ui: Ui): RenderElement => {
  const { Box, Text } = ui
  const rows = agents.map(agent => {
    const figures = cacheFigures([agent.last], agent.totals)
    const known = data.agents.find(one => one.id === agent.id)
    const name = known !== undefined && known.label !== '' ? known.label : agent.label !== '' ? agent.label : agent.id
    const expiry = figures === undefined ? undefined : expiryOf(figures.expiresAt, figures.ttlMs, data.now)
    const element = (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={data.space.gap}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text bold>{oneLine(name, 120)}</Text>
          </Box>
          <Text dimColor>{oneLine(agent.type === '' ? 'agent' : agent.type, 24)}</Text>
        </Box>
        {figures !== undefined && expiry !== undefined && (
          <Text>
            <Text color="suggestion">{fmtTokens(cachedOf(agent.last))} cached</Text>
            <Text dimColor> · kept {ttlText(figures.ttlMs)} · </Text>
            <Text color={expiry.tone}>{expiry.text}</Text>
            <Text dimColor>
              {' '}
              · {agent.requests} requests · {fmtPct(figures.hitPct)} read · ≈ {fmtUsd(figures.readUsd + figures.writeUsd)}
            </Text>
          </Text>
        )}
      </Box>
    )
    return { element, share: listShareOf(element) }
  })
  const shown = fitList(rows, row => row.share, () => false, AGENTS_SHARE)
  return sectionCard(ui, data, CACHE_AGENTS_KEY, 'Agents’ caches', agents.length === 0 ? 'none yet' : `${agents.length}, the most recently at work first`, [
    ...(agents.length === 0
      ? [<Text dimColor>Each agent keeps a cache of its own prompt, kept 5 minutes; they show here once an agent has made a request.</Text>]
      : [<Box flexDirection="column" rowGap={data.space.row}>{shown.map(row => row.element)}</Box>]),
    ...(shown.length < rows.length ? [<Text dimColor>{`… ${rows.length - shown.length} more not drawn`}</Text>] : []),
  ])
}

export const cacheTab = (data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Text } = ui
  const view = data.cache
  const loop = view?.main ?? null
  const figures = loop === null ? undefined : cacheFigures(loop.requests, loop.totals, loop.rewrites)
  if (view === null || loop === null || figures === undefined) {
    const note =
      view?.state === 'failed'
        ? 'The session’s transcript could not be read.'
        : view?.state === 'done'
          ? 'No model request yet: the cache fills with the first.'
          : 'Reading the session’s transcript…'
    return cardStack(ui, data, [<Text dimColor>{note}</Text>])
  }
  return cardStack(ui, data, [
    mainCard(loop, figures, data, ui, act),
    whatCard(loop, figures, data, ui),
    requestsCard(loop, data, ui),
    agentsCard(view.agents, data, ui),
    <Text dimColor>{`Read from the transcripts at ${fmtClock(view.readAt, data.now)}; again every 30 s while this tab is open.`}</Text>,
  ])
}
