// Git: parsing porcelain status, logs with per-file stats, and diffs a Code
// element can draw. Commands go through a runner so tests can stand in for git.

import type { CommitInfo, CommitScope, DiffMode, FileChange, FileStatus, GitView } from '../../types'

export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type GitRun = (argv: readonly string[]) => Promise<RunResult>

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
export const WORKTREE = 'WORKTREE'
const MAX_UNTRACKED_STATS = 40
const LOG_LIMIT = 60

type Stat = { added: number; removed: number; isBinary: boolean }

export type StatusSnapshot = {
  head: string
  branch: string
  upstream?: string
  ahead: number
  behind: number
  entries: FileChange[]
}

const letterFromXY = (xy: string): FileStatus => {
  const x = xy[0] ?? '.'
  const y = xy[1] ?? '.'
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
    return 'U'
  }
  if (x === 'D' || y === 'D') {
    return 'D'
  }
  if (x === 'A') {
    return 'A'
  }
  if (x === 'T' || y === 'T') {
    return 'T'
  }
  return 'M'
}

/** `git status --porcelain=v2 --branch -z --untracked-files=all`. */
export const parseStatus = (text: string): StatusSnapshot => {
  const snapshot: StatusSnapshot = { head: '', branch: '', ahead: 0, behind: 0, entries: [] }
  const tokens = text.split('\0')
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? ''
    if (token === '') {
      continue
    }
    if (token.startsWith('# ')) {
      const [, key, ...rest] = token.split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') {
        snapshot.head = value === '(initial)' ? '' : value
      } else if (key === 'branch.head') {
        snapshot.branch = value
      } else if (key === 'branch.upstream') {
        snapshot.upstream = value
      } else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value)
        snapshot.ahead = Number(match?.[1] ?? 0)
        snapshot.behind = Number(match?.[2] ?? 0)
      }
      continue
    }
    const fields = token.split(' ')
    const kind = fields[0]
    const blank = { added: 0, removed: 0, isBinary: false, isUntracked: false }
    if (kind === '1') {
      snapshot.entries.push({ ...blank, path: fields.slice(8).join(' '), status: letterFromXY(fields[1] ?? '') })
    } else if (kind === '2') {
      const score = fields[8] ?? 'R'
      const oldPath = tokens[i + 1] ?? ''
      i += 1
      snapshot.entries.push({
        ...blank,
        path: fields.slice(9).join(' '),
        oldPath,
        status: score.startsWith('C') ? 'C' : 'R',
      })
    } else if (kind === 'u') {
      snapshot.entries.push({ ...blank, path: fields.slice(10).join(' '), status: 'U' })
    } else if (kind === '?') {
      snapshot.entries.push({ ...blank, path: token.slice(2), status: 'A', isUntracked: true })
    }
  }
  return snapshot
}

/** `git diff --numstat -z` (renames as an empty path then old and new). */
export const parseNumstatZ = (text: string): Map<string, Stat> => {
  const stats = new Map<string, Stat>()
  const tokens = text.split('\0')
  for (let i = 0; i < tokens.length; i += 1) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[i] ?? '')
    if (match === null) {
      continue
    }
    let path = match[3] ?? ''
    if (path === '') {
      path = tokens[i + 2] ?? ''
      i += 2
    }
    const isBinary = match[1] === '-'
    stats.set(path, {
      added: isBinary ? 0 : Number(match[1]),
      removed: isBinary ? 0 : Number(match[2]),
      isBinary,
    })
  }
  return stats
}

const rawStatus = (letter: string): FileStatus => {
  switch (letter) {
    case 'A':
    case 'C':
    case 'D':
    case 'R':
    case 'T':
    case 'U':
      return letter
    default:
      return 'M'
  }
}

const FIELD = '\u001f'
const RECORD = '\u001e'
const HEADER_END = '\u001d'
export const LOG_FORMAT = `${RECORD}%H${FIELD}%h${FIELD}%P${FIELD}%an${FIELD}%ae${FIELD}%at${FIELD}%ct${FIELD}%D${FIELD}%s${FIELD}%b${HEADER_END}`

