import type { FsEntry, On, ProcessRunResult } from 'claude-code'
import { describe, expect, test, type Engine } from 'claude-code/testing'

import type { ExplorerView, TreeListing } from '../types'
import {
  armStep,
  compareNames,
  editRows,
  EMPTY_EXPLORER,
  EXPLORER_ARM_MS,
  explorerRows,
  foldersDown,
  fromField,
  ignoredNames,
  isAtLeast,
  isCaseOnly,
  listingOf,
  newEntryPath,
  readExplorerPress,
  renamedPath,
  targetDir,
  toField,
  trashReason,
  withRemoved,
  withRenamed,
  withSelected,
  type ExplorerRow,
} from '../hooks/lib/explorer'
import { EMPTY_TREE } from '../hooks/lib/tree'
import { ACTIONS_KEY, EDITOR_BOX_KEY, EXPLORER_CARD_KEY, editorFieldKey, explorerKey, FORM_BOX_KEY, formFieldKey } from '../hooks/view/explorer'
import { call, clickRow, keysIn, NOW, ok, PANE, shownCode, tabButton, textsIn, world } from './world'
import { desktopSizeOf, isDesktopDrawn } from './heavy'
import { TOO_BIG_KEY } from '../hooks/view/pane'

// ------------------------------------------------------------------------- //
// Pure
// ------------------------------------------------------------------------- //

const fsEntry = (name: string, kind: FsEntry['kind'], isLink = false): FsEntry => ({ name, kind, size: kind === 'file' ? 10 : 0, mtimeMs: NOW, isLink })

const listingAt = (path: string, names: readonly [string, FsEntry['kind']][]): TreeListing =>
  listingOf(
    path,
    names.map(([name, kind]) => fsEntry(name, kind)),
    NOW,
  )

/** An explorer of /repo with `listings` kept and `expanded` open. */
const viewOf = (listings: readonly TreeListing[], expanded: readonly string[] = [], extra: Partial<ExplorerView> = {}): ExplorerView => ({
  ...EMPTY_EXPLORER,
  tree: { ...EMPTY_TREE, root: '/repo', expanded: [...expanded], listings: Object.fromEntries(listings.map(one => [one.path, one])) },
  ...extra,
})

const shape = (rows: readonly ExplorerRow[]): string[] =>
  rows.map(row => (row.type === 'entry' ? `${row.depth}:${row.entry.name}${row.isOpen ? ' (open)' : ''}${row.isIgnored ? ' (ignored)' : ''}` : `${row.depth}:${row.text}`))

describe('explorer listing', () => {
  test('names sort naturally, ignoring case: dot names first, then _, file2 before file10', () => {
    const names = ['file10', 'README.md', '.env', 'apps', 'file2', 'AGENTS.md', '_private', 'components.json']
    expect([...names].sort(compareNames)).toEqual(['.env', '_private', 'AGENTS.md', 'apps', 'components.json', 'file2', 'file10', 'README.md'])
  })

  test('folders first, then files, as VS Code orders them; .git and .DS_Store left out; a link is a link', () => {
    const listing = listingOf(
      '/repo',
      [
        fsEntry('README.md', 'file'),
        fsEntry('apps', 'dir'),
        fsEntry('.git', 'dir'),
        fsEntry('.DS_Store', 'file'),
        fsEntry('.cache', 'dir'),
        fsEntry('.eslintrc.cjs', 'file'),
        fsEntry('latest', 'other', true),
        fsEntry('CLAUDE.md', 'file'),
      ],
      NOW,
    )
    expect(listing.entries.map(entry => `${entry.kind}:${entry.name}`)).toEqual(['dir:.cache', 'dir:apps', 'file:.eslintrc.cjs', 'file:CLAUDE.md', 'link:latest', 'file:README.md'])
    expect([listing.total, listing.hiddenTotal, listing.isTruncated]).toEqual([6, 2, false])
  })

  test('a folder of more than 500 entries keeps 500 and says how many it left out', () => {
    const many = Array.from({ length: 520 }, (_, at) => fsEntry(`f${at}`, 'file'))
    const listing = listingOf('/repo', many, NOW)
    expect([listing.entries.length, listing.total, listing.isTruncated]).toEqual([500, 520, true])
    expect(shape(explorerRows(viewOf([listing]))).at(-1)).toBe('0:… 20 more entries not listed: Open in Finder shows them all')
  })

  test('what git ignores is dim, and so is everything in an ignored folder', () => {
    const root = listingAt('/repo', [
      ['.venv', 'dir'],
      ['apps', 'dir'],
      ['README.md', 'file'],
    ])
    const venv = listingAt('/repo/.venv', [['bin', 'dir']])
    const apps = listingAt('/repo/apps', [['web', 'dir']])
    const view = viewOf([root, venv, apps], ['/repo/.venv', '/repo/apps'], { ignored: { '/repo': ['.venv'] } })
    expect(shape(explorerRows(view))).toEqual(['0:.venv (open) (ignored)', '1:bin (ignored)', '0:apps (open)', '1:web', '0:README.md'])
  })

  test('a folder loading, failing or empty says so under it', () => {
    const root = listingAt('/repo', [
      ['a', 'dir'],
      ['b', 'dir'],
      ['c', 'dir'],
    ])
    const view = viewOf([root, listingAt('/repo/c', [])], ['/repo/a', '/repo/b', '/repo/c'])
    const rows = explorerRows({ ...view, tree: { ...view.tree, loading: ['/repo/a'], errors: { '/repo/b': 'EACCES: permission denied' } } })
    expect(shape(rows)).toEqual(['0:a (open)', '1:Loading…', '0:b (open)', '1:Could not list this folder: EACCES: permission denied', '0:c (open)', '1:Empty'])
  })

  test("git check-ignore's answer is read NUL-separated, only for names asked about", () => {
    expect(ignoredNames('.venv\u0000node_modules\u0000', ['.venv', 'node_modules', 'src'])).toEqual(['.venv', 'node_modules'])
    expect(ignoredNames('', ['src'])).toEqual([])
    expect(ignoredNames('../other\u0000', ['src'])).toEqual([])
  })
})

