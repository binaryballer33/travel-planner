// The Explorer tab: the project folder as an editor's tree, the way VS Code's
// explorer shows it (folders first, then files, each by name ignoring case,
// hidden entries inline, what git ignores dim), and the checks behind
// creating, renaming, editing and deleting from it. Pure: no `$`.

import type { FsEntry } from 'claude-code'

import type { ExplorerArmed, ExplorerForm, ExplorerView, TreeEntry, TreeListing } from '../../types'
import type { Tone } from './format'
import { openLabel } from './apps'
import { baseName, childPath, collapse, EMPTY_TREE, findEntry, isBelow, isEntryName, isInsideRoot, isTop, parentOf } from './tree'

export const EMPTY_EXPLORER: ExplorerView = { tree: EMPTY_TREE, selected: null, form: null, edit: null, armed: null, ignored: {} }

/** What the tree leaves out, as VS Code's `files.exclude` does by default. */
export const EXCLUDED_NAMES: ReadonlySet<string> = new Set(['.git', '.svn', '.hg', 'CVS', '.DS_Store', 'Thumbs.db'])

/** Entries kept per folder; a folder holding more says how many it left out. */
export const EXPLORER_MAX_ENTRIES = 500

/** The rows drawn at most; the pane's list budget (lib/fit.ts) cuts sooner where rows are heavy. */
export const MAX_EXPLORER_ROWS = 300

/**
 * The most text the editor takes. The engine draws a tree's field values up
 * to 100,000 characters and starts a longer one from its head, and the pane
 * has bounds of its own (view/pane.tsx PANE_SAFE), so a bigger file opens in
 * its app instead.
 */
export const EDIT_MAX_CHARS = 60_000

/** How long a first press of Delete or Discard waits for the second. */
export const EXPLORER_ARM_MS = 6_000

/** The editor's height in lines: the file's own, within these. */
export const EDIT_MIN_ROWS = 6
export const EDIT_MAX_ROWS = 28

/**
 * Apple's `trash` (macOS 14 and later), which moves to the Finder's Trash so
 * Put Back works. Named by its path: a `trash` earlier on PATH (Homebrew's
 * trash-cli) keeps a trash folder of its own.
 */
export const TRASH_PATH = '/usr/bin/trash'

/** What a drawing of the tab takes: the tree's state and the text typed into its fields, which live outside the state so typing does not redraw. */
export type ExplorerPane = {
  view: ExplorerView
  /** The open form's text as typed. */
  formText: string
  /** The editor's text as typed; null while nothing was typed since it opened or saved. */
  editText: string | null
  /** The engine draws a field of several lines (`rows`), so files are edited here. */
  canEdit: boolean
}

/**
 * The first engine known to draw a field of several lines (InputProps
 * `rows`). An engine without it refuses a whole drawing that names it, so
 * before this one the editor is not offered and files open in their app.
 */
export const MULTILINE_SINCE: readonly number[] = [2, 1, 308]

/** Whether a version (`2.1.308`, `2.1.308-dev.…`) is `since` or later; an unreadable one is not. */
export const isAtLeast = (version: string | undefined, since: readonly number[]): boolean => {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '')
  if (parts === null) {
    return false
  }
  const numbers = parts.slice(1).map(Number)
  for (let index = 0; index < since.length; index += 1) {
    const have = numbers[index] ?? 0
    const want = since[index] ?? 0
    if (have !== want) {
      return have > want
    }
  }
  return true
}

// ------------------------------------------------------------------------- //
// Listing
// ------------------------------------------------------------------------- //

/**
 * Names in a natural order, ignoring case: `file2` before `file10`, `.env`
 * before `apps`, then by the exact name so the order is total.
 */
export const compareNames = (a: string, b: string): number => {
  const left = a.toLowerCase().split(/(\d+)/)
  const right = b.toLowerCase().split(/(\d+)/)
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const x = left[index] ?? ''
    const y = right[index] ?? ''
    if (x === y) {
      continue
    }
    // Splitting on a captured group puts the digit runs at the odd places.
    if (index % 2 === 1) {
      const byValue = Number(x) - Number(y)
      return byValue !== 0 ? byValue : x.length - y.length
    }
    return x < y ? -1 : 1
  }
  if (left.length !== right.length) {
    return left.length - right.length
  }
  return a < b ? -1 : a > b ? 1 : 0
}

/** Folders first, then everything else, each by name. */
export const compareEntries = (a: TreeEntry, b: TreeEntry): number => {
  const rank = (entry: TreeEntry): number => (entry.kind === 'dir' ? 0 : 1)
  return rank(a) - rank(b) || compareNames(a.name, b.name)
}

