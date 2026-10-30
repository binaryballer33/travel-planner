// File activity: what the session read, created, modified and deleted, from
// Claude's own tool calls and from git's view of the working tree (which also
// sees what shell commands changed).

import type { FileActivity, FileChange, FileStatus, TouchedFile } from '../../types'

export const MAX_TOUCHED = 400

const RANK: Record<FileActivity, number> = { read: 0, modified: 1, created: 2, deleted: 3 }

/** The stronger of two activities: deleted over created over modified over read. */
export const stronger = (a: FileActivity, b: FileActivity): FileActivity => (RANK[a] >= RANK[b] ? a : b)

export type TouchEvent = 'read' | 'created' | 'modified' | 'deleted'

/** Records one event against a file. A file created and then edited stays created. */
export const touch = (
  list: readonly TouchedFile[],
  path: string,
  event: TouchEvent,
  tool: string,
  now: number,
): TouchedFile[] => {
  const existing = list.find(file => file.path === path)
  const base: TouchedFile = existing ?? { path, activity: 'read', reads: 0, edits: 0, firstAt: now, lastAt: now, tools: [] }
  let activity: FileActivity
  if (event === 'read') {
    activity = existing === undefined ? 'read' : base.activity
  } else if (event === 'deleted') {
    activity = 'deleted'
  } else if (event === 'created') {
    activity = 'created'
  } else {
    activity = base.activity === 'created' ? 'created' : 'modified'
  }
  const entry: TouchedFile = {
    ...base,
    activity,
    reads: base.reads + (event === 'read' ? 1 : 0),
    edits: base.edits + (event === 'created' || event === 'modified' ? 1 : 0),
    lastAt: now,
    editedAt: event === 'read' ? base.editedAt : now,
    tools: base.tools.includes(tool) ? base.tools : [...base.tools, tool],
  }
  return [...list.filter(file => file.path !== path), entry].slice(-MAX_TOUCHED)
}

const latest = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.max(a, b)

const fromGit = (status: FileStatus): FileActivity => (status === 'A' ? 'created' : status === 'D' ? 'deleted' : 'modified')

export type FileRow = {
  path: string
  /** The path relative to the repository root when inside it. */
  display: string
  activity: FileActivity
  reads: number
  edits: number
  added: number
  removed: number
  isBinary: boolean
  /** The working tree's own record of the file, when git has one. */
  change?: FileChange
  tools: string[]
  lastAt: number
  /** When the file last changed: a Claude edit, or the time on disk for a change git sees. */
  editedAt?: number
}

/**
 * One row per file: Claude's tool activity, joined to the working tree's
 * changes by path. Git's view raises the activity (a file a command deleted
 * reads as deleted) and adds the files only commands changed.
 */
export const fileRows = (
  touched: readonly TouchedFile[],
  worktree: readonly FileChange[],
  root: string,
  gitUpdatedAt: number,
): FileRow[] => {
  const prefix = root === '' ? '' : `${root}/`
  const byPath = new Map(worktree.map(change => [`${prefix}${change.path}`, change]))
  const rows: FileRow[] = []
  for (const file of touched) {
    const change = byPath.get(file.path)
    byPath.delete(file.path)
    rows.push({
      path: file.path,
      display: prefix !== '' && file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path,
      activity: change !== undefined ? stronger(file.activity, fromGit(change.status)) : file.activity,
      reads: file.reads,
      edits: file.edits,
      added: change?.added ?? 0,
      removed: change?.removed ?? 0,
      isBinary: change?.isBinary ?? false,
      change,
      tools: file.tools,
      lastAt: file.lastAt,
      editedAt: latest(file.editedAt, change?.mtimeMs),
    })
  }
  for (const [path, change] of byPath) {
    rows.push({
      path,
      display: change.path,
      activity: fromGit(change.status),
      reads: 0,
      edits: 0,
      added: change.added,
      removed: change.removed,
      isBinary: change.isBinary,
      change,
      tools: ['working tree'],
      lastAt: change.mtimeMs ?? gitUpdatedAt,
      editedAt: change.mtimeMs,
    })
  }
  return rows.sort((a, b) => b.lastAt - a.lastAt || a.display.localeCompare(b.display))
}

export const countActivity = (rows: readonly FileRow[]): Record<FileActivity, number> => {
  const counts: Record<FileActivity, number> = { created: 0, modified: 0, deleted: 0, read: 0 }
  for (const row of rows) {
    counts[row.activity] += 1
  }
  return counts
}
