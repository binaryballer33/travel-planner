// The Explorer tab: the project folder as an editor's tree, as VS Code's
// explorer shows it. Folders first, hidden entries inline, what git ignores
// dim. A click opens a folder or shows a file's text and selects the entry;
// its actions sit under it (new file or folder, edit, rename, delete, open,
// reveal, copy path), a name's form or the editor under the entry it is for.

import type { RenderElement } from 'claude-code'

import type { ExplorerForm } from '../../types'
import { keyOf, oneLine } from '../lib/format'
import {
  deleteKey,
  discardKey,
  editRows,
  EMPTY_EXPLORER,
  EXPLORER_ARM_MS,
  explorerRows,
  formAnchor,
  isArmedFor,
  MAX_EXPLORER_ROWS,
  projectTitle,
  relPath,
  targetDir,
  toField,
  type ExplorerEntryRow,
  type ExplorerPane,
  type ExplorerPress,
  type ExplorerRow,
} from '../lib/explorer'
import { fitList, listShareOf } from '../lib/fit'
import { fileIcon } from '../lib/icons'
import { openLabel } from '../lib/apps'
import { baseName } from '../lib/tree'
import { diffPanel } from './diff'
import { CARD_BACKGROUND, cardStack, rowLine, sectionCard, seg, type Actions, type PaneData, type Ui } from './kit'
import type { RowSegment } from './row'
import { contentKey } from './tree'

/** The card that holds the tree. */
export const EXPLORER_CARD_KEY = 'card:explorer'
/** The box of the open form, and of the editor. */
export const FORM_BOX_KEY = 'xp:form'
export const EDITOR_BOX_KEY = 'xp:editor'
/** The selected entry's actions. */
export const ACTIONS_KEY = 'xp:actions'

/** An entry's row key: short and free of control characters. */
export const explorerKey = (path: string): string => `xp:${keyOf(path)}`

/** The form's field: one key per form, so a new form never starts from another's text. */
export const formFieldKey = (form: ExplorerForm): string => `xp:field:${form.kind}:${keyOf(formAnchor(form))}`

/** The editor's field, per file. */
export const editorFieldKey = (path: string): string => `xp:text:${keyOf(path)}`

/** Two cells a level, as an editor's tree indents. */
const indentCells = (depth: number): number => 2 * Math.min(depth, 24)

/**
 * A row's lead, fixed in width so names line up: a folder's disclosure arrow,
 * or a file's type icon in its place (a link's 🔗), after the indent.
 */
const leadOf = (row: ExplorerEntryRow): RowSegment => {
  const pad = ' '.repeat(indentCells(row.depth))
  const width = pad.length + 3
  const { entry } = row
  if (entry.kind === 'dir') {
    return seg(`${pad}${row.isOpen ? '▾' : '▸'}`, { width, dim: row.isIgnored })
  }
  const icon = entry.kind === 'link' ? { glyph: '🔗', color: '' } : entry.kind === 'other' ? { glyph: '⚙️', color: '' } : fileIcon(entry.name)
  return seg(`${pad}${icon.glyph}`, {
    width,
    parts: [...(pad === '' ? [] : [{ text: pad, color: '', dim: false }]), { text: icon.glyph, color: icon.color, dim: row.isIgnored }],
  })
}

/** An entry's row: its lead and name, ignored ones dim, the selected one lit with the accent bar. */
const entryLine = (row: ExplorerEntryRow, data: PaneData, ui: Ui, act: Actions, isSelected: boolean): RenderElement => {
  const name = row.entry.kind === 'link' ? `${oneLine(row.entry.name, 160)} ↪` : oneLine(row.entry.name, 200)
  const segments: RowSegment[] = [leadOf(row), seg(name, { grow: true, role: 'title', dim: row.isIgnored, bold: isSelected })]
  const press: ExplorerPress = { kind: row.entry.kind === 'dir' ? 'xdir' : 'xfile', id: row.path, path: row.path }
  // Close together, as an editor's tree is: a cell between the lead and the name.
  const tight: PaneData = { ...data, space: { ...data.space, gap: 1 } }
  return rowLine(ui, tight, explorerKey(row.path), press, segments, () => act.pressExplorer(press), isSelected)
}

