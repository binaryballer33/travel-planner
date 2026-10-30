import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import type { TreeEntry, TreeListing, TreeView } from '../types'
import { fmtClock } from '../hooks/lib/format'
import {
  baseName,
  childPath,
  collapse,
  collapseAll,
  EMPTY_TREE,
  expand,
  findEntry,
  flattenTree,
  forRoot,
  isAbsolutePath,
  isBelow,
  isInsideRoot,
  listedFolders,
  modeParts,
  parentOf,
  parseListing,
  readTreePress,
  setLoading,
  sizeText,
  sizeTone,
  toggleHidden,
  toPosixPath,
  treeArgv,
  withListing,
  type TreeRow,
} from '../hooks/lib/tree'
import { DIFF_PANEL_KEY } from '../hooks/view/diff'
import { CARD_BACKGROUND } from '../hooks/view/kit'
import { hiddenKey, TREE_CARD_KEY, treeKey } from '../hooks/view/tree'
import { call, clickRow, fail, keysOf, NOW, ok, PANE, shownCode, textsIn, world } from './world'
import { desktopSizeOf, isDesktopDrawn } from './heavy'
import { TOO_BIG_KEY } from '../hooks/view/pane'

const T0 = 1_760_000_000_000

const entry = (name: string, kind: TreeEntry['kind'], extra: Partial<TreeEntry> = {}): TreeEntry => ({
  name,
  kind,
  size: 10,
  isPartial: false,
  mode: kind === 'dir' ? 'drwxr-xr-x' : '-rw-r--r--',
  mtimeMs: T0,
  isHidden: name.startsWith('.'),
  ...extra,
})

const listing = (path: string, entries: TreeEntry[], extra: Partial<TreeListing> = {}): TreeListing => ({
  path,
  entries,
  total: entries.length,
  hiddenTotal: entries.filter(one => one.isHidden).length,
  isTruncated: false,
  loadedAt: T0,
  ...extra,
})

const shape = (rows: readonly TreeRow[]): string[] =>
  rows.map(row =>
    row.type === 'entry'
      ? `${row.depth}:${row.entry.name}${row.isOpen ? ' (open)' : ''}`
      : row.type === 'hidden'
        ? `${row.depth}:[hidden ${row.count}${row.isOpen ? ' open' : ''}]`
        : `${row.depth}:${row.text}`,
  )

