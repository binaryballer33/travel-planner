// Commits: the uncommitted changes and the commits of a scope, each opened
// to its message and files, each file to its diff. The session's net change
// is a card of figures and the list a card; an opened commit is a card under
// its row, and an opened file a card under the file's.

import type { RenderElement } from 'claude-code'

import type { CommitInfo, FileChange, GitView } from '../../types'
import { churn, clip, fileTone, fmtAgo, fmtClock, keyOf, oneLine } from '../lib/format'
import { WORKTREE, sessionChanges, summarize } from '../lib/git'
import { diffPanel } from './diff'
import { cardStack, figure, figureRow, iconSeg, picker, rowDetailCard, rowLine, sectionCard, seg, titleSeg, type Actions, type PaneData, type Ui } from './kit'
import type { RowSegment } from './row'
import { sessionBanner, sessionPicker } from './sessions' // --- session history ---
import { fitList, listShareOf } from '../lib/fit'

const MAX_FILE_ROWS = 150

/**
 * The least of the list budget an open commit's files keep, and the least its
 * commit rows keep. Its files come first, as nothing else reaches the ones
 * left out: they claim what they need, up to all but this, and the commit rows
 * get the rest, those past it listed again when the commit is closed. Where a
 * row is plain elements (VS Code, mobile) 60 commit rows alone pass the
 * budget; on the desktop, a region each, they take 0.7 of it.
 */
export const OPEN_FILES_FLOOR = 0.25

/** A Button key for a file of a commit: short, stable, free of control characters. */
export const fileKey = (commitKey: string, path: string): string => `file:${keyOf(`${commitKey}/${path}`)}`

export const commitKey = (sha: string): string => `commit:${sha.slice(0, 12)}`

/** The cards of the Commits tab: the session's net change, and the list. */
export const NET_CARD_KEY = 'card:commits:net'
export const COMMITS_CARD_KEY = 'card:commits:list'

/** An opened commit's card (the uncommitted changes' for WORKTREE). */
export const commitCardKey = (sha: string): string => `card:${sha === WORKTREE ? 'commit:worktree' : commitKey(sha)}`

/** A file's line churn as row cells: +added −removed and its squares. */
export const churnSegs = (added: number, removed: number, isBinary: boolean): RowSegment[] => {
  if (isBinary) {
    return [seg('binary', { dim: true })]
  }
  const squares = churn(added, removed, 5)
  return [
    seg(`+${added}`, { color: 'success' }),
    seg(`−${removed}`, { color: 'error' }),
    seg(`${squares.plus}`, { color: 'success' }),
    seg(`${squares.minus}${squares.rest}`, { color: squares.minus === '' ? 'subtle' : 'error' }),
  ]
}

export const churnText = (ui: Ui, added: number, removed: number, isBinary: boolean): RenderElement => {
  const { Text } = ui
  if (isBinary) {
    return <Text dimColor>binary</Text>
  }
  const squares = churn(added, removed, 5)
  return (
    <Text>
      <Text color="success">+{added}</Text> <Text color="error">−{removed}</Text> <Text color="success">{squares.plus}</Text>
      <Text color="error">{squares.minus}</Text>
      <Text dimColor>{squares.rest}</Text>
    </Text>
  )
}

/** A file row of an open commit, and what it takes of the list budget. */
type FileLine = { isOpen: boolean; element: RenderElement; share: number }

/** An open commit's file rows, up to MAX_FILE_ROWS, each weighed. */
const fileLines = (key: string, files: readonly FileChange[], data: PaneData, ui: Ui, act: Actions): FileLine[] => {
  const width = Math.max(20, data.columns - 34)
  return files.slice(0, MAX_FILE_ROWS).map(file => {
    const isOpen = data.diff?.key === `${key}\u0000${file.path}`
    const segments: RowSegment[] = [
      seg(file.isUntracked ? '?' : file.status, { color: fileTone(file.status), bold: true }),
      iconSeg(file.path),
      titleSeg(file.oldPath !== undefined ? `${clip(file.oldPath, width / 2)} → ${file.path}` : file.path, isOpen),
      ...(key === WORKTREE && file.mtimeMs !== undefined ? [seg(`edited ${fmtClock(file.mtimeMs, data.now)}`, { dim: true })] : []),
      ...churnSegs(file.added, file.removed, file.isBinary),
    ]
    const element = rowLine(ui, data, fileKey(key, file.path), { kind: 'file', id: key, path: file.path }, segments, () => act.openFile(key, file), isOpen)
    return { isOpen, element, share: listShareOf(element) }
  })
}

/** What an open commit's file rows take of the list budget, all of them drawn. */
const fileNeedOf = (key: string, files: readonly FileChange[], data: PaneData, ui: Ui, act: Actions): number =>
  fileLines(key, files, data, ui, act).reduce((total, line) => total + line.share, 0)