/** The selected entry's buttons; a field needs a surface that draws one (not the mobile app). */
const actionsOf = (row: ExplorerEntryRow, pane: ExplorerPane, data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Button, Text } = ui
  const { entry } = row
  const isDir = entry.kind === 'dir'
  const canType = ui.Input !== undefined
  const isEditing = pane.view.edit?.path === row.path
  const isArmed = isArmedFor(pane.view.armed, deleteKey(row.path), data.now)
  const name = oneLine(entry.name, 120)
  return (
    <Box key={ACTIONS_KEY} flexDirection="column" rowGap={data.space.row} marginLeft={indentCells(row.depth) + 2} marginY={data.space.row}>
      <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap - 1} rowGap={data.space.row}>
        {isDir && canType && <Button key="xp:act:newfile" label="New file here" onPress={() => act.explorerNew('file', row.path)} />}
        {isDir && canType && <Button key="xp:act:newfolder" label="New folder here" onPress={() => act.explorerNew('folder', row.path)} />}
        {entry.kind === 'file' && canType && pane.canEdit && !isEditing && (
          <Button key="xp:act:edit" label="Edit" variant="primary" onPress={() => act.explorerEdit(row.path)} />
        )}
        {canType && <Button key="xp:act:rename" label="Rename" onPress={() => act.explorerRename(row.path)} />}
        <Button key="xp:act:delete" label={isArmed ? 'Click again to delete' : 'Delete'} variant={isArmed ? 'primary' : undefined} onPress={() => act.explorerDelete(row.path)} />
        {!isDir && <Button key="xp:act:open" label={openLabel(entry.name)} onPress={() => act.explorerOpen(row.path, false)} />}
        <Button key="xp:act:reveal" label="Reveal in Finder" onPress={() => act.explorerOpen(row.path, true)} />
        <Button key="xp:act:copy" label="Copy path" onPress={press => act.copy(row.path, press)} />
      </Box>
      {entry.kind === 'file' && canType && !pane.canEdit && <Text dimColor>Editing here needs Claude Code 2.1.308 or later: {openLabel(entry.name)} edits it.</Text>}
      {isArmed && (
        <Text color="warning">
          A second click within {EXPLORER_ARM_MS / 1000} s moves {name}
          {isDir ? ' and everything in it' : ''} to the Trash (Finder’s Put Back restores it).
        </Text>
      )}
    </Box>
  )
}

/** The open form: a name for a new file or folder, or a new name; Enter or its button acts. */
const formBox = (form: ExplorerForm, pane: ExplorerPane, data: PaneData, ui: Ui, act: Actions, depth: number): RenderElement | null => {
  const { Box, Button, Input, Text } = ui
  if (Input === undefined) {
    return null
  }
  const root = pane.view.tree.root
  const isRename = form.kind === 'rename'
  const title = form.kind === 'rename' ? `Rename ${oneLine(baseName(form.path), 120)}` : `New ${form.kind} in ${oneLine(relPath(root, form.dir), 160)}/`
  const hint =
    form.kind === 'rename' ? 'a new name, in the same folder' : form.kind === 'file' ? 'name.ext, or folder/name.ext' : 'name, or parent/name'
  return (
    <Box
      key={FORM_BOX_KEY}
      flexDirection="column"
      rowGap={data.space.row}
      borderStyle="round"
      borderColor="claude"
      paddingX={1}
      marginLeft={indentCells(depth) + 2}
      marginY={data.space.row}
    >
      <Text bold>{title}</Text>
      <Input
        key={formFieldKey(form)}
        placeholder={hint}
        value={pane.formText}
        submitLabel={isRename ? 'rename' : 'create'}
        autoFocus
        onInput={value => act.explorerFormInput(value)}
        onSubmit={value => act.explorerSubmit(value)}
      />
      <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap - 1} rowGap={data.space.row} alignItems="center">
        <Button key="xp:form:submit" label={isRename ? 'Rename' : 'Create'} variant="primary" onPress={() => act.explorerSubmit()} />
        <Button key="xp:form:cancel" label="Cancel" onPress={() => act.explorerCancel()} />
        {!isRename && <Text dimColor>a “/” makes the folders on the way</Text>}
      </Box>
    </Box>
  )
}