describe('tree paths', () => {
  test('only the root and paths below it, spelled without . or .., are inside', () => {
    expect(isInsideRoot('/repo', '/repo')).toBe(true)
    expect(isInsideRoot('/repo', '/repo/src/app.py')).toBe(true)
    expect(isInsideRoot('/repo', '/repo/../etc')).toBe(false)
    expect(isInsideRoot('/repo', '/repo/./src')).toBe(false)
    expect(isInsideRoot('/repo', '/repo//src')).toBe(false)
    expect(isInsideRoot('/repo', '/repository')).toBe(false)
    expect(isInsideRoot('/repo', 'repo/src')).toBe(false)
    expect(isInsideRoot('', '/repo')).toBe(false)
    expect(isInsideRoot('/a/../b', '/a/../b/c')).toBe(false)
    expect(isInsideRoot('/', '/etc')).toBe(true)
  })

  test('on Windows a path is kept with forward slashes and a drive: inside, below, parent and name read as they do from /', () => {
    expect(toPosixPath('C:\\Users\\me\\proj\\')).toBe('C:/Users/me/proj')
    expect(toPosixPath('C:')).toBe('C:/')
    expect(toPosixPath('/')).toBe('/')
    expect(isAbsolutePath('C:/Users')).toBe(true)
    expect(isAbsolutePath('C:\\Users')).toBe(false)
    expect(isAbsolutePath('Users/me')).toBe(false)
    expect(isInsideRoot('C:/Users/me', 'C:/Users/me')).toBe(true)
    expect(isInsideRoot('C:/Users/me', 'C:/Users/me/src/app.py')).toBe(true)
    expect(isInsideRoot('C:/Users/me', 'C:/Users/me/../you')).toBe(false)
    expect(isInsideRoot('C:/Users/me', 'C:/Users/mine')).toBe(false)
    expect(isInsideRoot('C:/', 'C:/Windows')).toBe(true)
    expect(isInsideRoot('C:/Users/me', '/Users/me')).toBe(false)
    expect(childPath('C:/Users/me', 'src')).toBe('C:/Users/me/src')
    expect(childPath('C:/', 'Windows')).toBe('C:/Windows')
    expect(isBelow('C:/', 'C:/Windows')).toBe(true)
    expect(isBelow('C:/Users', 'C:/Users')).toBe(false)
    expect(baseName('C:/Users/me')).toBe('me')
    expect(baseName('C:/')).toBe('C:/')
    expect(parentOf('C:/Users/me')).toBe('C:/Users')
    expect(parentOf('C:/Users')).toBe('C:/')
    expect(parentOf('C:/')).toBe('C:/')
  })

  test('a child path is built only from an entry name', () => {
    expect(childPath('/repo', 'src')).toBe('/repo/src')
    expect(childPath('/', 'etc')).toBe('/etc')
    expect(childPath('/repo', '..')).toBeUndefined()
    expect(childPath('/repo', 'a/b')).toBeUndefined()
    expect(childPath('/repo', '')).toBeUndefined()
    expect(isBelow('/repo', '/repo/src')).toBe(true)
    expect(isBelow('/repo', '/repo')).toBe(false)
    expect(isBelow('/repo', '/repository')).toBe(false)
    expect(baseName('/repo/src')).toBe('src')
    expect(baseName('/')).toBe('/')
    expect(parentOf('/repo/src')).toBe('/repo')
    expect(parentOf('/repo')).toBe('/')
  })

  test('the lister runs isolated, with the root to check against', () => {
    expect(treeArgv('/usr/bin/python3', '/mod/sampler/tree.py', '/repo', '/repo/src')).toEqual([
      '/usr/bin/python3',
      '-I',
      '/mod/sampler/tree.py',
      '/repo/src',
      '--root',
      '/repo',
      '--budget-ms',
      '1500',
      '--max-entries',
      '400',
    ])
  })
})

describe("reading the lister's answer", () => {
  test('keeps well-formed entries and drops the rest', () => {
    const stdout = JSON.stringify({
      path: '/repo',
      entries: [
        { name: 'src', kind: 'dir', size: 30, isPartial: true, mode: 'drwxr-xr-x', mtimeMs: T0, isHidden: false },
        { name: '.env', kind: 'file', size: 5, isPartial: false, mode: '-rw-------', mtimeMs: T0, isHidden: false },
        { name: 'ln', kind: 'link', size: 3, isPartial: false, mode: 'lrwxr-xr-x', mtimeMs: T0, isHidden: false, linkTarget: '../x' },
        { name: 'locked', kind: 'dir', size: -4, mode: 'nonsense', error: 'Permission denied' },
        { name: '../escape', kind: 'file' },
        { name: 'weird', kind: 'socket' },
        'junk',
      ],
      total: 9,
      hiddenTotal: 1,
      truncated: true,
    })
    const parsed = parseListing(stdout, '/repo', T0)
    expect(parsed.isOk).toBe(true)
    if (!parsed.isOk) {
      return
    }
    expect(parsed.listing.entries.map(one => one.name)).toEqual(['src', '.env', 'ln', 'locked'])
    expect(parsed.listing.entries[0]).toMatchObject({ isPartial: true, size: 30 })
    // Hidden is the name's, whatever the answer says.
    expect(parsed.listing.entries[1]?.isHidden).toBe(true)
    expect(parsed.listing.entries[2]?.linkTarget).toBe('../x')
    expect(parsed.listing.entries[3]).toMatchObject({ size: 0, mode: '?---------', error: 'Permission denied', isPartial: false })
    expect(parsed.listing).toMatchObject({ path: '/repo', total: 9, hiddenTotal: 1, isTruncated: true, loadedAt: T0 })
  })

  test('an error, nothing or not JSON is an error', () => {
    expect(parseListing('{"path":"/x","entries":[],"error":"No such file or directory"}', '/x', T0)).toEqual({ isOk: false, error: 'No such file or directory' })
    expect(parseListing('', '/x', T0).isOk).toBe(false)
    expect(parseListing('Traceback (most recent call last)', '/x', T0).isOk).toBe(false)
    expect(parseListing('[1,2]', '/x', T0).isOk).toBe(false)
    expect(parseListing('{"path":"/x"}', '/x', T0).isOk).toBe(false)
  })

  test('a row press is read only with every field', () => {
    expect(readTreePress({ kind: 'dir', id: '/repo/src', path: '/repo/src' })).toEqual({ kind: 'dir', id: '/repo/src', path: '/repo/src' })
    expect(readTreePress({ kind: 'cmd', id: 'a', path: '' })).toBeUndefined()
    expect(readTreePress({ kind: 'entry', id: 'a' })).toBeUndefined()
    expect(readTreePress('dir')).toBeUndefined()
  })
})