/** One entry `$.fs.list` read, as the tree keeps it: a symbolic link is a link, never followed. */
export const entryOf = (entry: FsEntry): TreeEntry => ({
  name: entry.name,
  kind: entry.isLink ? 'link' : entry.kind,
  size: entry.kind === 'file' ? entry.size : 0,
  isPartial: false,
  mode: '',
  mtimeMs: entry.mtimeMs,
  isHidden: entry.name.startsWith('.'),
})

/** A folder's listing from `$.fs.list`: the excluded names left out, sorted, at most EXPLORER_MAX_ENTRIES kept. */
export const listingOf = (path: string, entries: readonly FsEntry[], now: number): TreeListing => {
  const kept = entries
    .filter(entry => isEntryName(entry.name) && !EXCLUDED_NAMES.has(entry.name))
    .map(entryOf)
    .sort(compareEntries)
  const shown = kept.slice(0, EXPLORER_MAX_ENTRIES)
  return {
    path,
    entries: shown,
    total: kept.length,
    hiddenTotal: kept.filter(entry => entry.isHidden).length,
    isTruncated: shown.length < kept.length,
    loadedAt: now,
  }
}

/** `git check-ignore` for one folder's names, read from its standard input, NUL-separated both ways. */
export const ignoreArgv = (dir: string): string[] => ['git', '-C', dir, 'check-ignore', '--stdin', '-z']

/** The names `git check-ignore` printed, of those it was asked about. */
export const ignoredNames = (stdout: string, asked: readonly string[]): string[] => {
  const wanted = new Set(asked)
  return [...new Set(stdout.split('\u0000').filter(name => wanted.has(name)))]
}

// ------------------------------------------------------------------------- //
// Rows
// ------------------------------------------------------------------------- //

export type ExplorerRow =
  | { type: 'entry'; path: string; depth: number; entry: TreeEntry; isOpen: boolean; isIgnored: boolean }
  | { type: 'note'; path: string; depth: number; text: string; tone: Tone | '' }

export type ExplorerEntryRow = Extract<ExplorerRow, { type: 'entry' }>

/**
 * The open folders as rows, from the root's entries down, each open folder's
 * rows right below it. An entry is ignored when git ignores it or a folder
 * above it.
 */
export const explorerRows = (view: ExplorerView): ExplorerRow[] => {
  const { tree } = view
  const rows: ExplorerRow[] = []
  const expanded = new Set(tree.expanded)
  const loading = new Set(tree.loading)
  const walk = (dir: string, depth: number, isUnderIgnored: boolean): void => {
    const listing = tree.listings[dir]
    const error = tree.errors[dir]
    if (error !== undefined) {
      rows.push({ type: 'note', path: dir, depth, text: `Could not list this folder: ${error}`, tone: 'error' })
    }
    if (listing === undefined) {
      if (error === undefined && loading.has(dir)) {
        rows.push({ type: 'note', path: dir, depth, text: 'Loading…', tone: 'warning' })
      }
      return
    }
    const ignored = new Set(view.ignored[dir] ?? [])
    for (const entry of listing.entries) {
      const path = childPath(dir, entry.name)
      if (path === undefined) {
        continue
      }
      const isOpen = entry.kind === 'dir' && expanded.has(path)
      const isIgnored = isUnderIgnored || ignored.has(entry.name)
      rows.push({ type: 'entry', path, depth, entry, isOpen, isIgnored })
      if (isOpen) {
        walk(path, depth + 1, isIgnored)
      }
    }
    if (listing.isTruncated) {
      rows.push({ type: 'note', path: dir, depth, text: `… ${listing.total - listing.entries.length} more entries not listed: Open in Finder shows them all`, tone: '' })
    }
    if (listing.total === 0 && error === undefined && depth > 0) {
      rows.push({ type: 'note', path: dir, depth, text: 'Empty', tone: '' })
    }
  }
  if (tree.root !== '') {
    walk(tree.root, 0, false)
  }
  return rows
}

// ------------------------------------------------------------------------- //
// Names and paths
// ------------------------------------------------------------------------- //

export type Checked = { isOk: true; path: string } | { isOk: false; reason: string }

const CONTROL = /[\u0000-\u001f\u007f]/

/** A path as the tree names it: below the root, or the root's own name. */
export const relPath = (root: string, path: string): string => {
  if (path === root) {
    return baseName(root)
  }
  return isBelow(root, path) ? path.slice(isTop(root) ? root.length : root.length + 1) : path
}

/** The tab's title: the project folder's name in capitals, as an editor's explorer heads it. */
export const projectTitle = (root: string): string => baseName(root).toUpperCase()

/**
 * Where a typed name puts a new entry of folder `dir`: one name, or names
 * joined by `/`, the folders on the way made too. Leading and trailing
 * spaces and slashes are dropped; `.`, `..`, an empty part or a control
 * character is refused.
 */
