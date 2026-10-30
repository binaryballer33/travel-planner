// The Files tab's folder view: the session's working folder as a tree,
// folders first, each folder's hidden entries in a group of their own. A
// click opens a folder (listed on demand), a file's text, or a hidden group;
// every row names its size, its permissions and when it last changed. One
// card holds the folder's figures and the tree, a shown file a card of its
// own under its row.

import type { RenderElement } from 'claude-code'

import type { FilesMode, TreeView } from '../../types'
import { fmtBytes, fmtClock, keyOf, oneLine } from '../lib/format'
import { baseName, EMPTY_TREE, entryGlyph, flattenTree, MAX_TREE_ROWS, modeParts, sizeText, sizeTone, type TreePress, type TreeRow } from '../lib/tree'
import { fitList, listShareOf } from '../lib/fit'
import { fileIcon } from '../lib/icons'
import { openLabel } from '../lib/apps'
import { diffPanel } from './diff'
import { cardStack, figure, figureRow, rowLine, sectionCard, seg, titleSeg, type Actions, type PaneData, type Ui } from './kit'
import type { RowPress, RowSegment } from './row'

type EntryRow = Extract<TreeRow, { type: 'entry' }>
type HiddenRow = Extract<TreeRow, { type: 'hidden' }>
type NoteRow = Extract<TreeRow, { type: 'note' }>

const SIZE_WIDTH = 10
const MODE_WIDTH = 10
const TIME_WIDTH = 15

/** A tree entry's row key: short and free of control characters. */
export const treeKey = (path: string): string => `tree:${keyOf(path)}`

/** A folder's hidden group's row key. */
export const hiddenKey = (path: string): string => `treeh:${keyOf(path)}`

/** The open-state key of a file's text, as the hooks module stores it. */
export const contentKey = (path: string): string => `FILE\u0000${path}`

/** The card that holds the folder tree. */
export const TREE_CARD_KEY = 'card:files:tree'

/**
 * `rowLine` with whether the row is open: an expanded folder or a shown file
 * leads with the accent bar and stays lit where `rowLine` draws those.
 */
const treeLine: (ui: Ui, data: PaneData, key: string, press: RowPress, segments: readonly RowSegment[], onPress: () => void, isOpen: boolean) => RenderElement =
  rowLine

const indent = (depth: number): string => '  '.repeat(Math.min(depth, 24))

const MODES: readonly { value: FilesMode; label: string }[] = [
  { value: 'activity', label: 'Activity' },
  { value: 'folder', label: 'Folder' },
]

/** The switch between the session's file activity and the folder tree. */
export const filesModeBar = (data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Button } = ui
  const mode = data.tree?.mode ?? 'activity'
  return (
    <Box flexDirection="row" columnGap={data.space.gap - 1}>
      {MODES.map(option => (
        <Button
          key={`files:${option.value}`}
          label={option.label}
          variant={option.value === mode ? 'primary' : 'secondary'}
          onPress={() => act.setFilesMode(option.value)}
        />
      ))}
    </Box>
  )
}

const totalOf = (view: TreeView): { size: number; isPartial: boolean } | null => {
  const listing = view.listings[view.root]
  if (listing === undefined) {
    return null
  }
  return {
    size: listing.entries.reduce((sum, entry) => sum + entry.size, 0),
    isPartial: listing.isTruncated || listing.entries.some(entry => entry.isPartial || entry.error !== undefined),
  }
}

/** The folder's figures: what it holds, how much of it is hidden, its size and when it was listed. */
const folderFigures = (view: TreeView, data: PaneData, ui: Ui): RenderElement | null => {
  const listing = view.listings[view.root]
  const total = totalOf(view)
  if (listing === undefined || total === null) {
    return null
  }
  const tone = sizeTone(total.size)
  return figureRow(ui, data, [
    figure(ui, data, 'Items', String(listing.total - listing.hiddenTotal)),
    figure(ui, data, 'Hidden', String(listing.hiddenTotal), 'subtle'),
    figure(ui, data, 'Size', `${total.isPartial ? '≥' : ''}${fmtBytes(total.size)}`, tone === '' ? undefined : tone),
    figure(ui, data, 'Listed', fmtClock(listing.loadedAt, data.now)),
  ])
}

const folderButtons = (view: TreeView, data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Button } = ui
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap - 1} rowGap={data.space.row}>
      <Button key="tree:refresh" label="Refresh" onPress={() => act.refreshTree()} />
      <Button key="tree:collapse" label="Collapse all" onPress={() => act.collapseTree()} />
      <Button key="tree:finder" label="Open in Finder" onPress={() => act.openInApp(view.root)} />
    </Box>
  )
}

/** A shown file: its text in the open file's card, with buttons to open it in its app or in Finder. */
const filePanel = (row: EntryRow, data: PaneData, ui: Ui, act: Actions): RenderElement | null => {
  const { Button, Text } = ui
  if (data.diff === null) {
    return null
  }
  return diffPanel(data.diff, data, ui, act, [
    <Button key="tree:open" label={openLabel(row.entry.name)} onPress={() => act.openInApp(row.path)} />,
    <Button key="tree:reveal" label="Reveal in Finder" onPress={() => act.revealInFinder(row.path)} />,
    <Text dimColor>{oneLine(row.path, 240)}</Text>,
  ])
}

/** A file's lead: its indent, then its type's icon where a folder has its arrow and folder. */
const fileLead = (row: EntryRow): RowSegment => {
  const icon = fileIcon(row.entry.name)
  const lead = `${indent(row.depth)}  `
  return seg(`${lead}${icon.glyph}`, {
    parts: [
      { text: lead, color: '', dim: false },
      { text: icon.glyph, color: icon.color, dim: false },
    ],
  })
}