describe('tree state', () => {
  const root: TreeView = { ...EMPTY_TREE, mode: 'folder', root: '/repo' }

  test('a listing is kept only for the root and open folders; closing drops everything below', () => {
    const src = listing('/repo/src', [entry('lib', 'dir')])
    let view = withListing(root, '/repo/src', { isOk: true, listing: src })
    expect(view.listings['/repo/src']).toBeUndefined()
    view = expand(view, '/repo/src')
    view = setLoading(view, '/repo/src', true)
    expect(view.loading).toEqual(['/repo/src'])
    view = withListing(view, '/repo/src', { isOk: true, listing: src })
    expect(view.loading).toEqual([])
    view = expand(view, '/repo/src/lib')
    view = withListing(view, '/repo/src/lib', { isOk: false, error: 'Permission denied' })
    view = toggleHidden(view, '/repo/src/lib')
    expect(view.errors['/repo/src/lib']).toBe('Permission denied')
    expect(listedFolders(view)).toEqual(['/repo', '/repo/src', '/repo/src/lib'])
    const closed = collapse(view, '/repo/src')
    expect(closed.expanded).toEqual([])
    expect(closed.hiddenOpen).toEqual([])
    expect(Object.keys(closed.listings)).toEqual([])
    expect(Object.keys(closed.errors)).toEqual([])
  })

  test('collapse all keeps the root; another working folder starts afresh in the same mode', () => {
    let view = withListing(root, '/repo', { isOk: true, listing: listing('/repo', [entry('src', 'dir')]) })
    view = expand(view, '/repo/src')
    view = withListing(view, '/repo/src', { isOk: true, listing: listing('/repo/src', []) })
    view = toggleHidden(toggleHidden(view, '/repo'), '/repo/src')
    const all = collapseAll(view)
    expect(Object.keys(all.listings)).toEqual(['/repo'])
    expect(all.hiddenOpen).toEqual(['/repo'])
    expect(forRoot(view, '/repo')).toBe(view)
    expect(forRoot(view, '/other')).toEqual({ ...EMPTY_TREE, mode: 'folder', root: '/other' })
    expect(toggleHidden(toggleHidden(root, '/repo'), '/repo').hiddenOpen).toEqual([])
  })

  test('an entry is found in its folder\'s listing', () => {
    const view = withListing(root, '/repo', { isOk: true, listing: listing('/repo', [entry('pipe', 'other'), entry('a.py', 'file')]) })
    expect(findEntry(view, '/repo/pipe')?.kind).toBe('other')
    expect(findEntry(view, '/repo/a.py')?.kind).toBe('file')
    expect(findEntry(view, '/repo/gone.py')).toBeUndefined()
    expect(findEntry(view, '/repo/src/a.py')).toBeUndefined()
  })
})