export const newEntryPath = (root: string, dir: string, typed: string): Checked => {
  const text = typed.trim().replace(/^\/+|\/+$/g, '')
  if (text === '') {
    return { isOk: false, reason: 'Type a name first.' }
  }
  if (CONTROL.test(text)) {
    return { isOk: false, reason: 'A name cannot hold control characters or line breaks.' }
  }
  const parts = text.split('/')
  if (parts.some(part => !isEntryName(part) || part.trim() !== part)) {
    return { isOk: false, reason: 'Each part of the name needs a name: no “.”, “..”, empty parts or spaces around a “/”.' }
  }
  if (!isInsideRoot(root, dir)) {
    return { isOk: false, reason: 'New entries go only inside the project folder.' }
  }
  const path = parts.reduce((at, part) => `${isTop(at) ? at : `${at}/`}${part}`, dir)
  return isInsideRoot(root, path) ? { isOk: true, path } : { isOk: false, reason: 'New entries go only inside the project folder.' }
}

/**
 * The path a rename gives `path`: a new name in the same folder. The same
 * name is no rename (its reason is empty: the form just closes).
 */
export const renamedPath = (root: string, path: string, typed: string): Checked => {
  const name = typed.trim()
  if (path === root || !isInsideRoot(root, path)) {
    return { isOk: false, reason: 'Only entries inside the project folder can be renamed.' }
  }
  if (name === '') {
    return { isOk: false, reason: 'Type a name first.' }
  }
  if (name.includes('/')) {
    return { isOk: false, reason: 'A new name cannot hold “/”: Rename keeps the entry in its folder.' }
  }
  if (CONTROL.test(name) || !isEntryName(name)) {
    return { isOk: false, reason: 'That name is not allowed: no “.”, “..”, control characters or line breaks.' }
  }
  if (name === baseName(path)) {
    return { isOk: false, reason: '' }
  }
  const renamed = childPath(parentOf(path), name)
  return renamed === undefined ? { isOk: false, reason: 'That name is not allowed.' } : { isOk: true, path: renamed }
}

/** A rename that changes only letters' case: on the Mac's usual disk the new name "exists" already, as the old one. */
export const isCaseOnly = (from: string, to: string): boolean => from !== to && from.toLowerCase() === to.toLowerCase()

/** The folders a new entry at `path` sits in, from `dir` down: `dir`, then each folder made on the way. */
export const foldersDown = (dir: string, path: string): string[] => {
  const between: string[] = []
  for (let at = parentOf(path); at !== dir && isBelow(dir, at); at = parentOf(at)) {
    between.unshift(at)
  }
  return [dir, ...between]
}

/** The folder New file and New folder make their entry in: the selected folder, the selected file's folder, else the root. */
export const targetDir = (view: ExplorerView): string => {
  const { selected, tree } = view
  if (selected === null || selected === tree.root || !isInsideRoot(tree.root, selected)) {
    return tree.root
  }
  return findEntry(tree, selected)?.kind === 'dir' ? selected : parentOf(selected)
}

/** The entry a form is drawn under: the folder it makes an entry in, or the entry it renames. */
export const formAnchor = (form: ExplorerForm): string => (form.kind === 'rename' ? form.path : form.dir)

// ------------------------------------------------------------------------- //
// The editor's text
// ------------------------------------------------------------------------- //

/** A file's text as the field holds it: lines joined by `\n`, as the field gives them back. */
export const toField = (text: string): string => text.replace(/\r\n/g, '\n')

/** The field's text as the file keeps it: in Windows line ends again where the file had them. */
export const fromField = (typed: string, original: string): string => (original.includes('\r\n') ? typed.replace(/\r?\n/g, '\r\n') : typed)

/** How many lines tall the editor is: the text's lines and one more, within EDIT_MIN_ROWS and EDIT_MAX_ROWS. */
export const editRows = (text: string): number => Math.max(EDIT_MIN_ROWS, Math.min(EDIT_MAX_ROWS, text.split('\n').length + 1))

/** Why a file's text is not edited here; undefined when it can be. */
export const uneditableReason = (name: string, size: number, text?: string): string | undefined => {
  if (size > EDIT_MAX_CHARS * 4 || (text !== undefined && text.length > EDIT_MAX_CHARS)) {
    return `${name} is too big to edit here (over ${EDIT_MAX_CHARS.toLocaleString('en-US')} characters): ${openLabel(name)} edits it.`
  }
  if (text !== undefined && text.includes('\u0000')) {
    return `${name} is not a text file: ${openLabel(name)} opens it.`
  }
  return undefined
}

// ------------------------------------------------------------------------- //
// State changes
// ------------------------------------------------------------------------- //

