// The code view: a file or a diff drawn as an editor draws it, in SVG for
// the surfaces that draw Svg. A monospace font on a dark editor background,
// a line-number gutter (two for a diff: the old file's and the new one's),
// + and − markers on tinted rows, syntax colours by language, and long lines
// wrapped under the code column.
//
// Two builds of the same drawing: `renderCodeView` for a surface that draws
// the SVG as an image, and `renderSelectableView` for one that draws it in a
// frame (the desktop, given `isInteractive`), where the person can select the
// code with the mouse and copy it, without the line numbers and markers.

import { languageOf, START, tokenizeLine, type LexState, type Token, type TokenKind } from './highlight'

export type RowKind = 'hunk' | 'context' | 'add' | 'del' | 'line'

/** One line of the view, before wrapping: a diff's line with its old and new numbers, or a file's. */
export type CodeRow = { kind: RowKind; oldNo?: number; newNo?: number; text: string }

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

/** Tabs as four spaces, control characters gone: what the view draws of a line. */
const visible = (line: string): string =>
  line
    .replace(/\t/g, '    ')
    .replace(/[\u0000-\u001f\u007f]/g, '')

/** A unified diff's hunks as rows, each line numbered in the old file, the new one or both. */
export const diffRows = (diff: string): CodeRow[] => {
  const rows: CodeRow[] = []
  let oldNo = 0
  let newNo = 0
  for (const line of diff.split('\n')) {
    const hunk = HUNK.exec(line)
    if (hunk !== null) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      rows.push({ kind: 'hunk', text: visible(line) })
    } else if (line.startsWith('+')) {
      rows.push({ kind: 'add', newNo, text: visible(line.slice(1)) })
      newNo += 1
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', oldNo, text: visible(line.slice(1)) })
      oldNo += 1
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file": not a line of either file.
    } else if (rows.length > 0) {
      rows.push({ kind: 'context', oldNo, newNo, text: visible(line.slice(1)) })
      oldNo += 1
      newNo += 1
    }
  }
  return rows
}

/** A file's lines as rows numbered from `startLine`. */
export const contentRows = (text: string, startLine = 1): CodeRow[] => {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines.map((line, index) => ({ kind: 'line', newNo: startLine + index, text: visible(line) }))
}

/** Each row's tokens: the new file's lines carry one lexer state through, the old file's another; a hunk starts both afresh. */
export const highlightRows = (rows: readonly CodeRow[], path: string): Token[][] => {
  const lang = languageOf(path)
  let newState: LexState = START
  let oldState: LexState = START
  return rows.map(row => {
    if (row.kind === 'hunk') {
      newState = START
      oldState = START
      return [{ text: row.text, kind: 'plain' }]
    }
    if (row.kind === 'del') {
      const result = tokenizeLine(row.text, lang, oldState)
      oldState = result.state
      return result.tokens
    }
    const result = tokenizeLine(row.text, lang, newState)
    newState = result.state
    if (row.kind === 'context') {
      oldState = tokenizeLine(row.text, lang, oldState).state
    }
    return result.tokens
  })
}

/** The VS Code Dark+ colours. */
export const THEME = {
  background: '#1e1e1e',
  titleBar: '#252526',
  titleText: '#cccccc',
  titleDim: '#8b8b8b',
  gutterText: '#6e7681',
  gutterCurrent: '#c6c6c6',
  hunkBackground: '#2a2d3e',
  hunkText: '#8b949e',
  addBackground: '#2ea04326',
  addGutter: '#2ea0434d',
  addMarker: '#3fb950',
  delBackground: '#f8514926',
  delGutter: '#f851494d',
  delMarker: '#f85149',
  wrapMarker: '#4b4b4b',
} as const

export const TOKEN_COLORS: Readonly<Record<TokenKind, string>> = {
  plain: '#d4d4d4',
  keyword: '#569cd6',
  control: '#c586c0',
  string: '#ce9178',
  comment: '#6a9955',
  number: '#b5cea8',
  function: '#dcdcaa',
  type: '#4ec9b0',
  constant: '#4fc1ff',
  decorator: '#dcdcaa',
  variable: '#9cdcfe',
  key: '#9cdcfe',
  heading: '#569cd6',
}

/** Font metrics the layout assumes: a 13 px monospace font, 20 px lines. */
export const FONT_SIZE = 13
export const LINE_HEIGHT = 20
/** The width of one character of the font at FONT_SIZE, as Chromium measures it. */
export const CHAR_WIDTH = 7.83
const TITLE_HEIGHT = 30
const PAD_X = 12
/** The room an editor leaves under the last line. */
const BOTTOM_PAD = 6
const FONT = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace"