describe('tree rows', () => {
  const base: TreeView = {
    ...EMPTY_TREE,
    mode: 'folder',
    root: '/repo',
    listings: {
      '/repo': listing('/repo', [entry('src', 'dir', { size: 300 }), entry('README.md', 'file'), entry('.git', 'dir', { isPartial: true, size: 900 }), entry('.env', 'file')]),
      '/repo/src': listing('/repo/src', [entry('app.py', 'file'), entry('.cache', 'dir')]),
    },
  }

  test('folders closed: the hidden group first, collapsed, then the visible entries', () => {
    expect(shape(flattenTree(base))).toEqual(['0:[hidden 2]', '0:src', '0:README.md'])
    const [group] = flattenTree(base)
    expect(group).toMatchObject({ type: 'hidden', size: 910, isPartial: true })
  })

  test('an open folder lists below it, one level deeper, with its own hidden group', () => {
    const view = toggleHidden(toggleHidden(expand(base, '/repo/src'), '/repo'), '/repo/src')
    expect(shape(flattenTree(view))).toEqual([
      '0:[hidden 2 open]',
      '1:.git',
      '1:.env',
      '0:src (open)',
      '1:[hidden 1 open]',
      '2:.cache',
      '1:app.py',
      '0:README.md',
    ])
    expect(flattenTree(view).find(row => row.type === 'entry' && row.entry.name === 'app.py')?.path).toBe('/repo/src/app.py')
  })

  test('a folder loading, failing or holding more than was listed says so', () => {
    let view = setLoading(expand(base, '/repo/lib'), '/repo/lib', true)
    view = { ...view, listings: { ...view.listings, '/repo': { ...listing('/repo', [entry('lib', 'dir')]), total: 5, hiddenTotal: 2 } } }
    expect(shape(flattenTree(view))).toEqual(['0:[hidden 2]', '0:lib (open)', '1:Loading…', '0:… 2 more entries not listed'])
    view = withListing(view, '/repo/lib', { isOk: false, error: 'Permission denied' })
    expect(shape(flattenTree(view))[2]).toBe('1:Could not list this folder: Permission denied')
    expect(flattenTree({ ...EMPTY_TREE })).toEqual([])
  })

  test('permissions color r, w and x; sizes mark partial folders and big ones', () => {
    expect(modeParts('drwxr-x---')).toEqual([
      { text: 'd', color: 'claude', dim: false },
      { text: 'r', color: 'suggestion', dim: false },
      { text: 'w', color: 'warning', dim: false },
      { text: 'x', color: 'success', dim: false },
      { text: 'r', color: 'suggestion', dim: false },
      { text: '-', color: '', dim: true },
      { text: 'x', color: 'success', dim: false },
      { text: '---', color: '', dim: true },
    ])
    expect(modeParts('-rw-r--r--')[0]).toEqual({ text: '-', color: '', dim: true })
    expect(modeParts('lrwxrwxrwx')[0]?.color).toBe('merged')
    expect(sizeText(entry('a', 'dir', { size: 2_500_000, isPartial: true }))).toBe('≥2.50 MB')
    expect(sizeText(entry('a', 'file', { size: 1_200 }))).toBe('1.20 kB')
    expect(sizeText(entry('a', 'link'))).toBe('—')
    expect([sizeTone(5e6), sizeTone(2e8), sizeTone(3e9)]).toEqual(['', 'warning', 'error'])
  })
})

// ------------------------------------------------------------------------- //
// The pane
// ------------------------------------------------------------------------- //

