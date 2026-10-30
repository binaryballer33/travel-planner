import { describe, expect, test } from 'claude-code/testing'

import type { FileChange } from '../types'
import { countActivity, fileRows, stronger, touch } from '../hooks/lib/files'
import { byDomain, domainOf, extractSources, findUrls, mergeSources, recordService, summarizeSources, type ToolUse } from '../hooks/lib/sources'

const T0 = 1_760_000_000_000

const use = (tool: string, input: Record<string, unknown>, result: unknown = undefined, extra: Partial<ToolUse> = {}): ToolUse => ({
  tool,
  input,
  result,
  text: '',
  isError: false,
  now: T0,
  durationMs: 120,
  ...extra,
})

describe('finding sources', () => {
  test('URLs in text, trailing punctuation dropped', () => {
    expect(findUrls('see https://a.com/x?y=1, and (https://b.org/z). Also https://a.com/x?y=1')).toEqual([
      'https://a.com/x?y=1',
      'https://b.org/z',
    ])
    expect(domainOf('https://www.example.com/a')).toBe('example.com')
    expect(domainOf('nope')).toBe('(not a URL)')
  })

  test('a fetch records its final URL, status, size and time', () => {
    const [source] = extractSources(
      use('WebFetch', { url: 'http://x.com', prompt: 'p' }, { url: 'https://x.com/', code: 200, bytes: 5120, durationMs: 340 }),
    )
    expect(source).toMatchObject({ id: 'https://x.com/', kind: 'fetch', domain: 'x.com', status: 200, bytes: 5120, durationMs: 340, isError: false })
  })

  test('a 404 fetch is an error', () => {
    expect(extractSources(use('WebFetch', { url: 'https://x.com/gone' }, { code: 404 }))[0]?.isError).toBe(true)
  })

  test('a search records the query and every result it returned', () => {
    const sources = extractSources(
      use('WebSearch', { query: 'spy options' }, {
        results: [
          'commentary',
          { tool_use_id: 't', content: [{ title: 'A', url: 'https://a.com/1' }, { title: 'B', url: 'https://b.com/2' }] },
        ],
        durationSeconds: 1.5,
      }),
    )
    expect(sources.map(source => [source.kind, source.id])).toEqual([
      ['search', 'search:spy options'],
      ['result', 'https://a.com/1'],
      ['result', 'https://b.com/2'],
    ])
    expect(sources[0]).toMatchObject({ resultCount: 2, durationMs: 1500 })
    expect(sources[1]).toMatchObject({ title: 'A', via: 'spy options' })
  })

  test('browser navigations, shell commands and MCP inputs name their URLs', () => {
    expect(extractSources(use('mcp__Claude_Browser__navigate', { url: 'https://docs.x.com' }))[0]?.kind).toBe('browser')
    expect(
      extractSources(use('mcp__Claude_Browser__browser_batch', { actions: [{ name: 'navigate', input: { url: 'https://y.com' } }, { name: 'computer', input: {} }] })).map(
        source => source.id,
      ),
    ).toEqual(['https://y.com'])
    expect(extractSources(use('Bash', { command: 'curl -s https://api.z.com/v1 | jq .' }))[0]).toMatchObject({ kind: 'command', domain: 'api.z.com' })
    expect(extractSources(use('mcp__x__get', { link: 'https://w.com/p' }))[0]?.kind).toBe('mcp')
    expect(extractSources(use('Read', { file_path: '/a' }))).toEqual([])
  })
})

describe('merging sources', () => {
  test('counts a source seen again and upgrades a search result that was then fetched', () => {
    const first = extractSources(use('WebSearch', { query: 'q' }, { results: [{ content: [{ title: 'A', url: 'https://a.com/1' }] }] }))
    const fetched = extractSources(use('WebFetch', { url: 'https://a.com/1' }, { code: 200, bytes: 10 }, { now: T0 + 5 }))
    const list = mergeSources(mergeSources([], first), fetched)
    const page = list.find(source => source.id === 'https://a.com/1')
    expect(page).toMatchObject({ kind: 'fetch', count: 2, status: 200, title: 'A', lastAt: T0 + 5 })
    expect(summarizeSources(list)).toEqual({ urls: 1, domains: 1, searches: 1, fetched: 1, fetchedBytes: 10, errors: 0 })
    expect(byDomain(list).map(group => group.domain)).toEqual(['a.com'])
  })
})

