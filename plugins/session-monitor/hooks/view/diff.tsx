// The open file: its diff (changes only, or the whole file with the changes
// marked), or its current text where git has no diff for it.

import type { RenderElement } from 'claude-code'

import type { DiffView } from '../../types'
import { CHAR_WIDTH, contentRows, diffRows, MAX_SVG_PX, renderCodeView, renderSelectableView, type CodeFrame, type CodeViewOptions } from '../lib/codeview'
import { keyOf, oneLine } from '../lib/format'
import { CARD_BACKGROUND, DETAIL_INDENT, type Actions, type PaneData, type Ui } from './kit'

/** Cells the boxes around an image of the code take from the body's width (VS Code, the mobile app). */
const INSET_COLUMNS = 12

/** The open file's card, for a test to find. */
export const DIFF_PANEL_KEY = 'diff:panel'

// --- selectable code ---
/**
 * The desktop draws an interactive Svg in a frame of exactly the size it is
 * given, where an image shrinks to fit, so its frames are sized here to the
 * room the panel has. The pane's columns are cells of the desktop's code font
 * (12 px Anthropic Mono at its default density: 7.2 px), and a Box's padding
 * and margins count in `ch` of its body font (13 px Anthropic Sans: 7.85 px).
 */
const DESKTOP_CELL_PX = 7.2
const DESKTOP_CH_PX = 7.85
/**
 * What the boxes around the code take from the pane's width, padding and
 * margins in ch and borders in px. On Files: the pane's padding (1 ch a
 * side), the list's card (3 ch a side and its border) and the open file's
 * card (2 ch a side and its border). On Commits the commit's card sits
 * between the list's and the file's: set in DETAIL_INDENT and padded 2 ch a
 * side, with its border.
 */
const DESKTOP_INSETS: Readonly<Record<'files' | 'commits', { ch: number; px: number }>> = {
  files: { ch: 2 + 6 + 4, px: 2 + 2 },
  commits: { ch: 2 + 6 + DETAIL_INDENT + 4 + 4, px: 2 + 2 + 2 },
}
/** Pixels to spare: a frame a hair narrow leaves a sliver of panel beside it, one too wide shrinks its drawing to fit and leaves editor under it. */
const FIT_SLACK_PX = 4
/** The narrowest room a frame is sized to, whatever the pane's width. */
const MIN_FIT_PX = 160

/** The width the code has on the desktop, in CSS pixels, on this tab at this pane width. */
export const desktopFitPx = (columns: number, tab: PaneData['ui']['tab']): number => {
  const insets = tab === 'commits' ? DESKTOP_INSETS.commits : DESKTOP_INSETS.files
  return Math.max(MIN_FIT_PX, columns * DESKTOP_CELL_PX - insets.ch * DESKTOP_CH_PX - insets.px - FIT_SLACK_PX)
}

/**
 * A frame's drawn size: its own, or shrunk to the room with its shape kept,
 * as an image of it would be. In hundredths of a pixel, within the engine's
 * bounds for an Svg.
 */
export const frameSize = (frame: CodeFrame, fitPx: number): { width: number; height: number } => {
  const scale = Math.min(1, fitPx / frame.width)
  const size = (value: number): number => Math.min(MAX_SVG_PX, Math.max(0.01, Math.round(value * scale * 100) / 100))
  return { width: size(frame.width), height: size(frame.height) }
}
// --- end selectable code ---

/**
 * What a code view draws: SVG documents as images, or (the desktop) in frames
 * where the code can be selected with the mouse and copied.
 */
type Drawing = { kind: 'image'; chunks: string[]; hiddenRows: number } | { kind: 'frames'; frames: CodeFrame[]; hiddenRows: number }

/** The last view drawn: a redraw of the same file at the same width reuses it. */
let lastView: { key: string; view: Drawing } | undefined