const LISTINGS: Record<string, unknown> = {
  '/repo': {
    path: '/repo',
    entries: [
      { name: 'src', kind: 'dir', size: 2_500, isPartial: false, mode: 'drwxr-xr-x', mtimeMs: NOW - 60_000, isHidden: false },
      { name: 'README.md', kind: 'file', size: 1_200, isPartial: false, mode: '-rw-r--r--', mtimeMs: NOW - 5_000, isHidden: false },
      { name: 'latest', kind: 'link', size: 10, isPartial: false, mode: 'lrwxr-xr-x', mtimeMs: NOW - 5_000, isHidden: false, linkTarget: 'src/app.py' },
      { name: 'docs', kind: 'link', size: 7, isPartial: false, mode: 'lrwxr-xr-x', mtimeMs: NOW - 5_000, isHidden: false, linkTarget: '../docs' },
      { name: 'pipe', kind: 'other', size: 0, isPartial: false, mode: 'prw-r--r--', mtimeMs: NOW - 5_000, isHidden: false },
      { name: '.git', kind: 'dir', size: 3_000_000_000, isPartial: true, mode: 'drwxr-xr-x', mtimeMs: NOW - 5_000, isHidden: true },
      { name: '.env', kind: 'file', size: 12, isPartial: false, mode: '-rw-------', mtimeMs: NOW - 5_000, isHidden: true },
    ],
    total: 7,
    hiddenTotal: 2,
    truncated: false,
  },
  '/repo/src': {
    path: '/repo/src',
    entries: [{ name: 'app.py', kind: 'file', size: 2_500, isPartial: false, mode: '-rwxr-xr-x', mtimeMs: NOW - 5_000, isHidden: false }],
    total: 1,
    hiddenTotal: 0,
    truncated: false,
  },
}

type TreeWorld = { runs: string[][]; toasts: string[]; listings: Record<string, unknown>; clock: ReturnType<typeof world> }

/** The shared world, with the lister, `open`, the working folder and one file's text beneath it. */
const treeWorld = (on: On): TreeWorld => {
  const runs: string[][] = []
  const toasts: string[] = []
  const listings: Record<string, unknown> = { ...LISTINGS }
  // Beneath the world's own answers: the lister, `open`, and one file's text.
  on('process.run', { argv: /\/sampler\/tree\.py$/ }, ($, e) => {
    runs.push([...e.argv])
    const path = e.argv[3] ?? ''
    return { value: ok(JSON.stringify(listings[path] ?? { path, entries: [], error: 'No such file or directory' })) }
  })
  on('process.run', { argv: 'open' }, ($, e) => {
    runs.push([...e.argv])
    return { value: e.argv[1] === '-R' ? fail() : ok('') }
  })
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.read', { path: '/repo/README.md' }, () => ({ value: '# Read me\nhello tree' }))
  on('fs.stat', { path: '/repo/docs' }, () => ({ value: { kind: 'dir' as const, size: 0, mtimeMs: NOW, isLink: true } }))
  const clock = world(on, toasts)
  return { runs, toasts, listings, clock }
}

const listed = (runs: readonly string[][]): string[] =>
  runs.filter(argv => argv[2]?.endsWith('/sampler/tree.py') === true).map(argv => argv[3] ?? '')