/** An open commit's file rows: as many as fit in `share` of the list budget, what the commit rows beside them leave (the open file's always). */
const fileRows = (key: string, files: readonly FileChange[], data: PaneData, ui: Ui, act: Actions, share: number): RenderElement => {
  const { Box, Text } = ui
  // As many of its files as the pane can draw (the open one always); the open file's diff has a budget of its own.
  const kept = fitList(fileLines(key, files, data, ui, act), line => line.share, line => line.isOpen, share)
  return (
    <Box flexDirection="column" rowGap={data.space.row}>
      {kept.map(line => (
        <Box flexDirection="column">
          {line.element}
          {line.isOpen && data.diff !== null && diffPanel(data.diff, data, ui, act)}
        </Box>
      ))}
      {files.length > kept.length && <Text dimColor>… {files.length - kept.length} more files</Text>}
    </Box>
  )
}

export const changeSummary = (ui: Ui, files: readonly FileChange[]): RenderElement => {
  const { Box, Text } = ui
  const s = summarize(files)
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2} rowGap={1}>
      {s.added > 0 && <Text color="success">{s.added} added</Text>}
      {s.modified > 0 && <Text color="warning">{s.modified} modified</Text>}
      {s.deleted > 0 && <Text color="error">{s.deleted} deleted</Text>}
      {s.renamed > 0 && <Text color="merged">{s.renamed} renamed</Text>}
      <Text>
        <Text color="success">+{s.plus}</Text> <Text color="error">−{s.minus}</Text>
      </Text>
    </Box>
  )
}

/** An opened commit: its message, who made it and when, its refs, and its files; edged in the accent when the session made it. */
const commitDetail = (commit: CommitInfo, data: PaneData, ui: Ui, act: Actions, share: number): RenderElement => {
  const { Text } = ui
  return rowDetailCard(
    ui,
    data,
    commitCardKey(commit.sha),
    [
      <Text bold>{commit.subject}</Text>,
      ...(commit.body !== '' ? [<Text>{commit.body}</Text>] : []),
      <Text dimColor>{`${commit.author} <${commit.email}> · ${new Date(commit.date).toLocaleString()} · ${commit.sha}`}</Text>,
      ...(commit.refs !== '' ? [<Text color="suggestion">{commit.refs}</Text>] : []),
      changeSummary(ui, commit.files),
      fileRows(commit.sha, commit.files, data, ui, act, share),
    ],
    commit.isSession ? 'claude' : undefined,
  )
}

/** A commit's row line, its card aside. */
const commitLine = (commit: CommitInfo, data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const isOpen = data.ui.openCommit === commit.sha
  const s = summarize(commit.files)
  const segments: RowSegment[] = [
    seg(commit.isSession ? '●' : '○', { color: commit.isSession ? 'claude' : 'subtle' }),
    seg(commit.short, { color: 'warning' }),
    titleSeg(commit.subject, isOpen),
    seg(`+${s.plus}`, { color: 'success' }),
    seg(`−${s.minus}`, { color: 'error' }),
    seg(`${commit.files.length}f`, { dim: true }),
    seg(`${fmtClock(commit.date, data.now)} · ${fmtAgo(commit.date, data.now)}`, { dim: true }),
  ]
  return rowLine(ui, data, commitKey(commit.sha), { kind: 'commit', id: commit.sha, path: '' }, segments, () => act.toggleCommit(commit.sha), isOpen)
}

const commitRow = (commit: CommitInfo, line: RenderElement, data: PaneData, ui: Ui, act: Actions, share: number): RenderElement => {
  const { Box } = ui
  return (
    <Box flexDirection="column">
      {line}
      {data.ui.openCommit === commit.sha && commitDetail(commit, data, ui, act, share)}
    </Box>
  )
}

const worktreeBlock = (data: PaneData, ui: Ui, act: Actions, share: number): RenderElement => {
  const { Box, Text } = ui
  const files = data.git.worktree
  const isOpen = data.ui.openCommit === WORKTREE
  const s = summarize(files)
  return (
    <Box flexDirection="column">
      {rowLine(
        ui,
        data,
        'commit:worktree',
        { kind: 'commit', id: WORKTREE, path: '' },
        [
          seg('◆', { color: files.length > 0 ? 'warning' : 'success' }),
          titleSeg('Uncommitted changes', isOpen),
          ...(files.length === 0
            ? [seg('clean', { dim: true })]
            : [seg(`+${s.plus}`, { color: 'success' }), seg(`−${s.minus}`, { color: 'error' }), seg(`${files.length}f`, { dim: true })]),
        ],
        () => act.toggleCommit(WORKTREE),
        isOpen,
      )}
      {isOpen &&
        rowDetailCard(
          ui,
          data,
          commitCardKey(WORKTREE),
          [files.length === 0 ? <Text dimColor>The working tree matches HEAD.</Text> : changeSummary(ui, files), fileRows(WORKTREE, files, data, ui, act, share)],
          'warning',
        )}
    </Box>
  )
}