describe('explorer names', () => {
  test('a new entry is one name or names joined by /, inside the folder it is made in', () => {
    expect(newEntryPath('/repo', '/repo', 'notes.md')).toEqual({ isOk: true, path: '/repo/notes.md' })
    expect(newEntryPath('/repo', '/repo/apps', '  src/utils/new.ts/ ')).toEqual({ isOk: true, path: '/repo/apps/src/utils/new.ts' })
    expect(newEntryPath('/repo', '/repo', '   ')).toEqual({ isOk: false, reason: 'Type a name first.' })
    expect(newEntryPath('/repo', '/repo', '../escape').isOk).toBe(false)
    expect(newEntryPath('/repo', '/repo', 'a//b').isOk).toBe(false)
    expect(newEntryPath('/repo', '/repo', 'a/./b').isOk).toBe(false)
    expect(newEntryPath('/repo', '/repo', 'a /b').isOk).toBe(false)
    expect(newEntryPath('/repo', '/repo', 'line\nbreak').isOk).toBe(false)
    expect(newEntryPath('/repo', '/etc', 'passwd').isOk).toBe(false)
  })

  test('a rename is a new name in the same folder; the same name is no rename', () => {
    expect(renamedPath('/repo', '/repo/apps/web', ' site ')).toEqual({ isOk: true, path: '/repo/apps/site' })
    expect(renamedPath('/repo', '/repo/apps', 'apps')).toEqual({ isOk: false, reason: '' })
    expect(renamedPath('/repo', '/repo/apps', 'a/b').isOk).toBe(false)
    expect(renamedPath('/repo', '/repo/apps', '..').isOk).toBe(false)
    expect(renamedPath('/repo', '/repo', 'other').isOk).toBe(false)
    expect(renamedPath('/repo', '/etc/hosts', 'x').isOk).toBe(false)
    expect(isCaseOnly('/repo/README.md', '/repo/Readme.md')).toBe(true)
    expect(isCaseOnly('/repo/README.md', '/repo/README.md')).toBe(false)
  })

  test('the folders a nested entry is made in, and where New file goes by the selection', () => {
    expect(foldersDown('/repo', '/repo/a/b/c.ts')).toEqual(['/repo', '/repo/a', '/repo/a/b'])
    expect(foldersDown('/repo/a', '/repo/a/c.ts')).toEqual(['/repo/a'])
    const root = listingAt('/repo', [
      ['apps', 'dir'],
      ['README.md', 'file'],
    ])
    const apps = listingAt('/repo/apps', [['index.ts', 'file']])
    const view = viewOf([root, apps], ['/repo/apps'])
    expect(targetDir(view)).toBe('/repo')
    expect(targetDir({ ...view, selected: '/repo/apps' })).toBe('/repo/apps')
    expect(targetDir({ ...view, selected: '/repo/apps/index.ts' })).toBe('/repo/apps')
    expect(targetDir({ ...view, selected: '/repo/README.md' })).toBe('/repo')
  })

  test("the editor keeps a file's Windows line ends, and versions compare by number", () => {
    expect(toField('a\r\nb\r\n')).toBe('a\nb\n')
    expect(fromField('a\nb\nc\n', 'a\r\nb\r\n')).toBe('a\r\nb\r\nc\r\n')
    expect(fromField('a\nb', 'a\nb\n')).toBe('a\nb')
    expect(isAtLeast('2.1.308', [2, 1, 308])).toBe(true)
    expect(isAtLeast('2.1.310-dev.20261025', [2, 1, 308])).toBe(true)
    expect(isAtLeast('2.2.0', [2, 1, 308])).toBe(true)
    expect(isAtLeast('2.1.299', [2, 1, 308])).toBe(false)
    expect(isAtLeast('garbage', [2, 1, 308])).toBe(false)
    expect(isAtLeast(undefined, [2, 1, 308])).toBe(false)
  })

  test('the editor is as tall as the file and a line more, within 6 and 28 lines', () => {
    expect(editRows('a\nb\n')).toBe(6)
    expect(editRows(Array.from({ length: 10 }, () => 'x').join('\n'))).toBe(11)
    expect(editRows(Array.from({ length: 400 }, () => 'x').join('\n'))).toBe(28)
  })

  test("trash's failure reads as the system's message", () => {
    const said = '2026-10-25 15:29:44.519 trash[69157:72152000] # Error attempting to move /x to the trash folder, Error Domain=NSCocoaErrorDomain Code=4 "The file “x” doesn’t exist." UserInfo={}'
    expect(trashReason(said, 5)).toBe('The file “x” doesn’t exist.')
    expect(trashReason('', 1)).toBe('exit code 1')
  })
})