/** Most of one Svg's source; an element holds at most 131,072 characters. */
export const CHUNK_CHARS = 110_000
/**
 * Most SVG markup one view draws in all; past it, the rest is left out and
 * said so. The desktop app's renderer counts an Svg's whole source against
 * the 262,144 characters it draws of a pane (lib/fit.ts DESKTOP_LIMITS), so a
 * view leaves the list beside it its own budget.
 */
export const MAX_VIEW_CHARS = 120_000
/** The most CSS pixels an Svg's `width` or `height` may be: past it the engine refuses the tree. */
export const MAX_SVG_PX = 4096

export type CodeViewOptions = {
  path: string
  /** The body's width in monospace cells: the view is drawn that many characters wide. */
  columns: number
  isDiff: boolean
}

export type CodeView = {
  /** The SVG documents, drawn one under another. */
  chunks: string[]
  /** Rows (before wrapping) the view left out to stay within MAX_VIEW_CHARS. */
  hiddenRows: number
}

const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Text as SVG draws it: escaped, with every space a no-break space, which no
 * renderer collapses and which is as wide as a space in a monospace font.
 * Indentation then survives wherever the SVG is drawn, `xml:space` or not.
 */
const spaced = (text: string): string => escape(text).replace(/ /g, '\u00a0')

const px = (value: number): string => (Math.round(value * 10) / 10).toString()

/** Tokens cut into rows of at most `width` characters, words kept whole where they fit. */
export const wrapTokens = (tokens: readonly Token[], width: number): Token[][] => {
  const rows: Token[][] = [[]]
  let used = 0
  const add = (text: string, kind: TokenKind): void => {
    const row = rows[rows.length - 1] ?? []
    const last = row[row.length - 1]
    if (last !== undefined && last.kind === kind) {
      last.text += text
    } else {
      row.push({ text, kind })
    }
    used += text.length
  }
  for (const token of tokens) {
    let text = token.text
    while (text !== '') {
      const room = width - used
      if (text.length <= room) {
        add(text, token.kind)
        break
      }
      // Break at the last space within the room, else hard-cut.
      const space = text.lastIndexOf(' ', room)
      const cut = room > 0 && space > 0 && used + space > width / 3 ? space + 1 : Math.max(room, 0)
      if (cut > 0) {
        add(text.slice(0, cut), token.kind)
        text = text.slice(cut)
      }
      rows.push([])
      used = 0
      if (cut === 0 && room <= 0) {
        continue
      }
    }
  }
  return rows
}

type Visual = { row: CodeRow; tokens: Token[]; isFirst: boolean }

/** The view's layout for the rows: gutter and code columns, in characters. */
const layout = (options: CodeViewOptions, rows: readonly CodeRow[]): { width: number; gutterChars: number; codeChars: number; digits: number } => {
  const top = Math.max(1, ...rows.map(row => Math.max(row.oldNo ?? 0, row.newNo ?? 0)))
  const digits = Math.max(3, String(top).length)
  // Old and new numbers and the marker for a diff; one number for a file.
  const gutterChars = options.isDiff ? digits * 2 + 5 : digits + 2
  const columns = Math.max(60, Math.min(400, options.columns))
  const width = columns * CHAR_WIDTH
  const codeChars = Math.max(20, Math.floor((width - PAD_X * 2) / CHAR_WIDTH) - gutterChars - 1)
  return { width, gutterChars, codeChars, digits }
}

const rowFill = (kind: RowKind): { body?: string; gutter?: string } =>
  kind === 'add'
    ? { body: THEME.addBackground, gutter: THEME.addGutter }
    : kind === 'del'
      ? { body: THEME.delBackground, gutter: THEME.delGutter }
      : kind === 'hunk'
        ? { body: THEME.hunkBackground }
        : {}

