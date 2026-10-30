// A list row drawn as a `Client` region, so a click anywhere on it opens it:
// the surface hands the region every pointer event, and the row posts what
// it opens back to the hooks module (`ui.message`). Runs on the drawing
// thread, without `$`; everything it shows arrives as plain-data props.
//
// The region holds the pointer from a press to its release, so nothing drawn
// in it can be selected. A row's second line (a command's exact text) is
// drawn by the kit under the region as plain text instead (`rowLine`).

// --- file tree ---
import type { ClientElements, RenderElement } from 'claude-code'

import type { TreePress } from '../lib/tree'
// --- end file tree ---
import type { ExplorerPress } from '../lib/explorer' // --- explorer ---
import type { ClientModule } from 'claude-code'

import { hearTabKeys } from '../lib/hotkeys'

/** What a row opens: a command, a commit, a file of a commit, a file the session touched, a task's sources. */
export type RowPress = {
  kind: 'cmd' | 'commit' | 'file' | 'touched' | 'task' | 'agent' | 'ports' | 'group'
  id: string
  /** The file's path, for `file` (its commit is `id`). */
  path: string
} | TreePress // --- file tree --- (a folder, a file or a hidden group of the Files tab's tree)
  | ExplorerPress // --- explorer --- (a folder or a file of the Explorer tab)

/** One cell of the row. Every field is set (props are JSON): '' and 0 mean none. */
export type RowSegment = {
  text: string
  // --- file tree ---
  /** Runs of their own color drawn in place of `text` (a permission string); `text` stays the plain fallback. */
  parts?: RowPart[]
  // --- end file tree ---
  color: string
  bold: boolean
  dim: boolean
  /** Fixed width in cells; 0 sizes to the text. */
  width: number
  /** Takes the free room, its text wrapping onto more lines where it does not fit (the title): nothing is cut off. */
  grow: boolean
  /**
   * The `title` becomes a button where a surface draws no Client. A `stat` (a
   * figure: when, how long, energy, network, memory, model) moves under the
   * title, with the row's other stats, when the line is too narrow for them all.
   */
  role: '' | 'title' | 'stat'
}

export type RowProps = {
  press: RowPress
  segments: RowSegment[]
  gap: number
  // --- ui polish ---
  /** Drawn open: an accent bar leads the row and its highlight stays on. */
  isOpen: boolean
  /** How the row lights while the pointer is over it. */
  highlight: RowHighlight
  // --- ui polish ---
}

// --- ui polish ---
/**
 * How a row lights: a background where the surface blends a translucent one
 * (desktop), the title inverted where a background may not read (terminal).
 */
export type RowHighlight = {
  /**
   * The region's background while hovered or open; '' for none. The kit
   * passes none: where a surface blends one, the Box around the region
   * lights instead, so the row's second line lights with it.
   */
  background: string
  /** Inverts the title while hovered. */
  isTitleInverse: boolean
}

/** The glyph that marks an open row, in the accent color; a closed row keeps the cell blank. */
export const OPEN_BAR = '▍'
// --- ui polish ---

type RowState = { isListening: true; isHovered: boolean }

const Row: ClientModule<RowProps, RowState> = (props, surface) => {
  const { Box, Text } = surface.elements
  // A tab's letter opens it while the row holds the focus, as everywhere in the pane.
  hearTabKeys(surface)
  if (surface.state === undefined) {
    const press = props.press
    surface.onPointer(event => {
      const isInside = event.x >= 0 && event.y >= 0
      const wasHovered = surface.state?.isHovered === true
      if (event.type === 'up' && event.button === 'left' && isInside) {
        surface.post(press)
      } else if (event.type === 'enter' || (event.type === 'move' && event.button === undefined && isInside)) {
        if (!wasHovered) {
          surface.setState({ isListening: true, isHovered: true })
        }
      } else if (event.type === 'leave' && wasHovered) {
        surface.setState({ isListening: true, isHovered: false })
      }
    })
    surface.setState({ isListening: true, isHovered: false })
  }
  const isHovered = surface.state?.isHovered === true
  const { background, isTitleInverse } = props.highlight
  const lit = background !== '' && (isHovered || props.isOpen) ? background : undefined
  const cell = (segment: RowSegment): RenderElement => {
    const isTitle = segment.role === 'title'
    const text = (
      <Text
        color={segment.color === '' ? undefined : segment.color}
        bold={segment.bold}
        dimColor={segment.dim}
        inverse={isTitle && isTitleInverse && isHovered}
        hover={isTitle && isTitleInverse ? { inverse: true } : undefined}
      >
        {cellText(segment, Text)}
      </Text>
    )
    // The title starts at its room and grows into what is left; it never shrinks below it, so where the
    // line cannot hold it the cells after it move to the next line instead of crushing it.
    return segment.grow ? (
      <Box flexGrow={1} flexShrink={0} width={growRoom(segment.text)}>
        {text}
      </Box>
    ) : (
      <Box flexShrink={0} width={segment.width > 0 ? segment.width : undefined}>
        {text}
      </Box>
    )
  }
  // --- rows ---
  // Too narrow for every cell: the stats go under the title, wrapping onto as many lines as they need.
  const isStackedNow = isStacked(props.segments, props.gap, surface.columns)
  const line = isStackedNow ? props.segments.filter(segment => segment.role !== 'stat') : props.segments
  const stats = isStackedNow ? props.segments.filter(segment => segment.role === 'stat') : []
  // --- end rows ---
  return (
    <Box key="row" flexDirection="column" backgroundColor={lit} hover={background === '' ? undefined : { backgroundColor: background }}>
      <Box flexDirection="row">
        <Box flexShrink={0} width={1} marginRight={1}>
          <Text color="claude">{props.isOpen ? OPEN_BAR : ' '}</Text>
        </Box>
        <Box flexDirection="row" flexWrap="wrap" flexGrow={1} flexShrink={1} minWidth={0} columnGap={props.gap}>
          {line.map(cell)}
        </Box>
      </Box>
      {stats.length > 0 && (
        <Box key="stats" flexDirection="row" flexWrap="wrap" columnGap={statGap(props.gap)} marginLeft={BAR_CELLS}>
          {stats.map(segment => cell({ ...segment, width: 0 }))}
        </Box>
      )}
    </Box>
  )
}