/** The editor's text: as typed, else the file's as loaded or last saved. */
const text_ = (pane: ExplorerPane, saved: string): string => pane.editText ?? toField(saved)

/** The editor: the file's text in a field as tall as the file (within bounds), Save and Close under it. */
const editorBox = (pane: ExplorerPane, data: PaneData, ui: Ui, act: Actions, depth: number): RenderElement | null => {
  const { Box, Button, Input, Text } = ui
  const edit = pane.view.edit
  if (edit === null || Input === undefined || !pane.canEdit) {
    return null
  }
  // Named only where the engine takes it (pane.canEdit): an older one refuses the whole drawing over it.
  const lines = { rows: editRows(text_(pane, edit.text)) }
  const text = text_(pane, edit.text)
  const name = oneLine(baseName(edit.path), 120)
  const isTerminal = data.surface === 'terminal'
  const isDiscardArmed = isArmedFor(pane.view.armed, discardKey(edit.path), data.now)
  return (
    <Box
      key={EDITOR_BOX_KEY}
      flexDirection="column"
      rowGap={1}
      borderStyle="round"
      borderColor={edit.isStale ? 'warning' : 'claude'}
      backgroundColor={isTerminal ? undefined : CARD_BACKGROUND}
      paddingX={isTerminal ? 1 : 2}
      paddingY={isTerminal ? 0 : 1}
      marginLeft={indentCells(depth) + 2}
      marginY={data.space.row}
    >
      <Text>
        <Text bold>✎ Editing {name}</Text>
        <Text dimColor> {oneLine(relPath(pane.view.tree.root, edit.path), 200)}</Text>
      </Text>
      <Input
        key={editorFieldKey(edit.path)}
        value={text}
        {...lines}
        submitLabel="save"
        onInput={value => act.explorerEditInput(value)}
        onSubmit={value => act.explorerSave(value)}
      />
      <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap - 1} rowGap={data.space.row} alignItems="center">
        <Button key="xp:edit:save" label={edit.isStale ? 'Save over it' : 'Save'} variant="primary" onPress={() => act.explorerSave()} />
        <Button
          key="xp:edit:close"
          label={isDiscardArmed ? 'Discard changes' : 'Close'}
          variant={isDiscardArmed ? 'primary' : undefined}
          onPress={() => act.explorerCloseEdit()}
        />
        <Text dimColor>Enter saves · a new line as in the prompt box (Shift+Enter)</Text>
      </Box>
      {edit.isStale && (
        <Text color="warning">
          {name} changed on disk since you opened it. Save over it keeps your text; Close, then Edit, loads the new one.
        </Text>
      )}
      {isDiscardArmed && <Text color="warning">Unsaved changes: a second click within {EXPLORER_ARM_MS / 1000} s drops them.</Text>}
    </Box>
  )
}

const noteLine = (row: Extract<ExplorerRow, { type: 'note' }>, ui: Ui): RenderElement => {
  const { Text } = ui
  return (
    <Text color={row.tone === '' ? undefined : row.tone} dimColor={row.tone === ''}>
      {' '.repeat(indentCells(row.depth) + 5)}
      {oneLine(row.text, 300)}
    </Text>
  )
}

/** The buttons over the tree: new entries go in the selected folder (or the selected file's, or the root). */
const toolbar = (pane: ExplorerPane, data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Button, Text } = ui
  const root = pane.view.tree.root
  const canType = ui.Input !== undefined
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap - 1} rowGap={data.space.row} alignItems="center">
      {canType && <Button key="xp:newfile" label="New file" onPress={() => act.explorerNew('file')} />}
      {canType && <Button key="xp:newfolder" label="New folder" onPress={() => act.explorerNew('folder')} />}
      <Button key="xp:refresh" label="Refresh" onPress={() => act.explorerRefresh()} />
      <Button key="xp:collapse" label="Collapse all" onPress={() => act.explorerCollapse()} />
      <Button key="xp:finder" label="Open in Finder" onPress={() => act.explorerOpen(root, false)} />
      {canType && <Text dimColor>new entries go in {oneLine(relPath(root, targetDir(pane.view)), 160)}/</Text>}
    </Box>
  )
}

