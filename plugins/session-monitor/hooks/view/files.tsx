// Files: every file this session created, modified, deleted or read, with
// who touched it and how often; opened, its diff or its current text. One
// card holds the counts and the list, the open file a card under its row.

import type { RenderElement } from 'claude-code'

import type { FileActivity, FileFilter } from '../../types'
import { activityLetter, activityTone, fmtAgo, fmtClock, keyOf } from '../lib/format'
import { countActivity, fileRows, type FileRow } from '../lib/files'
import { churnSegs } from './commits'
import { diffPanel } from './diff'
import { cardStack, figure, figureRow, iconSeg, picker, rowLine, sectionCard, seg, titleSeg, type Actions, type PaneData, type Ui } from './kit'
import type { RowSegment } from './row'
import { sessionBanner, sessionPicker } from './sessions' // --- session history ---
import { fitList, listShareOf } from '../lib/fit'
// --- file tree ---
import { filesModeBar, folderTab } from './tree'
// --- end file tree ---

const MAX_ROWS = 200
const ORDER: readonly FileActivity[] = ['created', 'modified', 'deleted', 'read']
const WORD: Record<FileActivity, string> = { created: 'Created', modified: 'Modified', deleted: 'Deleted', read: 'Read' }

/** The card that holds the session's files. */
export const FILES_CARD_KEY = 'card:files:list'

/** The open-state key a row's panel is stored under. */
export const rowKey = (row: FileRow): string => (row.change !== undefined ? `WORKTREE\u0000${row.change.path}` : `FILE\u0000${row.path}`)

export const touchedKey = (path: string): string => `touched:${keyOf(path)}`

const usage = (row: FileRow): string => {
  const parts: string[] = []
  if (row.reads > 0) {
    parts.push(`read ×${row.reads}`)
  }
  if (row.edits > 0) {
    parts.push(`edited ×${row.edits}`)
  }
  parts.push(row.tools.join(', '))
  return parts.join(' · ')
}

/** What the Files card says beside its title: how many files, how many of them shown, and their order. */
const filesAside = (shown: number, total: number): string =>
  total === 0 ? '' : `${shown === total ? `${total} this session` : `${shown} of ${total} shown`}, the latest first`

export const filesTab = (data: PaneData, ui: Ui, act: Actions): RenderElement => {
  // --- file tree ---
  if (data.tree?.mode === 'folder') {
    return folderTab(data, ui, act)
  }
  // --- end file tree ---
  const { Box, Text } = ui
  const rows = fileRows(data.touched, data.git.worktree, data.git.root, data.git.updatedAt)
  const counts = countActivity(rows)
  const filter = data.ui.fileFilter
  const shown = rows.filter(row => filter === 'all' || row.activity === filter)
  const options: { value: FileFilter; label: string }[] = [
    { value: 'all', label: `All (${rows.length})` },
    ...ORDER.map(activity => ({ value: activity, label: `${WORD[activity]} (${counts[activity]})` })),
  ]
  // The latest rows the pane can draw (the open one always); its diff has a budget of its own (lib/codeview.ts).
  const lines = shown.slice(0, MAX_ROWS).map(row => {
    const isOpen = data.diff?.key === rowKey(row)
    const when = row.editedAt ?? row.lastAt
    const segments: RowSegment[] = [
      seg(activityLetter(row.activity), { color: activityTone(row.activity), bold: true }),
      iconSeg(row.path),
      titleSeg(row.display, isOpen),
      ...(row.change !== undefined ? churnSegs(row.added, row.removed, row.isBinary) : []),
      seg(usage(row), { dim: true }),
      seg(row.editedAt !== undefined ? 'edited' : 'read', { dim: true }),
      seg(fmtClock(when, data.now), { color: row.editedAt !== undefined ? activityTone(row.activity) : 'suggestion' }),
      seg(fmtAgo(when, data.now), { dim: true }),
    ]
    const element = rowLine(ui, data, touchedKey(row.path), { kind: 'touched', id: row.path, path: row.path }, segments, () => act.openFileRow(row), isOpen)
    return { isOpen, element, share: listShareOf(element) }
  })
  const kept = fitList(lines, line => line.share, line => line.isOpen, 1)
  const list =
    shown.length === 0 ? (
      <Text dimColor>{rows.length === 0 ? 'No files touched yet. Files appear here as Claude reads, writes or deletes them.' : 'Nothing matches.'}</Text>
    ) : (
      <Box flexDirection="column" rowGap={data.space.row}>
        {kept.map(line => (
          <Box flexDirection="column">
            {line.element}
            {line.isOpen && data.diff !== null && diffPanel(data.diff, data, ui, act)}
          </Box>
        ))}
        {shown.length > kept.length && <Text dimColor>… {shown.length - kept.length} more: Show above narrows the list</Text>}
      </Box>
    )
  return cardStack(ui, data, [
    <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap} rowGap={data.space.row} alignItems="center">
      {sessionPicker(data, ui, act, 'files') /* --- session history --- */}
      {/* --- file tree --- */}
      {data.viewed === null && filesModeBar(data, ui, act) /* the folder is today's: not for a past session */}
      {/* --- end file tree --- */}
      {picker(ui, 'filefilter', 'Show', filter, options, value => act.setFileFilter(value))}
    </Box>,
    ...sessionBanner(data, ui, act, 'files'), // --- session history ---
    sectionCard(ui, data, FILES_CARD_KEY, 'Files', filesAside(shown.length, rows.length), [
      figureRow(
        ui,
        data,
        ORDER.map(activity => figure(ui, data, WORD[activity], String(counts[activity]), activityTone(activity))),
      ),
      list,
      <Text dimColor>
        <Text color={activityTone('created')}>A</Text> created · <Text color={activityTone('modified')}>M</Text> modified ·{' '}
        <Text color={activityTone('deleted')}>D</Text> deleted · <Text color={activityTone('read')}>R</Text> only read · “working tree” rows
        are changes git sees that no Claude file tool made (a shell command, or edits from before the session)
      </Text>,
    ]),
  ])
}