/** The file or diff as an editor shows it, in SVG: a title bar, line numbers, syntax colours, tinted changes. */
const codeView = (diff: DiffView, data: PaneData, ui: Ui): RenderElement | null => {
  const { Box, Text, Svg } = ui
  if (Svg === undefined || data.surface === 'terminal') {
    return null
  }
  const isContent = diff.kind === 'content'
  const isFramed = data.surface === 'desktop'
  const fit = desktopFitPx(data.columns, data.ui.tab)
  // Frames are drawn as wide as their room, so they keep the code's own size; an image shrinks to its room by itself.
  const columns = isFramed ? Math.max(60, Math.ceil(fit / CHAR_WIDTH)) : Math.max(60, data.columns - INSET_COLUMNS)
  const key = `${isFramed ? 'frames' : 'image'}|${diff.key}|${diff.mode}|${columns}|${diff.text.length}|${keyOf(diff.text)}`
  if (lastView?.key !== key) {
    const rows = isContent ? contentRows(diff.text) : diffRows(diff.text)
    const added = rows.filter(row => row.kind === 'add').length
    const removed = rows.filter(row => row.kind === 'del').length
    const note = isContent ? `${rows.length.toLocaleString('en-US')} lines` : `+${added} −${removed}`
    const options: CodeViewOptions = { path: diff.path, columns, isDiff: !isContent }
    lastView = {
      key,
      view: isFramed ? { kind: 'frames', ...renderSelectableView(rows, options, note) } : { kind: 'image', ...renderCodeView(rows, options, note) },
    }
  }
  const view = lastView.view
  const parts = view.kind === 'frames' ? view.frames.length : view.chunks.length
  const alt = (index: number): string => `${diff.path}${parts > 1 ? `, part ${index + 1} of ${parts}` : ''}`
  return (
    <Box flexDirection="column">
      {view.kind === 'frames'
        ? view.frames.map((frame, index) => <Svg key={`code:${index}`} source={frame.source} alt={alt(index)} isInteractive {...frameSize(frame, fit)} />)
        : view.chunks.map((source, index) => <Svg key={`code:${index}`} source={source} alt={alt(index)} />)}
      {view.hiddenRows > 0 && (
        <Text color="warning">
          … {view.hiddenRows.toLocaleString('en-US')} more lines not drawn here; Copy {isContent ? 'text' : 'diff'} has them all
        </Text>
      )}
    </Box>
  )
}

/**
 * The open file as a card under its row: rounded, softly filled where the
 * surface blends it, padded 2 ch a side on the desktop (DESKTOP_INSETS
 * counts it). Its buttons lead; `extra` (the folder tree's own buttons) is a
 * row of its own under them.
 */
export const diffPanel = (diff: DiffView, data: PaneData, ui: Ui, act: Actions, extra: readonly RenderElement[] = []): RenderElement => {
  const { Box, Text, Button, Code } = ui
  const isContent = diff.kind === 'content'
  const isTerminal = data.surface === 'terminal'
  const drawn = diff.isLoading || diff.error !== undefined || diff.isBinary || diff.text === '' ? null : codeView(diff, data, ui)
  return (
    <Box
      key={DIFF_PANEL_KEY}
      flexDirection="column"
      borderStyle="round"
      borderColor="subtle"
      backgroundColor={isTerminal ? undefined : CARD_BACKGROUND}
      paddingX={isTerminal ? 1 : 2}
      paddingY={isTerminal ? 0 : 1}
      marginY={data.space.row}
      gap={1}
    >
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} rowGap={1}>
        {!isContent && (
          <Button key="diff:hunks" label="Changes only" variant={diff.mode === 'hunks' ? 'primary' : 'secondary'} onPress={() => act.setDiffMode('hunks')} />
        )}
        {!isContent && (
          <Button key="diff:full" label="Whole file" variant={diff.mode === 'full' ? 'primary' : 'secondary'} onPress={() => act.setDiffMode('full')} />
        )}
        <Button key="diff:copy" label={isContent ? 'Copy text' : 'Copy diff'} onPress={press => act.copy(diff.text, press)} />
        <Button key="diff:close" label="Close" role="dismiss" onPress={() => act.closeDiff()} />
        {isContent && <Text dimColor>current contents (no git diff for this file)</Text>}
      </Box>
      {extra.length > 0 && (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2} rowGap={1}>
          {extra}
        </Box>
      )}
      {diff.oldPath !== undefined && diff.oldPath !== diff.path && (
        <Text color="merged">
          {diff.oldPath} → {diff.path}
        </Text>
      )}
      {diff.header.map(line => (
        <Text dimColor>{line}</Text>
      ))}
      {diff.isLoading ? (
        <Text color="warning">Loading…</Text>
      ) : diff.error !== undefined ? (
        <Text color="error">{oneLine(diff.error, 400)}</Text>
      ) : diff.isBinary ? (
        <Text dimColor>Binary file — nothing to show as text.</Text>
      ) : diff.text === '' ? (
        <Text dimColor>{isContent ? 'The file is empty.' : 'No line changes (mode or rename only).'}</Text>
      ) : drawn !== null ? (
        drawn
      ) : isContent ? (
        <Code source={diff.text} path={diff.path} startLine={1} />
      ) : (
        <Code source={diff.text} format="diff" path={diff.path} />
      )}
      {diff.isTruncated && (
        <Text color="warning">
          … {diff.hiddenLines.toLocaleString('en-US')} more lines not shown (the pane draws up to 60k characters)
        </Text>
      )}
    </Box>
  )
}
