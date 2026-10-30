// The Files tab's folder tree: guarding paths, reading `sampler/tree.py`'s
// answer, the tree's state changes, and flattening the expanded folders into
// the rows the pane draws. Pure: no `$`.

import type { TreeEntry, TreeEntryKind, TreeListing, TreeView } from '../../types'
import { fmtBytes, type Tone } from './format'

/** The lister, under the plugin's root. */
export const TREE_SCRIPT = 'sampler/tree.py'
/** The time one listing may spend adding up folder sizes. */
export const TREE_BUDGET_MS = 1_500
/** Visible and hidden entries are each capped at this per folder. */
export const TREE_MAX_ENTRIES = 400
/** The rows the pane draws at most: it draws about 100k characters in all. */
export const MAX_TREE_ROWS = 250

export const EMPTY_TREE: TreeView = { mode: 'activity', root: '', expanded: [], hiddenOpen: [], listings: {}, loading: [], errors: {} }

/** What a tree row opens: a folder (expand), a file or link (its text), a folder's hidden group. */
export const TREE_PRESS_KINDS = ['dir', 'entry', 'hidden'] as const
export type TreePressKind = (typeof TREE_PRESS_KINDS)[number]
export type TreePress = { kind: TreePressKind; id: string; path: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// ------------------------------------------------------------------------- //
// Paths
// ------------------------------------------------------------------------- //

/** A name an entry of a folder can have: never a path, `.` or `..`. */
export const isEntryName = (name: string): boolean =>
  name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\u0000')

/** `root`, or a path below it spelled without `.`, `..` or empty parts. */
export const isInsideRoot = (root: string, path: string): boolean => {
  if (!root.startsWith('/') || !path.startsWith('/') || root.includes('\u0000') || path.includes('\u0000')) {
    return false
  }
  const rootParts = root === '/' ? [] : root.split('/').slice(1)
  if (rootParts.some(part => !isEntryName(part))) {
    return false
  }
  if (path === root) {
    return true
  }
  const prefix = root === '/' ? '/' : `${root}/`
  return path.startsWith(prefix) && path.slice(prefix.length).split('/').every(isEntryName)
}

/** The path of entry `name` of folder `dir`, or undefined for a name no entry has. */
export const childPath = (dir: string, name: string): string | undefined =>
  isEntryName(name) ? `${dir === '/' ? '' : dir}/${name}` : undefined

/** True when `path` lies below `dir` (not `dir` itself). */
export const isBelow = (dir: string, path: string): boolean => path !== dir && path.startsWith(dir === '/' ? '/' : `${dir}/`)

/** The last part of a path: `/a/b` reads `b`, `/` reads `/`. */
export const baseName = (path: string): string => (path === '/' ? '/' : (path.split('/').pop() ?? path))

/** The folder a path lies in: `/a/b` lies in `/a`, `/a` in `/`. */
export const parentOf = (path: string): string => {
  const cut = path.lastIndexOf('/')
  return cut <= 0 ? '/' : path.slice(0, cut)
}

/** The listed entry at `path`, from its folder's listing. */
export const findEntry = (view: TreeView, path: string): TreeEntry | undefined => {
  const name = baseName(path)
  return view.listings[parentOf(path)]?.entries.find(entry => entry.name === name)
}

/** The lister's command line for one folder. */
export const treeArgv = (python: string, script: string, root: string, path: string, budgetMs: number = TREE_BUDGET_MS): string[] => [
  python,
  '-I',
  script,
  path,
  '--root',
  root,
  '--budget-ms',
  String(budgetMs),
  '--max-entries',
  String(TREE_MAX_ENTRIES),
]

// ------------------------------------------------------------------------- //
// The lister's answer
// ------------------------------------------------------------------------- //

const KINDS: readonly TreeEntryKind[] = ['dir', 'file', 'link', 'other']
const MODE = /^[-?a-zA-Z][-rwxsStT]{9}[@+.]?$/

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0)

const readEntry = (value: unknown): TreeEntry | undefined => {
  if (!isRecord(value) || typeof value.name !== 'string' || !isEntryName(value.name)) {
    return undefined
  }
  const kind = KINDS.find(one => one === value.kind)
  if (kind === undefined) {
    return undefined
  }
  const entry: TreeEntry = {
    name: value.name,
    kind,
    size: count(value.size),
    isPartial: value.isPartial === true,
    mode: typeof value.mode === 'string' && MODE.test(value.mode) ? value.mode : '?---------',
    mtimeMs: count(value.mtimeMs),
    isHidden: value.name.startsWith('.'),
  }
  if (typeof value.linkTarget === 'string') {
    entry.linkTarget = value.linkTarget
  }
  if (typeof value.error === 'string' && value.error !== '') {
    entry.error = value.error
  }
  return entry
}

export type ParsedListing = { isOk: true; listing: TreeListing } | { isOk: false; error: string }