const entryRow = (row: EntryRow, data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box } = ui
  const { entry } = row
  const isDir = entry.kind === 'dir'
  const isShown = !isDir && data.diff?.key === contentKey(row.path)
  const name = entry.kind === 'link' ? `${oneLine(entry.name, 80)} ↪ ${oneLine(entry.linkTarget ?? '?', 60)}` : oneLine(entry.name, 120)
  const tone = isDir || entry.kind === 'file' ? sizeTone(entry.size) : ''
  const segments: RowSegment[] = [
    entry.kind === 'file' ? fileLead(row) : seg(`${indent(row.depth)}${entryGlyph(entry.kind, row.isOpen)}`, { color: isDir ? 'claude' : '' }),
    titleSeg(name, row.isOpen || isShown),
    ...(entry.error !== undefined ? [seg(oneLine(entry.error, 40), { color: 'error' })] : []),
    seg(sizeText(entry), { width: SIZE_WIDTH, color: tone, dim: tone === '' && !isDir }),
    seg(entry.mode, { width: MODE_WIDTH, parts: modeParts(entry.mode) }),
    seg(entry.mtimeMs > 0 ? fmtClock(entry.mtimeMs, data.now) : '—', { width: TIME_WIDTH, dim: true }),
  ]
  const press: TreePress = { kind: isDir ? 'dir' : 'entry', id: row.path, path: row.path }
  return (
    <Box flexDirection="column">
      {treeLine(ui, data, treeKey(row.path), press, segments, () => act.pressTree(press), row.isOpen || isShown)}
      {isShown && filePanel(row, data, ui, act)}
    </Box>
  )
}

const hiddenRow = (row: HiddenRow, data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const segments: RowSegment[] = [
    seg(`${indent(row.depth)}${row.isOpen ? '▾' : '▸'} 👁`, { color: 'subtle' }),
    seg(`Hidden (${row.count})`, { grow: true, role: 'title', bold: row.isOpen, dim: !row.isOpen }),
    seg(`${row.isPartial ? '≥' : ''}${fmtBytes(row.size)}`, { width: SIZE_WIDTH, dim: true }),
    seg('', { width: MODE_WIDTH }),
    seg('', { width: TIME_WIDTH }),
  ]
  const press: TreePress = { kind: 'hidden', id: row.path, path: row.path }
  return treeLine(ui, data, hiddenKey(row.path), press, segments, () => act.pressTree(press), row.isOpen)
}

const noteRow = (row: NoteRow, ui: Ui): RenderElement => {
  const { Text } = ui
  return (
    <Text color={row.tone === '' ? undefined : row.tone} dimColor={row.tone === ''}>
      {indent(row.depth + 2)}
      {oneLine(row.text, 300)}
    </Text>
  )
}

const treeRow = (row: TreeRow, data: PaneData, ui: Ui, act: Actions): RenderElement =>
  row.type === 'entry' ? entryRow(row, data, ui, act) : row.type === 'hidden' ? hiddenRow(row, data, ui, act) : noteRow(row, ui)

const legend = (ui: Ui): RenderElement => {
  const { Text } = ui
  return (
    <Text dimColor>
      A click opens a folder or shows a file’s text. A folder’s size is the total of the files in it (≥: still adding up when its time ran out).
      Permissions for owner, group and others: <Text color="suggestion">r</Text> read · <Text color="warning">w</Text> write ·{' '}
      <Text color="success">x</Text> execute · - none. Hidden entries (names starting with a dot) are grouped in each folder.
    </Text>
  )
}

/** The Files tab in folder mode: the switch, then the working folder's card: its figures, its buttons and the tree. */
export const folderTab = (data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Text } = ui
  const view = data.tree ?? EMPTY_TREE
  if (view.root === '') {
    return cardStack(ui, data, [filesModeBar(data, ui, act), <Text color="warning">Loading the working folder…</Text>])
  }
  const rows = flattenTree(view)
  const listing = view.listings[view.root]
  const figures = folderFigures(view, data, ui)
  // The rows the pane can draw (lib/fit.ts LIST_BUDGET), the shown file's always: its text has a budget of its own (lib/codeview.ts).
  const lines = rows.slice(0, MAX_TREE_ROWS).map(row => {
    const element = treeRow(row, data, ui, act)
    const isShown = row.type === 'entry' && row.entry.kind !== 'dir' && data.diff?.key === contentKey(row.path)
    return { element, isShown, isOpen: row.type !== 'note' && row.isOpen, share: isShown ? 0 : listShareOf(element) }
  })
  const kept = fitList(lines, line => line.share, line => line.isShown, 1)
  // Closing a folder or hidden group drawn above the cut makes room for the rows past it; with none open, the pane draws no more of the folder.
  const left = rows.length - kept.length
  const leftNote = kept.some(line => line.isOpen) ? `… ${left} more rows (close a folder to see them)` : `… ${left} more rows not drawn: Open in Finder lists the whole folder`
  return cardStack(ui, data, [
    filesModeBar(data, ui, act),
    sectionCard(ui, data, TREE_CARD_KEY, `📂 ${oneLine(baseName(view.root), 80)}`, oneLine(view.root, 200), [
      ...(figures === null ? [] : [figures]),
      folderButtons(view, data, ui, act),
      rows.length === 0 ? (
        <Text dimColor>{listing === undefined ? 'Not listed yet: press Refresh.' : 'The folder is empty.'}</Text>
      ) : (
        <Box flexDirection="column" rowGap={data.space.row}>
          {kept.map(line => line.element)}
          {left > 0 && <Text dimColor>{leftNote}</Text>}
        </Box>
      ),
      legend(ui),
    ]),
  ])
}