describe('explorer state', () => {
  const root = listingAt('/repo', [
    ['apps', 'dir'],
    ['README.md', 'file'],
  ])
  const apps = listingAt('/repo/apps', [['web', 'dir']])
  const web = listingAt('/repo/apps/web', [['page.tsx', 'file']])

  test('a rename carries open folders, the selection and the editor with it, and drops its listings to list again', () => {
    const edit = { path: '/repo/apps/web/page.tsx', text: 'x', mtimeMs: NOW, isStale: false }
    const view = viewOf([root, apps, web], ['/repo/apps', '/repo/apps/web'], { selected: '/repo/apps/web', edit, form: { kind: 'rename', path: '/repo/apps' } })
    const renamed = withRenamed(view, '/repo/apps', '/repo/packages')
    expect(renamed.tree.expanded).toEqual(['/repo/packages', '/repo/packages/web'])
    expect(Object.keys(renamed.tree.listings)).toEqual(['/repo'])
    expect([renamed.selected, renamed.edit?.path, renamed.form]).toEqual(['/repo/packages/web', '/repo/packages/web/page.tsx', null])
  })

  test('a deletion closes it and what is below, and lets go of a selection, form or editor there', () => {
    const edit = { path: '/repo/apps/web/page.tsx', text: 'x', mtimeMs: NOW, isStale: false }
    const view = viewOf([root, apps, web], ['/repo/apps', '/repo/apps/web'], { selected: '/repo/apps/web', edit, form: { kind: 'file', dir: '/repo/apps/web' } })
    const removed = withRemoved(view, '/repo/apps')
    expect(removed.tree.expanded).toEqual([])
    expect(Object.keys(removed.tree.listings)).toEqual(['/repo'])
    expect([removed.selected, removed.edit, removed.form]).toEqual([null, null, null])
    // Elsewhere, they stay.
    const kept = withRemoved({ ...view, selected: '/repo/README.md' }, '/repo/apps/web')
    expect([kept.selected, kept.tree.expanded]).toEqual(['/repo/README.md', ['/repo/apps']])
  })

  test('another selection closes the open form and disarms Delete', () => {
    const view = viewOf([root], [], { selected: '/repo/apps', form: { kind: 'file', dir: '/repo/apps' }, armed: { key: 'delete:/repo/apps', at: NOW } })
    expect(withSelected(view, '/repo/README.md')).toMatchObject({ selected: '/repo/README.md', form: null, armed: null })
    expect(withSelected(view, '/repo/apps')).toBe(view)
  })

  test('two-press buttons act on a second press within the window, and not after it', () => {
    const first = armStep(null, 'delete:/repo/a', NOW)
    expect(first).toEqual({ isConfirmed: false, armed: { key: 'delete:/repo/a', at: NOW } })
    expect(armStep(first.armed, 'delete:/repo/a', NOW + 2_000)).toEqual({ isConfirmed: true, armed: null })
    expect(armStep(first.armed, 'delete:/repo/a', NOW + EXPLORER_ARM_MS).isConfirmed).toBe(false)
    expect(armStep(first.armed, 'delete:/repo/b', NOW + 1_000).isConfirmed).toBe(false)
  })

  test('a row press is read only with every field and a known kind', () => {
    expect(readExplorerPress({ kind: 'xdir', id: '/repo/a', path: '/repo/a' })).toEqual({ kind: 'xdir', id: '/repo/a', path: '/repo/a' })
    expect(readExplorerPress({ kind: 'dir', id: '/repo/a', path: '/repo/a' })).toBeUndefined()
    expect(readExplorerPress({ kind: 'xfile', id: '/repo/a' })).toBeUndefined()
  })
})

// ------------------------------------------------------------------------- //
// The pane, over a project folder in memory
// ------------------------------------------------------------------------- //

type Node = { kind: 'dir' } | { kind: 'file'; text: string; mtimeMs: number } | { kind: 'link'; to: string }

const parentOf = (path: string): string => path.slice(0, Math.max(1, path.lastIndexOf('/')))

const STARTING: readonly [string, Node][] = [
  ['/repo', { kind: 'dir' }],
  ['/repo/.git', { kind: 'dir' }],
  ['/repo/.DS_Store', { kind: 'file', text: '', mtimeMs: NOW }],
  ['/repo/.venv', { kind: 'dir' }],
  ['/repo/.github', { kind: 'dir' }],
  ['/repo/apps', { kind: 'dir' }],
  ['/repo/apps/web', { kind: 'dir' }],
  ['/repo/apps/web/node_modules', { kind: 'dir' }],
  ['/repo/apps/web/package.json', { kind: 'file', text: '{}', mtimeMs: NOW }],
  ['/repo/README.md', { kind: 'file', text: '# Read me\nhello explorer', mtimeMs: NOW }],
  ['/repo/CLAUDE.md', { kind: 'file', text: '# Claude', mtimeMs: NOW }],
  ['/repo/notes.txt', { kind: 'file', text: 'a\r\nb\r\n', mtimeMs: NOW }],
  ['/repo/link-out', { kind: 'link', to: '/etc' }],
]

const IGNORED = new Set(['.venv', 'node_modules'])

type ExplorerWorld = {
  nodes: Map<string, Node>
  runs: string[][]
  listed: string[]
  writes: [string, string][]
  toasts: string[]
  engine: { version: string }
  /** Apps `open -a` cannot find, as on a Mac without them. */
  failingApps: Set<string>
  clock: ReturnType<typeof world>
}

const isUnder = (dir: string, path: string): boolean => path.startsWith(`${dir}/`)