/** `sampler/tree.py`'s one JSON object for folder `path`, checked field by field. */
export const parseListing = (stdout: string, path: string, now: number): ParsedListing => {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    return { isOk: false, error: stdout.trim() === '' ? 'The lister printed nothing.' : 'The lister’s answer is not JSON.' }
  }
  if (!isRecord(parsed)) {
    return { isOk: false, error: 'The lister’s answer is not an object.' }
  }
  if (typeof parsed.error === 'string' && parsed.error !== '') {
    return { isOk: false, error: parsed.error }
  }
  if (!Array.isArray(parsed.entries)) {
    return { isOk: false, error: 'The lister’s answer has no entries.' }
  }
  const entries: TreeEntry[] = []
  for (const value of parsed.entries) {
    const entry = readEntry(value)
    if (entry !== undefined) {
      entries.push(entry)
    }
  }
  const hiddenTotal = Math.max(count(parsed.hiddenTotal), entries.filter(entry => entry.isHidden).length)
  return {
    isOk: true,
    listing: {
      path,
      entries,
      total: Math.max(count(parsed.total), entries.length),
      hiddenTotal,
      isTruncated: parsed.truncated === true,
      loadedAt: now,
    },
  }
}

// ------------------------------------------------------------------------- //
// State changes
// ------------------------------------------------------------------------- //

const without = (list: readonly string[], dir: string): string[] => list.filter(path => path !== dir && !isBelow(dir, path))

const pick = <V>(record: Readonly<Record<string, V>>, keep: (path: string) => boolean): Record<string, V> => {
  const out: Record<string, V> = {}
  for (const [path, value] of Object.entries(record)) {
    if (keep(path)) {
      out[path] = value
    }
  }
  return out
}

/** The tree for working folder `root`: kept as it is, or started afresh when the folder changed. */
export const forRoot = (view: TreeView, root: string): TreeView => (view.root === root ? view : { ...EMPTY_TREE, mode: view.mode, root })

/** Opens a folder; its listing arrives later. */
export const expand = (view: TreeView, dir: string): TreeView =>
  view.expanded.includes(dir) ? view : { ...view, expanded: [...view.expanded, dir] }

/** Closes a folder and everything open below it, dropping their listings to keep the state small. */
export const collapse = (view: TreeView, dir: string): TreeView => {
  const isGone = (path: string): boolean => path === dir || isBelow(dir, path)
  return {
    ...view,
    expanded: without(view.expanded, dir),
    hiddenOpen: view.hiddenOpen.filter(path => !isBelow(dir, path) && path !== dir),
    listings: pick(view.listings, path => !isGone(path)),
    errors: pick(view.errors, path => !isGone(path)),
  }
}

/** Closes every folder but the root. */
export const collapseAll = (view: TreeView): TreeView => ({
  ...view,
  expanded: [],
  hiddenOpen: view.hiddenOpen.filter(path => path === view.root),
  listings: pick(view.listings, path => path === view.root),
  errors: pick(view.errors, path => path === view.root),
})

export const toggleHidden = (view: TreeView, dir: string): TreeView => ({
  ...view,
  hiddenOpen: view.hiddenOpen.includes(dir) ? view.hiddenOpen.filter(path => path !== dir) : [...view.hiddenOpen, dir],
})

/** Whether the tree still wants a listing of `dir`: the root, or an open folder. */
export const isWanted = (view: TreeView, dir: string): boolean => dir === view.root || view.expanded.includes(dir)

export const setLoading = (view: TreeView, dir: string, isLoading: boolean): TreeView => {
  const rest = view.loading.filter(path => path !== dir)
  return { ...view, loading: isLoading && isWanted(view, dir) ? [...rest, dir] : rest }
}

/** Stores a listing (or why there is none), only for a folder still open. */
export const withListing = (view: TreeView, dir: string, parsed: ParsedListing): TreeView => {
  const settled = setLoading(view, dir, false)
  if (!isWanted(settled, dir)) {
    return settled
  }
  if (parsed.isOk) {
    return { ...settled, listings: { ...settled.listings, [dir]: parsed.listing }, errors: pick(settled.errors, path => path !== dir) }
  }
  return { ...settled, errors: { ...settled.errors, [dir]: parsed.error } }
}

/** The folders to list again on a refresh: the root, then each open folder, parents first. */
export const listedFolders = (view: TreeView): string[] =>
  view.root === ''
    ? []
    : [view.root, ...[...view.expanded].filter(dir => isInsideRoot(view.root, dir) && dir !== view.root).sort((a, b) => a.split('/').length - b.split('/').length)]

// ------------------------------------------------------------------------- //
// Rows
// ------------------------------------------------------------------------- //

export type TreeRow =
  | { type: 'entry'; path: string; depth: number; entry: TreeEntry; isOpen: boolean }
  | { type: 'hidden'; path: string; depth: number; count: number; size: number; isPartial: boolean; isOpen: boolean }
  | { type: 'note'; path: string; depth: number; text: string; tone: Tone | '' }

/**
 * The expanded tree as rows, from the root's entries down: in each folder its
 * hidden group first (its entries only while it is open), then the visible
 * entries, an open folder's rows right below it.
 */