test('files: the folder tree opens folders, hidden groups and files with a click', { timeoutMs: 20_000 }, async ($, on) => {
  const { runs, toasts, clock } = treeWorld(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:files' })
    expect(await ui.find({ key: 'files:activity' })).toBeDefined()
    await ui.press({ key: 'files:folder' })
    await clock.settle()
    // The working folder's card, titled by its name: folders first, with their size, permissions and time.
    const src = treeKey('/repo/src')
    expect((await textsIn(ui, TREE_CARD_KEY)).some(text => /📂 repo/.test(text))).toBe(true)
    expect(await ui.find({ in: src, type: 'Text', text: 'src' })).toBeDefined()
    expect(await ui.find({ in: src, type: 'Text', text: '▸ 📁' })).toBeDefined()
    expect(await ui.find({ in: src, type: 'Text', text: '2.50 kB' })).toBeDefined()
    expect(await ui.find({ in: src, type: 'Text', text: fmtClock(NOW - 60_000, NOW) })).toBeDefined()
    expect((await ui.find({ in: src, type: 'Text', text: /^d$/ }))?.props.color).toBe('claude')
    expect((await ui.find({ in: src, type: 'Text', text: /^w$/ }))?.props.color).toBe('warning')
    expect((await ui.find({ in: src, type: 'Text', text: /^x$/ }))?.props.color).toBe('success')
    expect(await ui.find({ in: treeKey('/repo/latest'), type: 'Text', text: 'latest ↪ src/app.py' })).toBeDefined()
    // Hidden entries wait in their own group, closed.
    expect(await ui.find({ in: hiddenKey('/repo'), type: 'Text', text: 'Hidden (2)' })).toBeDefined()
    expect(await ui.find({ in: hiddenKey('/repo'), type: 'Text', text: '≥3.00 GB' })).toBeDefined()
    expect((await ui.findAll({ type: 'Client' })).some(client => client.key === treeKey('/repo/.env'))).toBe(false)

    // A click on a folder lists it below.
    await clickRow(ui, src)
    await clock.settle()
    const app = treeKey('/repo/src/app.py')
    expect(await ui.find({ in: src, type: 'Text', text: '▾ 📂' })).toBeDefined()
    // A file's lead is its type's icon in its colour: a Python file's blue py.
    expect((await ui.findAll({ in: app, type: 'Text' })).find(text => text.text === 'py')?.props.color).toBe('#4b8bbe')
    expect(listed(runs)).toContain('/repo/src')
    expect(runs.find(argv => argv[3] === '/repo/src')?.slice(1, 6)).toEqual(['-I', expect.stringMatching(/\/sampler\/tree\.py$/), '/repo/src', '--root', '/repo'])

    // The hidden group opens.
    await clickRow(ui, hiddenKey('/repo'))
    const git = treeKey('/repo/.git')
    expect((await ui.find({ in: git, type: 'Text', text: '≥3.00 GB' }))?.props.color).toBe('error')
    expect(await ui.find({ in: treeKey('/repo/.env'), type: 'Text', text: '.env' })).toBeDefined()

    // A file shows its text, with buttons to open it in its app or in Finder.
    await clickRow(ui, treeKey('/repo/README.md'))
    await clock.settle()
    const readme = await shownCode(ui)
    expect(readme.kind).toBe(surface === 'terminal' ? 'code' : 'view')
    expect(readme.text).toContain('hello tree')
    await ui.press({ key: 'tree:open' })
    // A Markdown file opens in Cursor, as every code and text file does.
    expect(runs).toContainEqual(['open', '-a', 'Cursor', '/repo/README.md'])
    await ui.press({ key: 'tree:reveal' })
    expect(runs).toContainEqual(['open', '-R', '/repo/README.md'])
    expect(toasts.some(text => text.startsWith('Could not reveal README.md'))).toBe(true)

    // Closing: the folder, the group and the file, a press later each.
    await clock.advance(1_000)
    await clickRow(ui, src)
    await clickRow(ui, hiddenKey('/repo'))
    await clickRow(ui, treeKey('/repo/README.md'))
    expect((await ui.findAll({ type: 'Client' })).some(client => client.key === app || client.key === git)).toBe(false)
    expect((await shownCode(ui)).kind).toBe('none')
    await clock.advance(1_000)
    await ui.press({ key: 'files:activity' })
    expect(await keysOf(ui, TREE_CARD_KEY)).toEqual([])
  }
})