/** One visual row's markup at `y` (its top). */
const rowMarkup = (visual: Visual, y: number, width: number, gutterChars: number, digits: number, isDiff: boolean): string => {
  const { row, tokens, isFirst } = visual
  const fill = rowFill(row.kind)
  const baseline = y + LINE_HEIGHT * 0.7
  const gutterWidth = PAD_X + gutterChars * CHAR_WIDTH
  const codeX = gutterWidth + CHAR_WIDTH
  const parts: string[] = []
  if (fill.body !== undefined) {
    parts.push(`<rect x="0" y="${px(y)}" width="${px(width)}" height="${LINE_HEIGHT}" fill="${fill.body}"/>`)
  }
  if (fill.gutter !== undefined) {
    parts.push(`<rect x="0" y="${px(y)}" width="${px(gutterWidth)}" height="${LINE_HEIGHT}" fill="${fill.gutter}"/>`)
  }
  if (row.kind === 'hunk') {
    parts.push(`<text x="${px(PAD_X)}" y="${px(baseline)}" fill="${THEME.hunkText}" font-style="italic">${spaced(row.text)}</text>`)
    return parts.join('')
  }
  if (isFirst) {
    const number = (value: number | undefined): string => (value === undefined ? '' : String(value)).padStart(digits, ' ')
    const gutter = isDiff ? `${number(row.oldNo)} ${number(row.newNo)}` : number(row.newNo)
    parts.push(`<text x="${px(PAD_X)}" y="${px(baseline)}" fill="${THEME.gutterText}">${spaced(gutter)}</text>`)
    if (isDiff && (row.kind === 'add' || row.kind === 'del')) {
      const markerX = PAD_X + (digits * 2 + 2) * CHAR_WIDTH
      const color = row.kind === 'add' ? THEME.addMarker : THEME.delMarker
      parts.push(`<text x="${px(markerX)}" y="${px(baseline)}" fill="${color}" font-weight="bold">${row.kind === 'add' ? '+' : '−'}</text>`)
    }
  } else {
    parts.push(`<text x="${px(gutterWidth - CHAR_WIDTH)}" y="${px(baseline)}" fill="${THEME.wrapMarker}">↪</text>`)
  }
  if (tokens.length > 0) {
    const spans = tokens
      .map(token => (token.kind === 'plain' ? spaced(token.text) : `<tspan fill="${TOKEN_COLORS[token.kind]}">${spaced(token.text)}</tspan>`))
      .join('')
    parts.push(`<text x="${px(codeX)}" y="${px(baseline)}" fill="${TOKEN_COLORS.plain}">${spans}</text>`)
  }
  return parts.join('')
}

const svgOpen = (width: number, height: number): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${px(width)}" height="${px(height)}" viewBox="0 0 ${px(width)} ${px(height)}" ` +
  `font-family="${escape(FONT)}" font-size="${FONT_SIZE}" xml:space="preserve" style="white-space:pre">` +
  `<rect width="100%" height="100%" fill="${THEME.background}"/>`

/**
 * The title bar, as an editor's tab shows a file: its name, then its folder
 * dim. `text` writes its words (no-break spaces in an image, plain spaces in
 * a frame) and `mark` classes it, so a frame's title is never selected.
 */
const titleMarkup = (path: string, width: number, note: string, text: (raw: string) => string = spaced, mark = ''): string => {
  const name = path.split('/').pop() ?? path
  const folder = path.slice(0, Math.max(0, path.length - name.length - 1))
  const baseline = TITLE_HEIGHT * 0.65
  return (
    `<rect width="${px(width)}" height="${TITLE_HEIGHT}" fill="${THEME.titleBar}"/>` +
    `<text${mark} x="${px(PAD_X)}" y="${px(baseline)}" fill="${THEME.titleText}" font-weight="bold">${text(name)}` +
    `<tspan fill="${THEME.titleDim}" font-weight="normal">${text(folder === '' ? '' : `  ${folder}`)}${text(note === '' ? '' : `  ·  ${note}`)}</tspan></text>`
  )
}

/**
 * The view as SVG documents of at most CHUNK_CHARS each, to stack one under
 * another; the first carries the title bar. Rows past MAX_VIEW_CHARS are left
 * out and counted.
 */
export const renderCodeView = (rows: readonly CodeRow[], options: CodeViewOptions, note = ''): CodeView => {
  const { width, gutterChars, codeChars, digits } = layout(options, rows)
  const highlighted = highlightRows(rows, options.path)
  const chunks: string[] = []
  let body: string[] = []
  let bodyChars = 0
  let bodyRows = 0
  let total = 0
  let hiddenRows = 0
  let top = TITLE_HEIGHT
  let title = titleMarkup(options.path, width, note)
  const close = (): void => {
    if (bodyRows === 0 && title === '') {
      return
    }
    const height = top
    chunks.push(`${svgOpen(width, height)}${title}${body.join('')}</svg>`)
    total += bodyChars
    body = []
    bodyChars = 0
    bodyRows = 0
    top = 0
    title = ''
  }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (row === undefined) {
      continue
    }
    const pieces = row.kind === 'hunk' ? [[{ text: row.text, kind: 'plain' as const }]] : wrapTokens(highlighted[index] ?? [], codeChars)
    const markup = pieces.map((tokens, piece) => rowMarkup({ row, tokens, isFirst: piece === 0 }, top + piece * LINE_HEIGHT, width, gutterChars, digits, options.isDiff)).join('')
    if (total + bodyChars + markup.length > MAX_VIEW_CHARS) {
      hiddenRows = rows.length - index
      break
    }
    if (bodyChars + markup.length > CHUNK_CHARS && bodyRows > 0) {
      close()
      const again = pieces.map((tokens, piece) => rowMarkup({ row, tokens, isFirst: piece === 0 }, top + piece * LINE_HEIGHT, width, gutterChars, digits, options.isDiff)).join('')
      body.push(again)
      bodyChars += again.length
    } else {
      body.push(markup)
      bodyChars += markup.length
    }
    bodyRows += 1
    top += pieces.length * LINE_HEIGHT
  }
  // A little room under the last line, as an editor leaves.
  top += BOTTOM_PAD
  close()
  return { chunks, hiddenRows }
}