/** `git log --format=LOG_FORMAT --raw --numstat -M`: raw and numstat lines pair by order. */
export const parseLog = (text: string, sessionStartMs: number): CommitInfo[] => {
  const commits: CommitInfo[] = []
  for (const record of text.split(RECORD)) {
    const end = record.indexOf(HEADER_END)
    if (end < 0) {
      continue
    }
    const fields = record.slice(0, end).split(FIELD)
    const [sha = '', short = '', parents = '', author = '', email = '', at = '0', ct = '0', refs = '', subject = ''] =
      fields
    const body = fields.slice(9).join(FIELD).trim()
    const raw: { status: FileStatus; path: string; oldPath?: string }[] = []
    const numstat: Stat[] = []
    for (const line of record.slice(end + 1).split('\n')) {
      if (line.startsWith(':')) {
        const parts = line.split('\t')
        const meta = (parts[0] ?? '').split(' ')
        const status = rawStatus((meta[4] ?? 'M')[0] ?? 'M')
        if ((status === 'R' || status === 'C') && parts.length >= 3) {
          raw.push({ status, oldPath: parts[1] ?? '', path: parts[2] ?? '' })
        } else {
          raw.push({ status, path: parts.slice(1).join('\t') })
        }
        continue
      }
      const match = /^(\d+|-)\t(\d+|-)\t/.exec(line)
      if (match !== null) {
        const isBinary = match[1] === '-'
        numstat.push({ added: isBinary ? 0 : Number(match[1]), removed: isBinary ? 0 : Number(match[2]), isBinary })
      }
    }
    const files: FileChange[] = raw.map((entry, index) => {
      const stat = numstat[index] ?? { added: 0, removed: 0, isBinary: false }
      return { ...entry, ...stat, isUntracked: false }
    })
    commits.push({
      sha,
      short,
      parents: parents.split(' ').filter(parent => parent !== ''),
      author,
      email,
      date: Number(at) * 1000,
      refs,
      subject,
      body,
      files,
      isSession: Number(ct) * 1000 >= sessionStartMs,
    })
  }
  return commits
}

export type CleanDiff = { header: string[]; body: string; isBinary: boolean }

const HEADER_LINES = /^(new file mode|deleted file mode|old mode|new mode|similarity index|rename from|rename to|copy from|copy to|Binary files)/

/** Splits git's file header from its hunks; the hunks alone are what a diff Code draws. */
export const cleanDiff = (text: string): CleanDiff => {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const first = lines.findIndex(line => line.startsWith('@@'))
  const headerLines = first < 0 ? lines : lines.slice(0, first)
  const header = headerLines.filter(line => HEADER_LINES.test(line))
  const isBinary = headerLines.some(line => line.startsWith('Binary files') || line.startsWith('GIT binary patch'))
  if (first < 0) {
    return { header, body: '', isBinary }
  }
  const bodyLines = lines.slice(first)
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') {
    bodyLines.pop()
  }
  return { header, body: bodyLines.join('\n'), isBinary }
}

export type TruncatedDiff = { text: string; isTruncated: boolean; hiddenLines: number }

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

/** Re-counts a hunk header for the lines kept under it, so a cut hunk still parses. */
const recount = (header: string, lines: readonly string[]): string => {
  const match = HUNK.exec(header)
  if (match === null) {
    return header
  }
  let oldCount = 0
  let newCount = 0
  for (const line of lines) {
    if (line.startsWith('+')) {
      newCount += 1
    } else if (line.startsWith('-')) {
      oldCount += 1
    } else if (line.startsWith(' ') || line === '') {
      oldCount += 1
      newCount += 1
    }
  }
  return `@@ -${match[1]},${oldCount} +${match[2]},${newCount} @@${match[3] ?? ''}`
}

/** Keeps whole hunks, and a re-counted part of the next, within `maxChars`. */
export const truncateDiff = (body: string, maxChars: number): TruncatedDiff => {
  if (body.length <= maxChars) {
    return { text: body, isTruncated: false, hiddenLines: 0 }
  }
  const lines = body.split('\n')
  const kept: string[] = []
  let size = 0
  let hunkStart = -1
  let index = 0
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (size + line.length + 1 > maxChars) {
      break
    }
    if (line.startsWith('@@')) {
      hunkStart = kept.length
    }
    kept.push(line)
    size += line.length + 1
  }
  if (hunkStart >= 0) {
    const header = kept[hunkStart] ?? ''
    kept[hunkStart] = recount(header, kept.slice(hunkStart + 1))
  }
  while (kept.length > 0 && (kept[kept.length - 1] ?? '').startsWith('@@')) {
    kept.pop()
  }
  return { text: kept.join('\n'), isTruncated: true, hiddenLines: lines.length - kept.length }
}