test("files: the folder is one card, with its figures, its buttons and the tree; a shown file is a card holding the tree's buttons", { timeoutMs: 20_000 }, async ($, on) => {
  const { clock } = treeWorld(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:files' })
    await ui.press({ key: 'files:folder' })
    await clock.settle()
    const props = (await ui.find({ key: TREE_CARD_KEY }))?.props
    expect(props?.borderStyle).toBe('round')
    expect(props?.backgroundColor).toBe(surface === 'desktop' ? CARD_BACKGROUND : undefined)
    // Titled by the folder, its path beside; five entries and two hidden, the .git folder still adding up.
    const card = (await textsIn(ui, TREE_CARD_KEY)).join('\n')
    expect(card).toMatch(/📂 repo\n\/repo\n/)
    expect(card).toContain('Items\n5\nHidden\n2\nSize\n≥3.00 GB\nListed')
    expect(card).toContain('[Refresh]\n[Collapse all]\n[Open in Finder]')
    // A file's text is the open file's card, with the tree's own buttons on a row of their own.
    await clickRow(ui, treeKey('/repo/README.md'))
    await clock.settle()
    expect((await ui.find({ key: DIFF_PANEL_KEY }))?.props.borderStyle).toBe('round')
    const shown = (await textsIn(ui, DIFF_PANEL_KEY)).join('\n')
    expect(shown).toContain('[Copy text]\n[Close]\ncurrent contents (no git diff for this file)\n[Open in Cursor]\n[Reveal in Finder]\n/repo/README.md')
    await clock.advance(1_000)
    await clickRow(ui, treeKey('/repo/README.md'))
    expect(await keysOf(ui, DIFF_PANEL_KEY)).toEqual([])
    await ui.press({ key: 'files:activity' })
    await clock.advance(1_000)
  }
})

test('files: the tree never acts outside the working folder, and lists again after a change', { timeoutMs: 20_000 }, async ($, on) => {
  const { runs, toasts, listings, clock } = treeWorld(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:files' })
  await ui.press({ key: 'files:folder' })
  await clock.settle()
  const src = treeKey('/repo/src')
  // A forged press for a path outside, or with `..`, does nothing.
  await ui.post({ kind: 'dir', id: '/etc', path: '/etc' }, { in: src })
  await ui.post({ kind: 'entry', id: '/repo/../etc/passwd', path: '/repo/../etc/passwd' }, { in: src })
  expect(listed(runs)).toEqual(['/repo'])
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  // Anything but a file, or a link to one, is not read: a named pipe would wait for ever.
  await clickRow(ui, treeKey('/repo/pipe'))
  await clickRow(ui, treeKey('/repo/docs'))
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /current contents/ })).toBeUndefined()
  expect(toasts).toContain('pipe is not a regular file (prw-r--r--): nothing to show as text.')
  expect(toasts).toContain('docs ↪ ../docs leads to a folder.')
  // A link to a file shows the file's text.
  await clickRow(ui, treeKey('/repo/latest'))
  expect(await ui.find({ type: 'Text', text: /current contents/ })).toBeDefined()
  await ui.press({ key: 'diff:close' })

  await clickRow(ui, src)
  await clock.settle()
  // A file tool's change lists the root and the open folder again, once.
  await call($, { tool: 'Write', file_path: '/repo/new.txt', content: 'x' })
  await call($, { tool: 'Bash', command: 'touch /repo/a', description: 'Touch' })
  await clock.advance(2_500)
  await clock.settle()
  expect(listed(runs)).toEqual(['/repo', '/repo/src', '/repo', '/repo/src'])
  // Not while another tab is on screen.
  await ui.press({ key: 'tab:commands' })
  await call($, { tool: 'Write', file_path: '/repo/other.txt', content: 'x' })
  await clock.advance(2_500)
  await clock.settle()
  expect(listed(runs).length).toBe(4)
  await ui.press({ key: 'tab:files' })
  // Refresh lists them again; an open folder that is gone since closes.
  delete listings['/repo/src']
  await ui.press({ key: 'tree:refresh' })
  await clock.settle()
  expect(listed(runs)).toEqual(['/repo', '/repo/src', '/repo', '/repo/src', '/repo', '/repo/src'])
  expect(await ui.find({ in: src, type: 'Text', text: '▸ 📁' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Could not list/ })).toBeUndefined()
  // An open folder that cannot be read says why, below it; collapse all closes it.
  listings['/repo/src'] = { path: '/repo/src', entries: [], error: 'Permission denied' }
  await clock.advance(1_000)
  await clickRow(ui, src)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /Could not list this folder: Permission denied/ })).toBeDefined()
  await ui.press({ key: 'tree:collapse' })
  expect(await ui.find({ type: 'Text', text: /Could not list/ })).toBeUndefined()
  expect(await ui.find({ in: src, type: 'Text', text: '▸ 📁' })).toBeDefined()
})