/** The shared world, with /repo held in memory beneath it: listed, read, written, made, moved and trashed. */
const explorerWorld = (on: On): ExplorerWorld => {
  const nodes = new Map<string, Node>(STARTING)
  const runs: string[][] = []
  const listed: string[] = []
  const writes: [string, string][] = []
  const toasts: string[] = []
  const engine = { version: '2.1.308' }
  const failingApps = new Set<string>()
  let tick = 0
  const isMine = (path: string): boolean => path === '/repo' || isUnder('/repo', path)
  const move = (from: string, to: string): void => {
    for (const [path, node] of [...nodes]) {
      if (path === from || isUnder(from, path)) {
        nodes.delete(path)
        nodes.set(`${to}${path.slice(from.length)}`, node)
      }
    }
  }
  const done = (stdout = ''): { value: ProcessRunResult } => ({ value: ok(stdout) })
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.version', () => ({ value: { version: engine.version, base: engine.version } }))
  on('fs.list', ($, e) => {
    const dir = e.path ?? '/repo'
    listed.push(dir)
    if (nodes.get(dir)?.kind !== 'dir') {
      throw new Error(`ENOENT: no such file or directory, scandir '${dir}'`)
    }
    const entries: FsEntry[] = [...nodes]
      .filter(([path]) => parentOf(path) === dir && path !== dir)
      .map(([path, node]) => ({
        name: path.slice(dir.length + 1),
        kind: node.kind === 'link' ? ('other' as const) : node.kind,
        size: node.kind === 'file' ? node.text.length : 0,
        mtimeMs: node.kind === 'file' ? node.mtimeMs : 0,
        isLink: node.kind === 'link',
      }))
    return { value: entries }
  })
  // Each beneath the world's own answers, by a matcher: /repo's paths, and the commands the Explorer runs.
  const MINE = /^\/repo(\/|$)/
  on('fs.exists', { path: /^\/repo(\/|$)|^\/usr\/bin\/trash$/ }, ($, e) => ({ value: e.path === '/usr/bin/trash' || nodes.has(e.path) }))
  on('fs.stat', { path: MINE }, ($, e) => {
    const node = nodes.get(e.path)
    if (node === undefined) {
      throw new Error(`ENOENT: no such file or directory, stat '${e.path}'`)
    }
    if (node.kind === 'link') {
      return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: true, realPath: node.to } }
    }
    return { value: { kind: node.kind, size: node.kind === 'file' ? node.text.length : 0, mtimeMs: node.kind === 'file' ? node.mtimeMs : 0, isLink: false, realPath: e.path } }
  })
  on('fs.read', { path: MINE }, ($, e) => {
    const node = nodes.get(e.path)
    if (node?.kind !== 'file') {
      throw new Error(`ENOENT: no such file or directory, open '${e.path}'`)
    }
    return { value: node.text }
  })
  on('fs.write', ($, e) => {
    tick += 1
    writes.push([e.path, e.text])
    for (let dir = parentOf(e.path); isMine(dir) && !nodes.has(dir); dir = parentOf(dir)) {
      nodes.set(dir, { kind: 'dir' })
    }
    nodes.set(e.path, { kind: 'file', text: e.text, mtimeMs: NOW + tick * 1_000 })
    return { value: undefined }
  })
  on('process.run', { argv: /^check-ignore$/ }, ($, e) => {
    const names = (e.init?.stdin ?? '').split('\u0000').filter((name: string) => IGNORED.has(name))
    return names.length > 0 ? done(`${names.join('\u0000')}\u0000`) : { value: { ...ok(''), exitCode: 1 } }
  })
  on('process.run', { argv: /^(mkdir|mv|\/usr\/bin\/trash|open)$/ }, ($, e) => {
    const [command, ...args] = e.argv
    runs.push([...e.argv])
    if (command === 'open' && args[0] === '-a' && failingApps.has(args[1] ?? '')) {
      return { value: { ...ok(''), exitCode: 1, stderr: `Unable to find application named '${args[1] ?? ''}'` } }
    }
    if (command === 'mkdir') {
      const path = args[args.length - 1] ?? ''
      for (let dir = path; isMine(dir) && !nodes.has(dir); dir = parentOf(dir)) {
        nodes.set(dir, { kind: 'dir' })
      }
    } else if (command === 'mv') {
      const [from, to] = args.filter(arg => arg !== '-n')
      if (from !== undefined && to !== undefined) {
        move(from, to)
      }
    } else if (command === '/usr/bin/trash') {
      const path = args[0] ?? ''
      for (const one of [...nodes.keys()]) {
        if (one === path || isUnder(path, one)) {
          nodes.delete(one)
        }
      }
    }
    return done()
  })
  const clock = world(on, toasts)
  return { nodes, runs, listed, writes, toasts, engine, failingApps, clock }
}

/** The Explorer's rows as drawn, by their paths, in order. */
const drawnRows = async (ui: Parameters<typeof keysIn>[0], paths: readonly string[]): Promise<string[]> => {
  const byKey = new Map(paths.map(path => [explorerKey(path), path]))
  const keys = await keysIn(ui, EXPLORER_CARD_KEY, 'xp:')
  return [...new Set(keys.filter(key => byKey.has(key)).map(key => byKey.get(key) ?? ''))]
}

const ALL_PATHS = [
  ...STARTING.map(([path]) => path),
  '/repo/lib',
  '/repo/lib/utils',
  '/repo/lib/utils/index.ts',
  '/repo/packages',
  '/repo/packages/web',
  '/repo/packages/web/node_modules',
  '/repo/packages/web/package.json',
  '/repo/Notes.txt',
]

const openExplorer = async ($: Engine, fx: ExplorerWorld, surface: 'terminal' | 'desktop') => {
  const ui = await $.ui.mount({ ...PANE, surface })
  await ui.press({ key: 'tab:explorer' })
  await fx.clock.settle()
  return ui
}