const change = (path: string, status: FileChange['status'], added = 0, removed = 0, isUntracked = false): FileChange => ({
  path,
  status,
  added,
  removed,
  isBinary: false,
  isUntracked,
})

describe('file activity', () => {
  test('a file created then edited stays created; a delete wins', () => {
    let list = touch([], '/r/a.py', 'created', 'Write', T0)
    list = touch(list, '/r/a.py', 'modified', 'Edit', T0 + 1)
    list = touch(list, '/r/a.py', 'read', 'Read', T0 + 2)
    expect(list[0]).toMatchObject({ activity: 'created', reads: 1, edits: 2, tools: ['Write', 'Edit', 'Read'], firstAt: T0, lastAt: T0 + 2, editedAt: T0 + 1 })
    expect(touch(list, '/r/a.py', 'deleted', 'Bash', T0 + 3)[0]?.activity).toBe('deleted')
    expect(touch([], '/r/b.py', 'read', 'Read', T0)[0]?.activity).toBe('read')
    expect(stronger('read', 'modified')).toBe('modified')
  })

  test('rows join tool activity to the working tree and add what only commands changed', () => {
    const touched = touch(touch([], '/r/src/a.py', 'read', 'Read', T0 + 10), '/outside/notes.md', 'created', 'Write', T0 + 20)
    const rows = fileRows(touched, [change('src/a.py', 'M', 3, 1), change('gen.json', 'A', 40, 0, true), change('old.txt', 'D', 0, 9)], '/r', T0 + 5)
    expect(rows.map(row => [row.display, row.activity, row.added, row.removed, row.tools.join(',')])).toEqual([
      ['/outside/notes.md', 'created', 0, 0, 'Write'],
      ['src/a.py', 'modified', 3, 1, 'Read'],
      ['gen.json', 'created', 40, 0, 'working tree'],
      ['old.txt', 'deleted', 0, 9, 'working tree'],
    ])
    expect(countActivity(rows)).toEqual({ created: 2, modified: 1, deleted: 1, read: 0 })
  })

  test('the last edit is the later of a Claude edit and the time on disk', () => {
    const touched = touch(touch([], '/r/a.py', 'modified', 'Edit', T0), '/r/a.py', 'read', 'Read', T0 + 50)
    const [row] = fileRows(touched, [{ ...change('a.py', 'M', 1, 0), mtimeMs: T0 + 30 }], '/r', T0)
    expect(row).toMatchObject({ lastAt: T0 + 50, editedAt: T0 + 30 })
    const [onlyGit] = fileRows([], [{ ...change('b.py', 'M'), mtimeMs: T0 - 5 }], '/r', T0)
    expect(onlyGit).toMatchObject({ lastAt: T0 - 5, editedAt: T0 - 5 })
    expect(fileRows(touch([], '/r/c.py', 'read', 'Read', T0), [], '/r', T0)[0]?.editedAt).toBeUndefined()
  })
})

describe('MCP services', () => {
  test('count calls, time and errors per server, busiest first', () => {
    let list = recordService([], 'mcp__quantconnect__read_backtest', 300, false, T0)
    list = recordService(list, 'mcp__quantconnect__create_backtest', 700, true, T0 + 1)
    list = recordService(list, 'mcp__github__get_issue', 50, false, T0 + 2)
    list = recordService(list, 'Bash', 10, false, T0 + 3)
    expect(list).toEqual([
      { server: 'quantconnect', calls: 2, totalMs: 1_000, errors: 1, lastAt: T0 + 1 },
      { server: 'github', calls: 1, totalMs: 50, errors: 0, lastAt: T0 + 2 },
    ])
  })
})
