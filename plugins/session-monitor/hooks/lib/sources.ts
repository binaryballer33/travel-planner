// Sources: every web address and search a session used, from its tool calls.
//
// WebFetch and WebSearch report what they fetched and found in their results;
// browser tools name the page they navigate to; a shell command or another MCP
// tool is read for the URLs written in its input.

import type { ServiceUse, SourceKind, SourceRecord } from '../../types'

export const MAX_SOURCES = 600
// --- sources by task ---
/** How many tasks one source remembers; past it the oldest drop. */
export const MAX_TASK_IDS = 20
// --- end sources by task ---

const URL_PATTERN = /https?:\/\/[^\s'"`<>()[\]{}|\\^]+/g

type Json = Readonly<Record<string, unknown>>

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** The URLs written in a text, trailing punctuation dropped, each once. */
export const findUrls = (text: string): string[] => {
  const found = new Set<string>()
  for (const match of text.matchAll(URL_PATTERN)) {
    found.add(match[0].replace(/[.,;:!?'"]+$/, ''))
  }
  return [...found]
}

/** The host a URL names, without a leading `www.`. */
export const domainOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || url
  } catch {
    return '(not a URL)'
  }
}

export type ToolUse = {
  tool: string
  input: Json
  /** The tool's structured result, as the engine recorded it. */
  result: unknown
  text: string
  isError: boolean
  now: number
  durationMs: number
  // --- sources by task ---
  /** The task the call belongs to (lib/tasks.ts); its sources carry it. */
  taskId?: string
  // --- end sources by task ---
}

const record = (
  use: ToolUse,
  kind: SourceKind,
  fields: Partial<SourceRecord> & { id: string },
): SourceRecord => ({
  kind,
  domain: fields.url !== undefined ? domainOf(fields.url) : '',
  tool: use.tool,
  count: 1,
  firstAt: use.now,
  lastAt: use.now,
  isError: false,
  // --- sources by task ---
  taskIds: use.taskId !== undefined ? [use.taskId] : [],
  // --- end sources by task ---
  ...fields,
})

const navigations = (input: Json): string[] => {
  const urls: string[] = []
  const url = str(input.url)
  if (url !== undefined && /^https?:/.test(url)) {
    urls.push(url)
  }
  const actions = input.actions
  if (Array.isArray(actions)) {
    for (const action of actions) {
      if (isRecord(action) && action.name === 'navigate' && isRecord(action.input)) {
        const nested = str(action.input.url)
        if (nested !== undefined && /^https?:/.test(nested)) {
          urls.push(nested)
        }
      }
    }
  }
  return urls
}

/** The sources one finished tool call used. */
export const extractSources = (use: ToolUse): SourceRecord[] => {
  const { tool, input, result } = use
  if (tool === 'WebFetch') {
    const asked = str(input.url)
    const details = isRecord(result) ? result : {}
    const url = str(details.url) ?? asked
    if (url === undefined) {
      return []
    }
    const status = num(details.code)
    return [
      record(use, 'fetch', {
        id: url,
        url,
        status,
        bytes: num(details.bytes),
        durationMs: num(details.durationMs) ?? use.durationMs,
        isError: use.isError || (status !== undefined && status >= 400),
      }),
    ]
  }
  if (tool === 'WebSearch') {
    const query = str(input.query) ?? ''
    const hits: { url: string; title?: string }[] = []
    const details = isRecord(result) ? result : {}
    if (Array.isArray(details.results)) {
      for (const block of details.results) {
        if (isRecord(block) && Array.isArray(block.content)) {
          for (const hit of block.content) {
            const url = isRecord(hit) ? str(hit.url) : undefined
            if (url !== undefined) {
              hits.push({ url, title: isRecord(hit) ? str(hit.title) : undefined })
            }
          }
        }
      }
    }
    if (hits.length === 0) {
      hits.push(...findUrls(use.text).map(url => ({ url })))
    }
    const seconds = num(details.durationSeconds)
    return [
      record(use, 'search', {
        id: `search:${query}`,
        query,
        domain: 'web search',
        resultCount: hits.length,
        durationMs: seconds !== undefined ? seconds * 1000 : use.durationMs,
        isError: use.isError,
      }),
      ...hits.map(hit => record(use, 'result', { id: hit.url, url: hit.url, title: hit.title, via: query })),
    ]
  }
  if (/__(navigate|preview_start|browser_batch)$/.test(tool)) {
    return navigations(input).map(url => record(use, 'browser', { id: url, url, isError: use.isError }))
  }
  if (tool === 'Bash') {
    const command = str(input.command) ?? ''
    return findUrls(command).map(url => record(use, 'command', { id: url, url, isError: use.isError }))
  }
  if (tool.startsWith('mcp__')) {
    const urls = Object.values(input).flatMap(value => (typeof value === 'string' ? findUrls(value) : []))
    return urls.map(url => record(use, 'mcp', { id: url, url, isError: use.isError }))
  }
  return []
}

/**
 * Adds a call's sources to the list: a source seen again counts once more and
 * keeps its latest status; a search result fetched later becomes a fetch.
 */
export const mergeSources = (list: readonly SourceRecord[], added: readonly SourceRecord[]): SourceRecord[] => {
  const byId = new Map(list.map(source => [source.id, source]))
  for (const source of added) {
    const existing = byId.get(source.id)
    if (existing === undefined) {
      byId.set(source.id, source)
      continue
    }
    const isUpgrade = existing.kind === 'result' && source.kind !== 'result'
    byId.set(source.id, {
      ...existing,
      ...(isUpgrade ? { kind: source.kind, tool: source.tool } : {}),
      count: existing.count + 1,
      lastAt: source.lastAt,
      status: source.status ?? existing.status,
      bytes: source.bytes ?? existing.bytes,
      durationMs: source.durationMs ?? existing.durationMs,
      title: existing.title ?? source.title,
      resultCount: source.resultCount ?? existing.resultCount,
      isError: source.isError,
      // --- sources by task ---
      taskIds: [...new Set([...existing.taskIds, ...source.taskIds])].slice(-MAX_TASK_IDS),
      // --- end sources by task ---
    })
  }
  return [...byId.values()].slice(-MAX_SOURCES)
}

export type SourceSummary = {
  urls: number
  domains: number
  searches: number
  fetched: number
  fetchedBytes: number
  errors: number
}

export const summarizeSources = (list: readonly SourceRecord[]): SourceSummary => {
  const pages = list.filter(source => source.url !== undefined)
  return {
    urls: pages.length,
    domains: new Set(pages.map(source => source.domain)).size,
    searches: list.filter(source => source.kind === 'search').length,
    fetched: list.filter(source => source.kind === 'fetch' || source.kind === 'browser').length,
    fetchedBytes: list.reduce((total, source) => total + (source.bytes ?? 0), 0),
    errors: list.filter(source => source.isError).length,
  }
}

/** Pages grouped by domain, the busiest domain first. */
export const byDomain = (list: readonly SourceRecord[]): { domain: string; sources: SourceRecord[] }[] => {
  const groups = new Map<string, SourceRecord[]>()
  for (const source of list) {
    if (source.url === undefined) {
      continue
    }
    groups.set(source.domain, [...(groups.get(source.domain) ?? []), source])
  }
  return [...groups.entries()]
    .map(([domain, sources]) => ({ domain, sources: [...sources].sort((a, b) => b.lastAt - a.lastAt) }))
    .sort((a, b) => b.sources.length - a.sources.length || a.domain.localeCompare(b.domain))
}

/** Counts one call of an MCP tool against its server; other tools leave the list as it is. */
export const recordService = (
  list: readonly ServiceUse[],
  tool: string,
  durationMs: number,
  isError: boolean,
  now: number,
): ServiceUse[] => {
  if (!tool.startsWith('mcp__')) {
    return [...list]
  }
  const server = tool.slice(5).split('__')[0] ?? tool
  const existing = list.find(one => one.server === server) ?? { server, calls: 0, totalMs: 0, errors: 0, lastAt: 0 }
  const entry: ServiceUse = {
    server,
    calls: existing.calls + 1,
    totalMs: existing.totalMs + durationMs,
    errors: existing.errors + (isError ? 1 : 0),
    lastAt: now,
  }
  return [...list.filter(one => one.server !== server), entry].sort((a, b) => b.calls - a.calls)
}