const pick = <V>(record: Readonly<Record<string, V>>, keep: (path: string) => boolean): Record<string, V> =>
  Object.fromEntries(Object.entries(record).filter(([path]) => keep(path)))

/** The tree for project folder `root`: kept, or started afresh when the session's folder changed. */
export const explorerFor = (view: ExplorerView, root: string): ExplorerView =>
  view.tree.root === root ? view : { ...EMPTY_EXPLORER, tree: { ...EMPTY_TREE, root } }

/** Selects an entry (null: none). Another selection closes the open form and disarms Delete. */
export const withSelected = (view: ExplorerView, path: string | null): ExplorerView =>
  view.selected === path ? view : { ...view, selected: path, form: null, armed: null }

/** `path` as it reads once `from` is renamed `to`: itself, or moved with it. */
export const movedPath = (path: string, from: string, to: string): string =>
  path === from ? to : isBelow(from, path) ? `${to}${path.slice(from.length)}` : path

/**
 * After `from` was renamed `to`: open folders, the selection and the editor
 * follow it; listings at or below it are dropped, to be listed again under
 * the new name.
 */
export const withRenamed = (view: ExplorerView, from: string, to: string): ExplorerView => {
  const isOld = (path: string): boolean => path === from || isBelow(from, path)
  const { tree } = view
  return {
    ...view,
    tree: {
      ...tree,
      expanded: tree.expanded.map(path => movedPath(path, from, to)),
      listings: pick(tree.listings, path => !isOld(path)),
      errors: pick(tree.errors, path => !isOld(path)),
      loading: tree.loading.filter(path => !isOld(path)),
    },
    selected: view.selected === null ? null : movedPath(view.selected, from, to),
    edit: view.edit === null ? null : { ...view.edit, path: movedPath(view.edit.path, from, to) },
    form: null,
    armed: null,
    ignored: pick(view.ignored, path => !isOld(path)),
  }
}

/** After `path` was deleted: it and everything below it close; a selection, form or editor there goes. */
export const withRemoved = (view: ExplorerView, path: string): ExplorerView => {
  const isGone = (one: string): boolean => one === path || isBelow(path, one)
  return {
    ...view,
    tree: collapse(view.tree, path),
    selected: view.selected !== null && isGone(view.selected) ? null : view.selected,
    edit: view.edit !== null && isGone(view.edit.path) ? null : view.edit,
    form: view.form !== null && isGone(formAnchor(view.form)) ? null : view.form,
    armed: null,
    ignored: pick(view.ignored, one => !isGone(one)),
  }
}

/** The armed key of an entry's Delete, and of the editor's Discard. */
export const deleteKey = (path: string): string => `delete:${path}`
export const discardKey = (path: string): string => `discard:${path}`

/** Whether `key` was pressed once less than EXPLORER_ARM_MS ago, so the next press acts. */
export const isArmedFor = (armed: ExplorerArmed | null, key: string, now: number): boolean =>
  armed !== null && armed.key === key && now - armed.at >= 0 && now - armed.at < EXPLORER_ARM_MS

/** A press of a two-press button: the first arms it, a second within EXPLORER_ARM_MS acts. */
export const armStep = (armed: ExplorerArmed | null, key: string, now: number): { isConfirmed: boolean; armed: ExplorerArmed | null } =>
  isArmedFor(armed, key, now) ? { isConfirmed: true, armed: null } : { isConfirmed: false, armed: { key, at: now } }

/** What `trash` said went wrong, in a line: the system's message where it gave one. */
export const trashReason = (stderr: string, exitCode: number): string => {
  const text = stderr.trim()
  const said = /"([^"]+)"/.exec(text)?.[1]
  if (said !== undefined) {
    return said
  }
  return text === '' ? `exit code ${exitCode}` : text.replace(/^.*?\]\s*#?\s*/, '')
}

// ------------------------------------------------------------------------- //
// Presses
// ------------------------------------------------------------------------- //

/** What an Explorer row opens: a folder (it opens or closes), or anything else (it shows its text). */
export const EXPLORER_PRESS_KINDS = ['xdir', 'xfile'] as const
export type ExplorerPressKind = (typeof EXPLORER_PRESS_KINDS)[number]
export type ExplorerPress = { kind: ExplorerPressKind; id: string; path: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** What an Explorer row posted, when it is one's press. */
export const readExplorerPress = (data: unknown): ExplorerPress | undefined => {
  if (!isRecord(data) || typeof data.id !== 'string' || typeof data.path !== 'string') {
    return undefined
  }
  const kind = EXPLORER_PRESS_KINDS.find(one => one === data.kind)
  return kind === undefined ? undefined : { kind, id: data.id, path: data.path }
}