const legend = (ui: Ui): RenderElement => {
  const { Text } = ui
  return (
    <Text dimColor>
      A click opens a folder or shows a file’s text and selects it; the selected entry’s actions sit under it. Dim entries are ignored by git.
      Delete moves to the Trash. .git and .DS_Store are left out, as VS Code does.
    </Text>
  )
}

type Line = { element: RenderElement; isPinned: boolean; share: number; path?: string }

/** The Explorer tab: one card titled by the project folder, its buttons, the tree with what is open under its entry. */
export const explorerTab = (data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Text } = ui
  const pane: ExplorerPane = data.explorer ?? { view: EMPTY_EXPLORER, formText: '', editText: null, canEdit: false }
  const { view } = pane
  const root = view.tree.root
  if (root === '') {
    return cardStack(ui, data, [<Text color="warning">Loading the project folder…</Text>])
  }
  const rows = explorerRows(view)
  const form = view.form
  const anchor = form === null ? undefined : formAnchor(form)
  const editPath = view.edit?.path
  // What sits under an entry: the selected one's actions and its text, the form for it, the editor of it.
  const under = (row: ExplorerEntryRow): RenderElement[] => {
    const isSelected = view.selected === row.path
    const isShown = isSelected && row.entry.kind !== 'dir' && editPath !== row.path && data.diff?.key === contentKey(row.path)
    const parts: (RenderElement | null)[] = [
      isSelected ? actionsOf(row, pane, data, ui, act) : null,
      form !== null && anchor === row.path ? formBox(form, pane, data, ui, act, row.depth) : null,
      editPath === row.path ? editorBox(pane, data, ui, act, row.depth) : null,
      isShown && data.diff !== null ? diffPanel(data.diff, data, ui, act) : null,
    ]
    return parts.filter((part): part is RenderElement => part !== null)
  }
  const lines: Line[] = rows.slice(0, MAX_EXPLORER_ROWS).map(row => {
    if (row.type === 'note') {
      const element = noteLine(row, ui)
      return { element, isPinned: false, share: listShareOf(element) }
    }
    const line = entryLine(row, data, ui, act, view.selected === row.path)
    const below = under(row)
    // An entry with something open under it is always drawn; what is open has its own bounds (the code view's, the editor's).
    const element = below.length === 0 ? line : <Box flexDirection="column">{[line, ...below]}</Box>
    return { element, isPinned: below.length > 0, share: below.length > 0 ? listShareOf(line) : listShareOf(element), path: row.path }
  })
  const kept = fitList(lines, line => line.share, line => line.isPinned, 1)
  const drawnPaths = new Set(kept.flatMap(line => (line.path === undefined ? [] : [line.path])))
  // A form or the editor whose entry is not drawn (the root's, or one under a closed folder) sits over the tree.
  const top: RenderElement[] = []
  if (form !== null && anchor !== undefined && !drawnPaths.has(anchor)) {
    const box = formBox(form, pane, data, ui, act, 0)
    if (box !== null) {
      top.push(box)
    }
  }
  if (editPath !== undefined && !drawnPaths.has(editPath)) {
    const box = editorBox(pane, data, ui, act, 0)
    if (box !== null) {
      top.push(box)
    }
  }
  const left = rows.length - kept.length
  const leftNote = view.tree.expanded.length > 0 ? `… ${left} more rows (close a folder to see them)` : `… ${left} more rows not drawn: Open in Finder lists the whole folder`
  const listing = view.tree.listings[root]
  return cardStack(ui, data, [
    sectionCard(ui, data, EXPLORER_CARD_KEY, oneLine(projectTitle(root), 80), oneLine(root, 200), [
      toolbar(pane, data, ui, act),
      ...top,
      rows.length === 0 ? (
        <Text dimColor>{listing === undefined ? (view.tree.errors[root] !== undefined ? `Could not list the folder: ${oneLine(view.tree.errors[root] ?? '', 200)}` : 'Listing…') : 'The folder is empty.'}</Text>
      ) : (
        <Box flexDirection="column">
          {kept.map(line => line.element)}
          {left > 0 && <Text dimColor>{leftNote}</Text>}
        </Box>
      ),
      legend(ui),
    ]),
  ])
}