// --- selectable view ---

/** One SVG document of a selectable view and its size in CSS pixels at full scale, each within MAX_SVG_PX. */
export type CodeFrame = { source: string; width: number; height: number }

export type SelectableView = {
  /** The SVG documents, drawn one under another; a selection stays within one. */
  frames: CodeFrame[]
  /** Rows (before wrapping) the view left out to stay within MAX_VIEW_CHARS. */
  hiddenRows: number
}

/**
 * The rules a frame needs for its text to be selected as code. SVG text
 * collapses spaces unless told otherwise (the browser sets `white-space` on
 * every `text`), so indentation is kept by a rule rather than by no-break
 * spaces, which a copy would carry into the code. The editor's own marks (`n`:
 * title, line numbers, markers, wrap marks, hunk headers) cannot be selected.
 * The frame's page takes the editor's background: where a frame is drawn
 * narrower than its drawing, which then shrinks to fit, the room left under
 * the code is editor, not a gap.
 */
const FRAME_STYLE =
  `<style>text{white-space:pre}.n{-webkit-user-select:none;user-select:none}html,body{background:${THEME.background}}</style>`

/** An editor mark: drawn, never selected. */
const MARK = ' class="n"'

const frameOpen = (width: number, height: number): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${px(width)}" height="${px(height)}" viewBox="0 0 ${px(width)} ${px(height)}" ` +
  `preserveAspectRatio="xMinYMin meet" font-family="${escape(FONT)}" font-size="${FONT_SIZE}" xml:space="preserve" style="white-space:pre">` +
  FRAME_STYLE +
  `<rect width="100%" height="100%" fill="${THEME.background}"/>`

type Geometry = { width: number; gutterChars: number; digits: number; isDiff: boolean }

/**
 * One line's visual rows `from` to `to` (exclusive), drawn from `top`: its
 * tints and marks as the image view draws them, and its code as one `text`
 * whatever it wraps to, so a copy reads the line back whole. A blank line is
 * one space, so a copy across it keeps it as a line.
 */
const frameRowMarkup = (row: CodeRow, pieces: readonly Token[][], from: number, to: number, top: number, geometry: Geometry): string => {
  const { width, gutterChars, digits, isDiff } = geometry
  const fill = rowFill(row.kind)
  const height = (to - from) * LINE_HEIGHT
  const gutterWidth = PAD_X + gutterChars * CHAR_WIDTH
  const codeX = gutterWidth + CHAR_WIDTH
  const baseline = (piece: number): number => top + (piece - from) * LINE_HEIGHT + LINE_HEIGHT * 0.7
  const parts: string[] = []
  if (fill.body !== undefined) {
    parts.push(`<rect x="0" y="${px(top)}" width="${px(width)}" height="${height}" fill="${fill.body}"/>`)
  }
  if (fill.gutter !== undefined) {
    parts.push(`<rect x="0" y="${px(top)}" width="${px(gutterWidth)}" height="${height}" fill="${fill.gutter}"/>`)
  }
  if (row.kind === 'hunk') {
    parts.push(`<text${MARK} x="${px(PAD_X)}" y="${px(baseline(from))}" fill="${THEME.hunkText}" font-style="italic">${escape(row.text)}</text>`)
    return parts.join('')
  }
  for (let piece = from; piece < to; piece += 1) {
    if (piece === 0) {
      const number = (value: number | undefined): string => (value === undefined ? '' : String(value)).padStart(digits, ' ')
      const gutter = isDiff ? `${number(row.oldNo)} ${number(row.newNo)}` : number(row.newNo)
      parts.push(`<text${MARK} x="${px(PAD_X)}" y="${px(baseline(piece))}" fill="${THEME.gutterText}">${escape(gutter)}</text>`)
      if (isDiff && (row.kind === 'add' || row.kind === 'del')) {
        const markerX = PAD_X + (digits * 2 + 2) * CHAR_WIDTH
        const color = row.kind === 'add' ? THEME.addMarker : THEME.delMarker
        parts.push(`<text${MARK} x="${px(markerX)}" y="${px(baseline(piece))}" fill="${color}" font-weight="bold">${row.kind === 'add' ? '+' : '−'}</text>`)
      }
    } else {
      parts.push(`<text${MARK} x="${px(gutterWidth - CHAR_WIDTH)}" y="${px(baseline(piece))}" fill="${THEME.wrapMarker}">↪</text>`)
    }
  }
  const spans = pieces
    .slice(from, to)
    .map(tokens => tokens.map(token => (token.kind === 'plain' ? escape(token.text) : `<tspan fill="${TOKEN_COLORS[token.kind]}">${escape(token.text)}</tspan>`)).join(''))
  const [first = ''] = spans
  const code =
    spans.length > 1
      ? spans.map((inner, index) => `<tspan x="${px(codeX)}" y="${px(baseline(from + index))}">${inner}</tspan>`).join('')
      : first === ''
        ? ' '
        : first
  parts.push(`<text x="${px(codeX)}" y="${px(baseline(from))}" fill="${TOKEN_COLORS.plain}">${code}</text>`)
  return parts.join('')
}