test('files: where no Client is drawn, a tree row is a title button and permissions plain text', { timeoutMs: 20_000 }, async ($, on) => {
  const { clock } = treeWorld(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.press({ key: 'tab:files' })
  await ui.press({ key: 'files:folder' })
  await clock.settle()
  /** The title button a row falls back to, found by its label (its key is the row's own). */
  const titled = async (label: string): Promise<string | undefined> =>
    (await ui.findAll({ type: 'Button' })).find(button => button.props.label === label && button.key?.startsWith('tree') === true)?.key
  const src = await titled('src')
  expect(src?.startsWith(treeKey('/repo/src'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: 'drwxr-xr-x' })).toBeDefined()
  await ui.press({ key: src ?? '' })
  await clock.settle()
  expect(await titled('app.py')).toBeDefined()
  expect(await titled('.env')).toBeUndefined()
  await ui.press({ key: (await titled('Hidden (2)')) ?? '' })
  expect((await titled('.env'))?.startsWith(treeKey('/repo/.env'))).toBe(true)
})

test('files: an open folder of 250 folders stays drawn on the desktop, whole, not the too-big notice; its switch and Collapse all with it, the note past the budget asks to close a folder, and a click closes it', { timeoutMs: 30_000 }, async ($, on) => {
  const { listings, clock } = treeWorld(on)
  const root = LISTINGS['/repo'] as { entries: unknown[]; total: number }
  const folder = (name: string): Record<string, unknown> => ({ name, kind: 'dir', size: 4_096, isPartial: false, mode: 'drwxr-xr-x', mtimeMs: NOW - 5_000, isHidden: false })
  listings['/repo'] = { ...root, entries: [folder('node_modules'), ...root.entries], total: root.total + 1 }
  const names = Array.from({ length: 250 }, (_, index) => `package-${String(index).padStart(3, '0')}`)
  listings['/repo/node_modules'] = { path: '/repo/node_modules', entries: names.map(folder), total: names.length, hiddenTotal: 0, truncated: false }
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 54 } })
  await ui.press({ key: 'tab:files' })
  await ui.press({ key: 'files:folder' })
  await clock.settle()
  const modules = treeKey('/repo/node_modules')
  await clickRow(ui, modules)
  await clock.settle()
  // Its rows' text runs past the engine's 100,000 characters, so the engine cuts it and the app draws what it sends.
  const drawn = await ui.drawn()
  // Held to the list budget, the tree leaves the engine nothing to cut.
  expect(JSON.stringify(drawn).includes('more characters, not drawn')).toBe(false)
  expect(isDesktopDrawn(desktopSizeOf(drawn))).toBe(true)
  // So the tab is drawn, not the notice: the open folder's row, Collapse all and the mode switch are all there.
  expect(await ui.find({ key: TOO_BIG_KEY })).toBeUndefined()
  expect((await ui.findAll({ type: 'Client' })).some(client => client.key === treeKey('/repo/node_modules/package-000'))).toBe(true)
  expect(await ui.find({ key: 'tree:collapse' })).toBeDefined()
  expect(await ui.find({ key: 'files:activity' })).toBeDefined()
  // The rows past the budget are the open folder's: closing it brings the rest of the folder back.
  expect(await ui.find({ type: 'Text', text: /^… \d+ more rows \(close a folder to see them\)$/ })).toBeDefined()
  // And the folder's row closes it again.
  await clock.advance(1_000)
  await clickRow(ui, modules)
  await clock.settle()
  expect((await ui.findAll({ type: 'Client' })).some(client => client.key === treeKey('/repo/node_modules/package-000'))).toBe(false)
  expect(await ui.find({ type: 'Text', text: /more rows/ })).toBeUndefined()
  await ui.unmount()
})