test('explorer: its tab, letter e, lists the project folder as VS Code does: folders first, hidden ones inline, .git left out, ignored ones dim', { timeoutMs: 20_000 }, async ($, on) => {
  const fx = explorerWorld(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await fx.clock.settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await openExplorer($, fx, surface)
    if (surface === 'terminal') {
      expect((await tabButton(ui, 'explorer'))?.props.hotkey).toBe('e')
    }
    const card = (await textsIn(ui, EXPLORER_CARD_KEY)).join('\n')
    expect(card).toMatch(/REPO\n\/repo\n/)
    expect(card).toContain('[New file]\n[New folder]\n[Refresh]\n[Collapse all]\n[Open in Finder]\nnew entries go in repo/')
    expect(await drawnRows(ui, ALL_PATHS)).toEqual(['/repo/.github', '/repo/.venv', '/repo/apps', '/repo/CLAUDE.md', '/repo/link-out', '/repo/notes.txt', '/repo/README.md'])
    // Git ignores .venv: it is dim; .github is not.
    expect((await ui.find({ in: explorerKey('/repo/.venv'), type: 'Text', text: '.venv' }))?.props.dimColor).toBe(true)
    expect((await ui.find({ in: explorerKey('/repo/.github'), type: 'Text', text: '.github' }))?.props.dimColor).toBe(false)
    // A folder leads with its arrow, a file with its type's icon.
    expect(await ui.find({ in: explorerKey('/repo/apps'), type: 'Text', text: '▸' })).toBeDefined()
    expect(await ui.find({ in: explorerKey('/repo/README.md'), type: 'Text', text: 'M↓' })).toBeDefined()
  }
  // Listed once, with what git ignores asked of it.
  expect(fx.listed).toEqual(['/repo'])
})

test("explorer: a click opens a folder and selects it; a file shows its text with its actions; a second click hides them", { timeoutMs: 20_000 }, async ($, on) => {
  const fx = explorerWorld(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await fx.clock.settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await openExplorer($, fx, surface)
    await clickRow(ui, explorerKey('/repo/apps'))
    await fx.clock.settle()
    await clickRow(ui, explorerKey('/repo/apps/web'))
    await fx.clock.settle()
    expect(await drawnRows(ui, ALL_PATHS)).toEqual([
      '/repo/.github',
      '/repo/.venv',
      '/repo/apps',
      '/repo/apps/web',
      '/repo/apps/web/node_modules',
      '/repo/apps/web/package.json',
      '/repo/CLAUDE.md',
      '/repo/link-out',
      '/repo/notes.txt',
      '/repo/README.md',
    ])
    expect(await ui.find({ in: explorerKey('/repo/apps'), type: 'Text', text: '▾' })).toBeDefined()
    expect((await ui.find({ in: explorerKey('/repo/apps/web/node_modules'), type: 'Text', text: 'node_modules' }))?.props.dimColor).toBe(true)
    // The selected folder's actions, and the toolbar's new entries go in it.
    expect((await textsIn(ui, ACTIONS_KEY)).join('\n')).toBe('[New file here]\n[New folder here]\n[Rename]\n[Delete]\n[Reveal in Finder]\n[Copy path]')
    expect((await textsIn(ui, EXPLORER_CARD_KEY)).join('\n')).toContain('new entries go in apps/web/')

    // A file shows its text, selected, with its actions.
    await clickRow(ui, explorerKey('/repo/README.md'))
    await fx.clock.settle()
    const shown = await shownCode(ui)
    expect(shown.kind).toBe(surface === 'terminal' ? 'code' : 'view')
    expect(shown.text).toContain('hello explorer')
    expect((await textsIn(ui, ACTIONS_KEY)).join('\n')).toBe('[Edit]\n[Rename]\n[Delete]\n[Open in Cursor]\n[Reveal in Finder]\n[Copy path]')
    await ui.press({ key: 'xp:act:open' })
    await ui.press({ key: 'xp:act:reveal' })
    expect(fx.runs.slice(-2)).toEqual([
      ['open', '-a', 'Cursor', '/repo/README.md'],
      ['open', '-R', '/repo/README.md'],
    ])
    // A link to a folder has no text to show; it is still selected, so it can be renamed or deleted.
    await clickRow(ui, explorerKey('/repo/link-out'))
    await fx.clock.settle()
    expect(fx.toasts).toContain('link-out is a link to a folder: nothing to show as text.')
    expect(await ui.find({ key: 'xp:act:delete' })).toBeDefined()
    // A second click on the selected file hides it again.
    await clock1(fx)
    await clickRow(ui, explorerKey('/repo/README.md'))
    await fx.clock.settle()
    await clock1(fx)
    await clickRow(ui, explorerKey('/repo/README.md'))
    await fx.clock.settle()
    expect((await shownCode(ui)).kind).toBe('none')
    expect(await ui.find({ key: 'xp:act:delete' })).toBeUndefined()
    await clock1(fx)
    await ui.press({ key: 'xp:collapse' })
    await fx.clock.settle()
  }
})

/** A second later: past a press's bounce window. */
const clock1 = async (fx: ExplorerWorld): Promise<void> => {
  await fx.clock.advance(1_000)
  await fx.clock.settle()
}