/**
 * The view as SVG documents for frames: the same drawing as `renderCodeView`
 * (title bar, gutters, markers, tints, colours, wrapping), but with text that
 * selects and copies as the code. Each document is at most CHUNK_CHARS and at
 * most MAX_SVG_PX tall, since a frame is drawn at a height it is given; a line
 * wrapped past a whole frame's height goes on in the next. Rows past
 * MAX_VIEW_CHARS are left out and counted.
 */
export const renderSelectableView = (rows: readonly CodeRow[], options: CodeViewOptions, note = ''): SelectableView => {
  const { width, gutterChars, codeChars, digits } = layout(options, rows)
  const geometry: Geometry = { width, gutterChars, digits, isDiff: options.isDiff }
  const highlighted = highlightRows(rows, options.path)
  const room = MAX_SVG_PX - BOTTOM_PAD
  const frames: CodeFrame[] = []
  let body: string[] = []
  let bodyChars = 0
  let total = 0
  let hiddenRows = 0
  let top = TITLE_HEIGHT
  let title = titleMarkup(options.path, width, note, escape, MARK)
  const close = (): void => {
    if (body.length === 0 && title === '') {
      return
    }
    frames.push({ source: `${frameOpen(width, top)}${title}${body.join('')}</svg>`, width, height: top })
    total += bodyChars
    body = []
    bodyChars = 0
    top = 0
    title = ''
  }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (row === undefined) {
      continue
    }
    const pieces = row.kind === 'hunk' ? [[{ text: row.text, kind: 'plain' as const }]] : wrapTokens(highlighted[index] ?? [], codeChars)
    const whole = frameRowMarkup(row, pieces, 0, pieces.length, top, geometry).length
    if (total + bodyChars + whole > MAX_VIEW_CHARS) {
      hiddenRows = rows.length - index
      break
    }
    // A line starts a new frame rather than break across two, where one frame holds it: a selection stays within a frame.
    const tall = pieces.length * LINE_HEIGHT
    if (body.length > 0 && (top + tall > room || bodyChars + whole > CHUNK_CHARS) && tall <= room && whole <= CHUNK_CHARS) {
      close()
    }
    let from = 0
    while (from < pieces.length) {
      const fits = Math.floor((room - top) / LINE_HEIGHT)
      if (fits < 1) {
        close()
        continue
      }
      let to = Math.min(pieces.length, from + fits)
      let markup = frameRowMarkup(row, pieces, from, to, top, geometry)
      while (bodyChars + markup.length > CHUNK_CHARS && to - from > 1) {
        to = from + Math.floor((to - from) / 2)
        markup = frameRowMarkup(row, pieces, from, to, top, geometry)
      }
      if (bodyChars + markup.length > CHUNK_CHARS && body.length > 0) {
        close()
        continue
      }
      body.push(markup)
      bodyChars += markup.length
      top += (to - from) * LINE_HEIGHT
      from = to
    }
  }
  top += BOTTOM_PAD
  close()
  return { frames, hiddenRows }
}
// --- end selectable view ---