const git = (...args: string[]): string[] => ['git', '-c', 'core.quotePath=false', '--no-pager', ...args]

const firstExisting = async (run: GitRun, refs: readonly string[]): Promise<string | undefined> => {
  for (const ref of refs) {
    const result = await run(git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`))
    if (result.exitCode === 0) {
      return ref
    }
  }
  return undefined
}

const logRange = async (
  run: GitRun,
  scope: CommitScope,
  head: string,
  branch: string,
  sessionStartMs: number,
): Promise<{ args: string[]; baseRef?: string }> => {
  if (scope === 'session') {
    return { args: [`--since=${new Date(sessionStartMs).toISOString()}`, `-n${LOG_LIMIT}`, 'HEAD'] }
  }
  if (scope === 'branch') {
    const candidates = ['origin/main', 'main', 'origin/master', 'master'].filter(ref => ref !== branch)
    const baseRef = await firstExisting(run, candidates)
    if (baseRef !== undefined) {
      const base = await run(git('merge-base', 'HEAD', baseRef))
      const sha = base.stdout.trim()
      if (base.exitCode === 0 && sha !== '' && sha !== head) {
        return { args: [`-n${LOG_LIMIT}`, `${sha}..HEAD`], baseRef }
      }
      return { args: [`-n${LOG_LIMIT}`, `${baseRef}..HEAD`], baseRef }
    }
  }
  return { args: ['-n30', 'HEAD'] }
}

/** Everything the Files tab draws: the working tree and the commits of a scope. */
/** When a file last changed on disk, in ms; undefined where it cannot be read. */
export type MtimeOf = (path: string) => Promise<number | undefined>

const MAX_MTIMES = 200

export const loadGit = async (
  run: GitRun,
  scope: CommitScope,
  sessionStartMs: number,
  now: number,
  mtimeOf?: MtimeOf,
): Promise<GitView> => {
  const blank: GitView = {
    isRepo: false,
    root: '',
    branch: '',
    head: '',
    ahead: 0,
    behind: 0,
    worktree: [],
    commits: [],
    scope,
    updatedAt: now,
  }
  const top = await run(git('rev-parse', '--show-toplevel'))
  if (top.exitCode !== 0) {
    return { ...blank, error: top.stderr.trim() || 'Not a git repository.' }
  }
  const status = await run(git('status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'))
  if (status.exitCode !== 0) {
    return { ...blank, isRepo: true, root: top.stdout.trim(), error: status.stderr.trim() }
  }
  const snapshot = parseStatus(status.stdout)
  const hasHead = snapshot.head !== ''
  const numstat = await run(git('diff', hasHead ? 'HEAD' : '--cached', '--numstat', '-z', '-M'))
  const stats = parseNumstatZ(numstat.stdout)
  let untrackedLeft = MAX_UNTRACKED_STATS
  const worktree: FileChange[] = []
  for (const entry of snapshot.entries) {
    let stat = stats.get(entry.path)
    if (stat === undefined && entry.isUntracked && untrackedLeft > 0) {
      untrackedLeft -= 1
      const counted = await run(git('diff', '--no-index', '--numstat', '-z', '--', '/dev/null', entry.path))
      stat = [...parseNumstatZ(counted.stdout).values()][0]
    }
    worktree.push(stat === undefined ? entry : { ...entry, ...stat })
  }
  if (mtimeOf !== undefined) {
    const root = top.stdout.trim()
    for (const [index, entry] of worktree.slice(0, MAX_MTIMES).entries()) {
      if (entry.status !== 'D') {
        const mtimeMs = await mtimeOf(`${root}/${entry.path}`)
        if (mtimeMs !== undefined) {
          worktree[index] = { ...entry, mtimeMs }
        }
      }
    }
  }
  let commits: CommitInfo[] = []
  let baseRef: string | undefined
  if (hasHead) {
    const range = await logRange(run, scope, snapshot.head, snapshot.branch, sessionStartMs)
    baseRef = range.baseRef
    const log = await run(
      git('log', `--format=${LOG_FORMAT}`, '--raw', '--numstat', '-M', '--diff-merges=first-parent', ...range.args),
    )
    commits = log.exitCode === 0 ? parseLog(log.stdout, sessionStartMs) : []
  }
  return {
    isRepo: true,
    root: top.stdout.trim(),
    branch: snapshot.branch,
    head: snapshot.head,
    upstream: snapshot.upstream,
    ahead: snapshot.ahead,
    behind: snapshot.behind,
    worktree,
    commits,
    scope,
    baseRef,
    updatedAt: now,
  }
}

/** Cheap change detection: HEAD plus the porcelain status text. */
export const gitFingerprint = async (run: GitRun): Promise<string> => {
  const status = await run(git('status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'))
  if (status.exitCode !== 0) {
    return `error:${status.stderr.trim()}`
  }
  const diff = await run(git('diff', '--shortstat', 'HEAD'))
  return `${status.stdout}|${diff.stdout}`
}

export type DiffRequest = {
  commitKey: string
  parent?: string
  path: string
  oldPath?: string
  isUntracked: boolean
  hasHead: boolean
  mode: DiffMode
}

export const diffArgv = (request: DiffRequest): string[] => {
  const context = request.mode === 'full' ? '-U100000' : '-U3'
  const paths = request.oldPath !== undefined && request.oldPath !== request.path ? [request.oldPath, request.path] : [request.path]
  if (request.commitKey === WORKTREE) {
    if (request.isUntracked) {
      return git('diff', '--no-index', context, '--', '/dev/null', request.path)
    }
    return git('diff', request.hasHead ? 'HEAD' : '--cached', '-M', context, '--', ...paths)
  }
  return git('diff', request.parent ?? EMPTY_TREE, request.commitKey, '-M', context, '--', ...paths)
}

export const DIFF_BUDGET = 60_000

export type LoadedDiff = CleanDiff & TruncatedDiff & { error?: string }

export const loadDiff = async (run: GitRun, request: DiffRequest): Promise<LoadedDiff> => {
  const result = await run(diffArgv(request))
  // `--no-index` exits 1 when the files differ, which is the point.
  if (result.exitCode > 1 || (result.exitCode === 1 && !request.isUntracked)) {
    return { header: [], body: '', isBinary: false, text: '', isTruncated: false, hiddenLines: 0, error: result.stderr.trim() }
  }
  const clean = cleanDiff(result.stdout)
  return { ...clean, ...truncateDiff(clean.body, DIFF_BUDGET) }
}

/** Added, modified and deleted counts and line churn over a set of changes. */
export const summarize = (
  changes: readonly FileChange[],
): { added: number; modified: number; deleted: number; renamed: number; plus: number; minus: number } => {
  const summary = { added: 0, modified: 0, deleted: 0, renamed: 0, plus: 0, minus: 0 }
  for (const change of changes) {
    if (change.status === 'A' || change.status === 'C') {
      summary.added += 1
    } else if (change.status === 'D') {
      summary.deleted += 1
    } else if (change.status === 'R') {
      summary.renamed += 1
    } else {
      summary.modified += 1
    }
    summary.plus += change.added
    summary.minus += change.removed
  }
  return summary
}

/** The net effect on each path across the session: commits oldest first, then the working tree. */
export const sessionChanges = (commits: readonly CommitInfo[], worktree: readonly FileChange[]): FileChange[] => {
  const byPath = new Map<string, FileChange>()
  const apply = (change: FileChange): void => {
    const previous = byPath.get(change.oldPath ?? change.path)
    if (change.oldPath !== undefined) {
      byPath.delete(change.oldPath)
    }
    if (previous === undefined) {
      byPath.set(change.path, { ...change })
      return
    }
    // Created then deleted within the session: no net change.
    if (previous.status === 'A' && change.status === 'D') {
      byPath.delete(change.path)
      return
    }
    byPath.set(change.path, {
      ...change,
      status: previous.status === 'A' ? 'A' : change.status,
      oldPath: previous.oldPath ?? change.oldPath,
      added: previous.added + change.added,
      removed: previous.removed + change.removed,
    })
  }
  for (const commit of [...commits].filter(commit => commit.isSession).reverse()) {
    commit.files.forEach(apply)
  }
  worktree.forEach(apply)
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
}