test('explorer: makes folders and files, nested ones too, where the selection is; a new file opens in the editor; never over an entry', { timeoutMs: 20_000 }, async ($, on) => {
  const fx = explorerWorld(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await fx.clock.settle()
  const ui = await openExplorer($, fx, 'desktop')
  // Nothing selected: a new folder goes in the root, and the folders on its way are made with it.
  await ui.press({ key: 'xp:newfolder' })
  await fx.clock.settle()
  expect((await textsIn(ui, FORM_BOX_KEY)).join('\n')).toBe('New folder in repo/\n[Create]\n[Cancel]\na “/” makes the folders on the way')
  await ui.input({ key: formFieldKey({ kind: 'folder', dir: '/repo' }), text: 'lib/utils' })
  await fx.clock.settle()
  expect(fx.runs).toContainEqual(['mkdir', '-p', '/repo/lib/utils'])
  expect(await keysIn(ui, EXPLORER_CARD_KEY, FORM_BOX_KEY)).toEqual([])
  expect(await drawnRows(ui, ALL_PATHS)).toEqual(expect.arrayContaining(['/repo/lib', '/repo/lib/utils']))
  expect(fx.toasts).toContain('Made lib/utils.')

  // The new folder is selected: a new file goes in it, and opens in the editor.
  await clock1(fx)
  await ui.press({ key: 'xp:newfile' })
  await fx.clock.settle()
  expect((await textsIn(ui, FORM_BOX_KEY))[0]).toBe('New file in lib/utils/')
  await ui.input({ key: formFieldKey({ kind: 'file', dir: '/repo/lib/utils' }), text: 'index.ts' })
  await fx.clock.settle()
  expect(fx.writes).toContainEqual(['/repo/lib/utils/index.ts', ''])
  expect((await textsIn(ui, EDITOR_BOX_KEY))[0]).toBe('✎ Editing index.ts lib/utils/index.ts')

  // An entry that is there already is never written over; a name with .. is refused.
  await clock1(fx)
  await ui.press({ key: 'xp:edit:close' })
  await fx.clock.settle()
  // Closed, the new file stays selected and shows its text; a click on it lets go, so New file goes in the root.
  await clickRow(ui, explorerKey('/repo/lib/utils/index.ts'))
  await fx.clock.settle()
  await clock1(fx)
  await ui.press({ key: 'xp:newfile' })
  await fx.clock.settle()
  await ui.input({ key: formFieldKey({ kind: 'file', dir: '/repo' }), text: 'README.md' })
  await fx.clock.settle()
  expect(fx.toasts).toContain('README.md already exists.')
  await clock1(fx)
  await ui.input({ key: formFieldKey({ kind: 'file', dir: '/repo' }), text: '../escape.txt' })
  await fx.clock.settle()
  expect(fx.toasts.some(text => text.startsWith('Each part of the name needs a name'))).toBe(true)
  expect(fx.writes.map(([path]) => path)).toEqual(['/repo/lib/utils/index.ts'])
  // Cancel closes the form.
  await ui.press({ key: 'xp:form:cancel' })
  await fx.clock.settle()
  expect(await keysIn(ui, EXPLORER_CARD_KEY, FORM_BOX_KEY)).toEqual([])
})

test('explorer: renames in place, its open folders and selection following; never over another entry; a case-only rename too', { timeoutMs: 20_000 }, async ($, on) => {
  const fx = explorerWorld(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await fx.clock.settle()
  const ui = await openExplorer($, fx, 'terminal')
  await clickRow(ui, explorerKey('/repo/apps'))
  await fx.clock.settle()
  await ui.press({ key: 'xp:act:rename' })
  await fx.clock.settle()
  const field = formFieldKey({ kind: 'rename', path: '/repo/apps' })
  expect((await ui.find({ key: field }))?.props.value).toBe('apps')
  await ui.input({ key: field, text: 'packages' })
  await fx.clock.settle()
  expect(fx.runs).toContainEqual(['mv', '-n', '/repo/apps', '/repo/packages'])
  expect(await drawnRows(ui, ALL_PATHS)).toEqual(['/repo/.github', '/repo/.venv', '/repo/packages', '/repo/packages/web', '/repo/CLAUDE.md', '/repo/link-out', '/repo/notes.txt', '/repo/README.md'])
  expect(fx.toasts).toContain('Renamed apps to packages.')
  // The selection followed it.
  expect((await textsIn(ui, ACTIONS_KEY))[0]).toBe('[New file here]')

  // Never over another entry.
  await clock1(fx)
  await clickRow(ui, explorerKey('/repo/README.md'))
  await fx.clock.settle()
  await ui.press({ key: 'xp:act:rename' })
  await fx.clock.settle()
  await ui.input({ key: formFieldKey({ kind: 'rename', path: '/repo/README.md' }), text: 'CLAUDE.md' })
  await fx.clock.settle()
  expect(fx.toasts).toContain('CLAUDE.md already exists in repo.')
  expect(fx.runs.filter(argv => argv[0] === 'mv')).toHaveLength(1)

  // Only the letters' case: plain mv, since `mv -n` would do nothing there.
  await clock1(fx)
  await clickRow(ui, explorerKey('/repo/notes.txt'))
  await fx.clock.settle()
  await ui.press({ key: 'xp:act:rename' })
  await fx.clock.settle()
  await ui.input({ key: formFieldKey({ kind: 'rename', path: '/repo/notes.txt' }), text: 'Notes.txt' })
  await fx.clock.settle()
  expect(fx.runs).toContainEqual(['mv', '/repo/notes.txt', '/repo/Notes.txt'])
})

test('explorer: Delete asks for a second click, then moves the entry to the Trash; the ask lapses after 6 s', { timeoutMs: 20_000 }, async ($, on) => {
  const fx = explorerWorld(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await fx.clock.settle()
  const ui = await openExplorer($, fx, 'terminal')
  await clickRow(ui, explorerKey('/repo/CLAUDE.md'))
  await fx.clock.settle()
  await ui.press({ key: 'xp:act:delete' })
  await fx.clock.settle()
  expect((await ui.find({ key: 'xp:act:delete' }))?.props.label).toBe('Click again to delete')
  expect((await textsIn(ui, ACTIONS_KEY)).join('\n')).toContain('A second click within 6 s moves CLAUDE.md to the Trash')
  expect(fx.runs.filter(argv => argv[0] === '/usr/bin/trash')).toEqual([])
  // A double click is one press: nothing is deleted on it.
  await ui.press({ key: 'xp:act:delete' })
  await fx.clock.settle()
  expect(fx.runs.filter(argv => argv[0] === '/usr/bin/trash')).toEqual([])
  await clock1(fx)
  await ui.press({ key: 'xp:act:delete' })
  await fx.clock.settle()
  expect(fx.runs).toContainEqual(['/usr/bin/trash', '/repo/CLAUDE.md'])
  expect(await drawnRows(ui, ALL_PATHS)).not.toContain('/repo/CLAUDE.md')
  expect(fx.toasts).toContain('Moved CLAUDE.md to the Trash.')

  // The ask lapses: a press 7 s after the first arms it again.
  await clickRow(ui, explorerKey('/repo/apps'))
  await fx.clock.settle()
  await ui.press({ key: 'xp:act:delete' })
  await fx.clock.advance(7_000)
  await fx.clock.settle()
  expect((await ui.find({ key: 'xp:act:delete' }))?.props.label).toBe('Delete')
  await ui.press({ key: 'xp:act:delete' })
  await fx.clock.settle()
  expect(fx.runs.filter(argv => argv[0] === '/usr/bin/trash')).toHaveLength(1)
  expect((await textsIn(ui, ACTIONS_KEY)).join('\n')).toContain('moves apps and everything in it to the Trash')
})

test("explorer: edits a file and saves it, keeping its line ends; a change on disk asks before it is written over; unsaved text needs a second Close", { timeoutMs: 20_000 }, async ($, on) => {
  const fx = explorerWorld(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await fx.clock.settle()
  const ui = await openExplorer($, fx, 'desktop')
  await clickRow(ui, explorerKey('/repo/notes.txt'))
  await fx.clock.settle()
  await ui.press({ key: 'xp:act:edit' })
  await fx.clock.settle()
  const field = editorFieldKey('/repo/notes.txt')
  const editor = await ui.find({ key: field })
  expect(editor?.props.value).toBe('a\nb\n')
  // The editor replaces the file's text below it, and its Edit button.
  expect((await shownCode(ui)).kind).toBe('none')
  expect(await ui.find({ key: 'xp:act:edit' })).toBeUndefined()

  await ui.input({ key: field, text: 'a\nb\nc\n', kind: 'change' })
  await ui.press({ key: 'xp:edit:save' })
  await fx.clock.settle()
  expect(fx.writes.at(-1)).toEqual(['/repo/notes.txt', 'a\r\nb\r\nc\r\n'])
  expect(fx.toasts).toContain('Saved notes.txt.')

  // Changed on disk since: the first Save only asks.
  fx.nodes.set('/repo/notes.txt', { kind: 'file', text: 'theirs\r\n', mtimeMs: NOW + 99_000 })
  await clock1(fx)
  await ui.input({ key: field, text: 'mine\n', kind: 'change' })
  await ui.press({ key: 'xp:edit:save' })
  await fx.clock.settle()
  expect(fx.writes).toHaveLength(1)
  expect(fx.toasts).toContain('notes.txt changed on disk since you opened it: Save over it writes your text over that change.')
  expect((await ui.find({ key: 'xp:edit:save' }))?.props.label).toBe('Save over it')
  await clock1(fx)
  // Enter in the field saves too.
  await ui.input({ key: field, text: 'mine\n' })
  await fx.clock.settle()
  expect(fx.writes.at(-1)).toEqual(['/repo/notes.txt', 'mine\r\n'])
  expect((await ui.find({ key: 'xp:edit:save' }))?.props.label).toBe('Save')

  // Unsaved text: Close asks first.
  await clock1(fx)
  await ui.input({ key: field, text: 'draft\n', kind: 'change' })
  await ui.press({ key: 'xp:edit:close' })
  await fx.clock.settle()
  expect((await ui.find({ key: 'xp:edit:close' }))?.props.label).toBe('Discard changes')
  // A redraw keeps what was typed.
  expect((await ui.find({ key: field }))?.props.value).toBe('draft\n')
  await clock1(fx)
  await ui.press({ key: 'xp:edit:close' })
  await fx.clock.settle()
  expect(await keysIn(ui, EXPLORER_CARD_KEY, EDITOR_BOX_KEY)).toEqual([])
  expect(fx.writes).toHaveLength(2)
  // The file is still selected: its text shows again.
  expect((await shownCode(ui)).text).toContain('mine')
})

test('explorer: on an engine without fields of several lines, Edit is not offered and no drawing names rows', { timeoutMs: 20_000 }, async ($, on) => {
  const fx = explorerWorld(on)
  fx.engine.version = '2.1.293'
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await fx.clock.settle()
  const ui = await openExplorer($, fx, 'desktop')
  await clickRow(ui, explorerKey('/repo/README.md'))
  await fx.clock.settle()
  expect(await ui.find({ key: 'xp:act:edit' })).toBeUndefined()
  expect((await textsIn(ui, ACTIONS_KEY)).join('\n')).toContain('Editing here needs Claude Code 2.1.308 or later: Open in Cursor edits it.')
  // A new file is made and selected, not opened in an editor.
  await ui.press({ key: 'xp:newfile' })
  await fx.clock.settle()
  await ui.input({ key: formFieldKey({ kind: 'file', dir: '/repo' }), text: 'todo.md' })
  await fx.clock.settle()
  expect(fx.writes).toEqual([['/repo/todo.md', '']])
  expect(await keysIn(ui, EXPLORER_CARD_KEY, EDITOR_BOX_KEY)).toEqual([])
  expect((await ui.findAll({ type: 'Input' })).some(input => input.props.rows !== undefined)).toBe(false)
})

test('explorer: never acts outside the project folder, and lists again after Claude changes files while on screen', { timeoutMs: 20_000 }, async ($, on) => {
  const fx = explorerWorld(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await fx.clock.settle()
  const ui = await openExplorer($, fx, 'terminal')
  const apps = explorerKey('/repo/apps')
  // A forged press for a path outside, or spelled with .., does nothing.
  await ui.post({ kind: 'xdir', id: '/etc', path: '/etc' }, { in: apps })
  await ui.post({ kind: 'xfile', id: '/repo/../etc/passwd', path: '/repo/../etc/passwd' }, { in: apps })
  await fx.clock.settle()
  expect(fx.listed).toEqual(['/repo'])
  expect((await shownCode(ui)).kind).toBe('none')

  await clickRow(ui, apps)
  await fx.clock.settle()
  // A file tool's change lists the root and the open folder again.
  await call($, { tool: 'Write', file_path: '/repo/new.txt', content: 'x' })
  await fx.clock.advance(2_500)
  await fx.clock.settle()
  expect(fx.listed).toEqual(['/repo', '/repo/apps', '/repo', '/repo/apps'])
  // Not while another tab is on screen.
  await ui.press({ key: 'tab:commands' })
  await call($, { tool: 'Write', file_path: '/repo/other.txt', content: 'x' })
  await fx.clock.advance(2_500)
  await fx.clock.settle()
  expect(fx.listed).toHaveLength(4)
  // An open folder deleted outside the pane closes on Refresh.
  await ui.press({ key: 'tab:explorer' })
  fx.nodes.delete('/repo/apps')
  fx.nodes.delete('/repo/apps/web')
  await ui.press({ key: 'xp:refresh' })
  await fx.clock.settle()
  expect(await ui.find({ type: 'Text', text: /Could not list/ })).toBeUndefined()
  expect(await drawnRows(ui, ALL_PATHS)).not.toContain('/repo/apps')
})

test('explorer: an open folder of 500 entries stays drawn on the desktop, not the too-big notice; the note past the budget asks to close a folder', { timeoutMs: 30_000 }, async ($, on) => {
  const fx = explorerWorld(on)
  for (let index = 0; index < 520; index += 1) {
    fx.nodes.set(`/repo/apps/web/node_modules/package-${String(index).padStart(3, '0')}`, { kind: 'dir' })
  }
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await fx.clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 54 } })
  await ui.press({ key: 'tab:explorer' })
  await fx.clock.settle()
  for (const path of ['/repo/apps', '/repo/apps/web', '/repo/apps/web/node_modules']) {
    await clickRow(ui, explorerKey(path))
    await fx.clock.settle()
  }
  const drawn = await ui.drawn()
  expect(JSON.stringify(drawn).includes('more characters, not drawn')).toBe(false)
  expect(isDesktopDrawn(desktopSizeOf(drawn))).toBe(true)
  expect(await ui.find({ key: TOO_BIG_KEY })).toBeUndefined()
  expect((await ui.findAll({ type: 'Client' })).some(client => client.key === explorerKey('/repo/apps/web/node_modules/package-000'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^… \d+ more rows \(close a folder to see them\)$/ })).toBeDefined()
  // The selected folder keeps its actions drawn, whatever the list leaves out.
  expect(await ui.find({ key: 'xp:act:delete' })).toBeDefined()
  await ui.unmount()
})

test('explorer: Open sends code to Cursor, a web page to Chrome, the rest to its own app, a folder to Finder; where Cursor cannot, the default app does', { timeoutMs: 20_000 }, async ($, on) => {
  const fx = explorerWorld(on)
  fx.nodes.set('/repo/index.html', { kind: 'file', text: '<h1>hi</h1>', mtimeMs: NOW })
  fx.nodes.set('/repo/logo.png', { kind: 'file', text: '', mtimeMs: NOW })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await fx.clock.settle()
  const ui = await openExplorer($, fx, 'desktop')
  const openOf = async (path: string): Promise<unknown> => {
    await clickRow(ui, explorerKey(path))
    await fx.clock.settle()
    const label = (await ui.find({ key: 'xp:act:open' }))?.props.label
    await ui.press({ key: 'xp:act:open' })
    await fx.clock.settle()
    return label
  }
  expect(await openOf('/repo/index.html')).toBe('Open in Chrome')
  expect(fx.runs.at(-1)).toEqual(['open', '-a', 'Google Chrome', '/repo/index.html'])
  expect(await openOf('/repo/logo.png')).toBe('Open in app')
  expect(fx.runs.at(-1)).toEqual(['open', '/repo/logo.png'])
  // The project folder opens in Finder, never in an editor.
  await ui.press({ key: 'xp:finder' })
  await fx.clock.settle()
  expect(fx.runs.at(-1)).toEqual(['open', '/repo'])
  // Without Cursor, a code file opens in its default app, and says so.
  fx.failingApps.add('Cursor')
  expect(await openOf('/repo/CLAUDE.md')).toBe('Open in Cursor')
  expect(fx.runs.slice(-2)).toEqual([
    ['open', '-a', 'Cursor', '/repo/CLAUDE.md'],
    ['open', '/repo/CLAUDE.md'],
  ])
  expect(fx.toasts).toContain("Cursor could not open CLAUDE.md (Unable to find application named 'Cursor'): opened it in its default app.")
})