export default Row

// --- file tree ---
export type RowPart = { text: string; color: string; dim: boolean }

/** A cell's text, or its runs of their own color where it has them (a permission string). */
const cellText = (segment: RowSegment, Text: ClientElements['Text']): string | RenderElement[] =>
  segment.parts === undefined
    ? segment.text
    : segment.parts.map(part => (
        <Text color={part.color === '' ? undefined : part.color} dimColor={part.dim}>
          {part.text}
        </Text>
      ))
// --- end file tree ---

// --- rows ---
/** The cells ahead of a row's segments: the open bar and the cell after it; the stats line is set in as far. */
export const BAR_CELLS = 2

/** The room a title keeps on its line before the stats move under it, in cells; a shorter title needs only its own. */
export const TITLE_ROOM = 24

/** The gap between figures on the line under a title: half the row's, at least a cell, so they fit one line. */
export const statGap = (gap: number): number => Math.max(1, Math.floor(gap / 2))

/** The room a growing cell (the title) starts at: its text's cells, at most TITLE_ROOM. */
export const growRoom = (text: string): number => Math.max(1, Math.min(TITLE_ROOM, textCells(text)))

/** Whether a code point joins the one before it in the same cell: a combining mark, a variation selector or a zero-width joiner. */
const isJoining = (code: number): boolean =>
  (code >= 0x0300 && code <= 0x036f) || (code >= 0x200b && code <= 0x200f) || (code >= 0x20d0 && code <= 0x20ff) || (code >= 0xfe00 && code <= 0xfe0f)

/** Whether a code point takes two cells: Hangul, CJK, full-width forms and emoji. */
const isWide = (code: number): boolean =>
  (code >= 0x1100 && code <= 0x115f) ||
  (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
  (code >= 0xac00 && code <= 0xd7a3) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xfe30 && code <= 0xfe4f) ||
  (code >= 0xff00 && code <= 0xff60) ||
  (code >= 0xffe0 && code <= 0xffe6) ||
  (code >= 0x1f300 && code <= 0x1faff) ||
  (code >= 0x20000 && code <= 0x3fffd)

/** The cells a text takes, a character a cell: two for a wide one, none for one that joins the character before. */
export const textCells = (text: string): number => {
  let cells = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    cells += isJoining(code) ? 0 : isWide(code) ? 2 : 1
  }
  return cells
}

/** The cells a segment takes: its fixed width, else its text's. */
const segmentCells = (segment: RowSegment): number => (segment.width > 0 ? segment.width : textCells(segment.text))

/**
 * Whether a row draws its stats under its title: when one line cannot hold
 * every cell with `gap` between them and still leave the title its room. A
 * row with no stats keeps one line, as does one not laid out yet (0 columns).
 */
export const isStacked = (segments: readonly RowSegment[], gap: number, columns: number): boolean => {
  if (columns <= 0 || !segments.some(segment => segment.role === 'stat')) {
    return false
  }
  const title = segments.find(segment => segment.role === 'title')
  const titleRoom = title === undefined ? 0 : Math.min(TITLE_ROOM, textCells(title.text))
  const others = segments.filter(segment => segment.role !== 'title').reduce((total, segment) => total + segmentCells(segment), 0)
  return BAR_CELLS + others + titleRoom + gap * Math.max(0, segments.length - 1) > columns
}
// --- end rows ---