export const flattenTree = (view: TreeView): TreeRow[] => {
  const rows: TreeRow[] = []
  const expanded = new Set(view.expanded)
  const hiddenOpen = new Set(view.hiddenOpen)
  const loading = new Set(view.loading)
  const walk = (dir: string, depth: number): void => {
    const listing = view.listings[dir]
    const error = view.errors[dir]
    if (error !== undefined) {
      rows.push({ type: 'note', path: dir, depth, text: `Could not list this folder: ${error}`, tone: 'error' })
    }
    if (listing === undefined) {
      if (error === undefined && loading.has(dir)) {
        rows.push({ type: 'note', path: dir, depth, text: 'Loading…', tone: 'warning' })
      }
      return
    }
    const push = (entry: TreeEntry, at: number): void => {
      const path = childPath(dir, entry.name)
      if (path === undefined) {
        return
      }
      const isOpen = entry.kind === 'dir' && expanded.has(path)
      rows.push({ type: 'entry', path, depth: at, entry, isOpen })
      if (isOpen) {
        walk(path, at + 1)
      }
    }
    const hidden = listing.entries.filter(entry => entry.isHidden)
    const visible = listing.entries.filter(entry => !entry.isHidden)
    if (listing.hiddenTotal > 0) {
      const isOpen = hiddenOpen.has(dir)
      rows.push({
        type: 'hidden',
        path: dir,
        depth,
        count: listing.hiddenTotal,
        size: hidden.reduce((sum, entry) => sum + entry.size, 0),
        isPartial: hidden.length < listing.hiddenTotal || hidden.some(entry => entry.isPartial || entry.error !== undefined),
        isOpen,
      })
      if (isOpen) {
        hidden.forEach(entry => push(entry, depth + 1))
        if (hidden.length < listing.hiddenTotal) {
          rows.push({ type: 'note', path: dir, depth: depth + 1, text: `… ${listing.hiddenTotal - hidden.length} more hidden entries not listed`, tone: '' })
        }
      }
    }
    visible.forEach(entry => push(entry, depth))
    const visibleTotal = listing.total - listing.hiddenTotal
    if (visible.length < visibleTotal) {
      rows.push({ type: 'note', path: dir, depth, text: `… ${visibleTotal - visible.length} more entries not listed`, tone: '' })
    }
  }
  if (view.root !== '') {
    walk(view.root, 0)
  }
  return rows
}

// ------------------------------------------------------------------------- //
// Cells
// ------------------------------------------------------------------------- //

/** A run of characters of one color. */
export type ModePart = { text: string; color: Tone | ''; dim: boolean }

const permissionTone = (char: string, index: number): { color: Tone | ''; dim: boolean } => {
  if (char === '-') {
    return { color: '', dim: true }
  }
  if (index === 0) {
    return { color: char === 'd' ? 'claude' : char === 'l' ? 'merged' : 'permission', dim: false }
  }
  if (char === 'r') {
    return { color: 'suggestion', dim: false }
  }
  if (char === 'w') {
    return { color: 'warning', dim: false }
  }
  if (char === 'x' || char === 's' || char === 't') {
    return { color: 'success', dim: false }
  }
  return { color: 'error', dim: false }
}

/** `drwxr-xr-x` in runs of one color: r suggestion, w warning, x success, `-` dim. */
export const modeParts = (mode: string): ModePart[] => {
  const parts: ModePart[] = []
  Array.from(mode).forEach((char, index) => {
    const tone = permissionTone(char, index)
    const last = parts[parts.length - 1]
    if (last !== undefined && last.color === tone.color && last.dim === tone.dim) {
      last.text += char
    } else {
      parts.push({ text: char, ...tone })
    }
  })
  return parts
}

/** A file's bytes, a folder's total (`≥` while partial), `—` for a link or anything else. */
export const sizeText = (entry: TreeEntry): string => {
  if (entry.kind === 'dir') {
    return `${entry.isPartial ? '≥' : ''}${fmtBytes(entry.size)}`
  }
  return entry.kind === 'file' ? fmtBytes(entry.size) : '—'
}

/** Large sizes stand out: 100 MB a warning, 1 GB an error. */
export const sizeTone = (bytes: number): Tone | '' => (bytes >= 1e9 ? 'error' : bytes >= 100e6 ? 'warning' : '')

/** The disclosure and icon before a name. */
export const entryGlyph = (kind: TreeEntryKind, isOpen: boolean): string =>
  kind === 'dir' ? (isOpen ? '▾ 📂' : '▸ 📁') : kind === 'link' ? '  🔗' : kind === 'file' ? '  📄' : '  ⚙️'

/** What a tree row posted, when it is a tree row's press. */
export const readTreePress = (data: unknown): TreePress | undefined => {
  if (!isRecord(data) || typeof data.id !== 'string' || typeof data.path !== 'string') {
    return undefined
  }
  const kind = TREE_PRESS_KINDS.find(one => one === data.kind)
  return kind === undefined ? undefined : { kind, id: data.id, path: data.path }
}