/** The session's net change: its files by what happened to them, and its lines. */
const netCard = (net: readonly FileChange[], data: PaneData, ui: Ui): RenderElement => {
  const { Text } = ui
  const s = summarize(net)
  return sectionCard(
    ui,
    data,
    NET_CARD_KEY,
    'Net change this session',
    net.length === 0 ? '' : `${net.length} file${net.length === 1 ? '' : 's'} · this session's commits and what is not committed yet`,
    [
      net.length === 0 ? (
        <Text dimColor>No file changes yet.</Text>
      ) : (
        figureRow(ui, data, [
          figure(ui, data, 'Added', String(s.added), 'success'),
          figure(ui, data, 'Modified', String(s.modified), 'warning'),
          figure(ui, data, 'Deleted', String(s.deleted), 'error'),
          ...(s.renamed > 0 ? [figure(ui, data, 'Renamed', String(s.renamed), 'merged')] : []),
          figure(ui, data, 'Lines added', `+${s.plus}`, 'success'),
          figure(ui, data, 'Lines removed', `−${s.minus}`, 'error'),
        ])
      ),
    ],
  )
}

export const commitsTab = (data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Text, Button } = ui
  const { git } = data
  if (!git.isRepo) {
    return (
      <Text color="warning">
        {git.updatedAt === 0 ? 'Reading git…' : `Not a git repository here${git.error !== undefined ? `: ${oneLine(git.error, 200)}` : '.'}`}
      </Text>
    )
  }
  const net = sessionChanges(git.commits, git.worktree)
  const scopes: { value: GitView['scope']; label: string }[] = [
    { value: 'session', label: 'This session' },
    { value: 'branch', label: `This branch${git.baseRef !== undefined ? ` vs ${git.baseRef}` : ''}` },
    { value: 'recent', label: 'Last 30 commits' },
  ]
  const scopeLabel = scopes.find(one => one.value === git.scope)?.label ?? ''
  const count = git.commits.length
  // An open commit's files come first (OPEN_FILES_FLOOR): the commit rows get what their claim leaves of the
  // list budget, the open one's kept, and its files what the rows then leave, never less than they claimed.
  const lines = git.commits.map(commit => {
    const line = commitLine(commit, data, ui, act)
    return { commit, line, share: listShareOf(line) }
  })
  const isOpenRow = (row: (typeof lines)[number]): boolean => row.commit.sha === data.ui.openCommit
  const openKey = data.ui.openCommit ?? ''
  const openFiles = openKey === WORKTREE ? git.worktree : git.commits.find(commit => commit.sha === openKey)?.files
  const claim = openFiles === undefined ? 0 : Math.min(1 - OPEN_FILES_FLOOR, Math.max(OPEN_FILES_FLOOR, fileNeedOf(openKey, openFiles, data, ui, act)))
  const rows = openFiles === undefined ? lines : fitList(lines, row => row.share, isOpenRow, 1 - claim)
  const fileShare = 1 - rows.reduce((total, row) => total + row.share, 0)
  return cardStack(ui, data, [
    <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap} rowGap={data.space.row} alignItems="center">
      {sessionPicker(data, ui, act, 'commits') /* --- session history --- */}
      <Text>
        <Text color="merged" bold>
          ⎇ {git.branch}
        </Text>
        <Text dimColor> @ {git.head.slice(0, 8)}</Text>
        {git.ahead > 0 && <Text color="success"> ↑{git.ahead}</Text>}
        {git.behind > 0 && <Text color="warning"> ↓{git.behind}</Text>}
      </Text>
      {data.viewed === null && picker(ui, 'gitscope', 'Commits', git.scope, scopes, value => act.setCommitScope(value))}
      {data.viewed === null && <Button key="gitrefresh" label="Refresh" dimColor onPress={() => act.refreshGit()} />}
      <Text dimColor>updated {fmtAgo(git.updatedAt, data.now)}</Text>
    </Box>,
    ...sessionBanner(data, ui, act, 'commits'), // --- session history ---
    netCard(net, data, ui),
    sectionCard(ui, data, COMMITS_CARD_KEY, 'Commits', `${scopeLabel} · ${count} commit${count === 1 ? '' : 's'}`, [
      <Box flexDirection="column" rowGap={data.space.row}>
        {worktreeBlock(data, ui, act, fileShare)}
        {count === 0 ? (
          <Text dimColor>{data.viewed !== null ? 'That session made no commits.' : git.scope === 'session' ? 'No commits since this session started.' : 'No commits in this range.'}</Text>
        ) : (
          rows.map(row => commitRow(row.commit, row.line, data, ui, act, fileShare))
        )}
        {rows.length < count && <Text dimColor>{`… ${count - rows.length} more commits, listed again when this one is closed`}</Text>}
      </Box>,
      <Text dimColor>
        <Text color="claude">●</Text> committed this session · ○ earlier · click a commit to open it, then a file for its diff
      </Text>,
    ]),
  ])
}
