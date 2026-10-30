// Charts as SVG documents, for the surfaces that draw Svg: a time chart (a
// line over a soft area, a grid, both axes labelled, a legend with the
// latest values), stat cards with a sparkline each, horizontal bars, and a
// stacked share bar, each with the size it draws at; and how wide a chart is
// drawn in a pane. Mid-tone ink and translucent cards read on light and dark
// themes alike. Pure.

import { MAX_SVG_PX } from './codeview'

/** A chart's SVG document and the size it draws at, in CSS pixels: the document's own `width` and `height`. */
export type ChartSvg = { source: string; width: number; height: number }

/** The labels' font: the system's UI face. */
export const CHART_FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
/** Labels, ticks and notes. */
export const INK = '#8b8b8b'
/** Names that should read first (a bar's label). */
export const STRONG_INK = '#a3a3a3'
const GRID = '#7f7f7f'
const CARD_FILL = 'fill="#7f7f7f" fill-opacity="0.07" stroke="#7f7f7f" stroke-opacity="0.22"'
const RADIUS = 10

/** Text as SVG markup takes it. */
export const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

const px = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1))

/** About how wide a label draws at `size` px (the UI face averages near 0.58 em a character). */
export const textWidth = (text: string, size: number): number => [...text].length * size * 0.58

const open = (width: number, height: number): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${px(width)}" height="${px(height)}" viewBox="0 0 ${px(width)} ${px(height)}" ` +
  `font-family="${escapeXml(CHART_FONT)}" font-size="11" style="font-variant-numeric:tabular-nums">`

const card = (x: number, y: number, width: number, height: number): string =>
  `<rect x="${px(x + 0.5)}" y="${px(y + 0.5)}" width="${px(Math.max(0, width - 1))}" height="${px(Math.max(0, height - 1))}" rx="${RADIUS}" ${CARD_FILL}/>`

/** The step of a round scale near `rough`: 1, 2, 2.5 or 5 times a power of ten. */
export const niceStep = (rough: number): number => {
  if (!(rough > 0) || !Number.isFinite(rough)) {
    return 1
  }
  const power = 10 ** Math.floor(Math.log10(rough))
  const scaled = rough / power
  const factor = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10
  return factor * power
}

/** An axis label without the zeros a round step leaves: `8.00 W` reads `8 W`, `1.50 GB` reads `1.5 GB`. */
export const trimZeros = (label: string): string => label.replace(/(\d)\.0+(?!\d)/g, '$1').replace(/(\.\d*?[1-9])0+(?!\d)/g, '$1')

/** The axis' ticks from 0 to a round top at or above `max`, `count` steps. */
export const axisTicks = (max: number, count = 4): number[] => {
  const step = niceStep((max > 0 ? max : 1) / count)
  const steps = Math.max(1, Math.ceil((max > 0 ? max : 1) / step - 1e-9))
  return Array.from({ length: steps + 1 }, (_, index) => index * step)
}

export type ChartSeries = {
  name: string
  color: string
  /** One value per time; null where the series has none. */
  values: readonly (number | null)[]
  /** Fills the area under the line with a soft gradient. */
  isArea?: boolean
  /** Drawn dashed and lighter: a peak beside a mean. */
  isDashed?: boolean
}

export type TimeTick = { t: number; label: string }

export type TimeChartSpec = {
  times: readonly number[]
  series: readonly ChartSeries[]
  width: number
  height: number
  /** How a value reads on the axis and in the legend. */
  format: (value: number) => string
  /** How the legend reads a series' latest value, where it says more than the axis (memory's share of the RAM); `format` when absent. */
  legend?: (value: number) => string
  /** Where the time axis starts and ends: the span shows whole even where data is missing. */
  from: number
  to: number
  ticks: readonly TimeTick[]
  /** A floor for the value axis' top, so near-idle noise is not drawn as a mountain. */
  minTop?: number
  /** Said in the middle when no series has a value. */
  empty?: string
}

const LEGEND_HEIGHT = 26
const AXIS_HEIGHT = 22

const lastValue = (values: readonly (number | null)[]): number | undefined => {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index]
    if (value !== null && value !== undefined && Number.isFinite(value)) {
      return value
    }
  }
  return undefined
}

/** A chart of series over time: legend on top, the value axis on the left, the time axis below. */
export const timeChart = (spec: TimeChartSpec): ChartSvg => {
  const { width, height, format } = spec
  const legend = spec.legend ?? format
  const values = spec.series.flatMap(one => one.values.filter((value): value is number => value !== null && Number.isFinite(value)))
  const top = Math.max(spec.minTop ?? 0, ...values, 0)
  const ticks = axisTicks(top)
  const axisTop = ticks[ticks.length - 1] ?? 1
  const labels = ticks.map(tick => (tick === 0 ? '0' : trimZeros(format(tick))))
  const left = 14 + Math.max(...labels.map(text => textWidth(text, 11)), 10)
  const right = width - 16
  const plotTop = LEGEND_HEIGHT + 8
  const bottom = height - AXIS_HEIGHT
  const span = Math.max(1, spec.to - spec.from)
  const xOf = (t: number): number => left + ((t - spec.from) / span) * (right - left)
  const yOf = (value: number): number => bottom - (Math.max(0, value) / axisTop) * (bottom - plotTop)
  const parts: string[] = [open(width, height), card(0, 0, width, height), '<defs>']
  spec.series.forEach((one, index) => {
    parts.push(
      `<linearGradient id="fill${index}" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0" stop-color="${one.color}" stop-opacity="0.34"/><stop offset="1" stop-color="${one.color}" stop-opacity="0.02"/></linearGradient>`,
    )
  })
  parts.push('</defs>')
  // The grid, and the value axis' labels.
  ticks.forEach((tick, index) => {
    const y = yOf(tick)
    const isBase = index === 0
    parts.push(
      `<line x1="${px(left)}" y1="${px(y)}" x2="${px(right)}" y2="${px(y)}" stroke="${GRID}" stroke-opacity="${isBase ? 0.45 : 0.2}"${isBase ? '' : ' stroke-dasharray="3 4"'}/>`,
      `<text x="${px(left - 8)}" y="${px(y + 4)}" text-anchor="end" fill="${INK}">${escapeXml(labels[index] ?? '')}</text>`,
    )
  })
  // The time axis.
  for (const tick of spec.ticks) {
    if (tick.t < spec.from - 1 || tick.t > spec.to + 1) {
      continue
    }
    const x = xOf(tick.t)
    const anchor = x - left < 24 ? 'start' : right - x < 24 ? 'end' : 'middle'
    parts.push(
      `<line x1="${px(x)}" y1="${px(bottom)}" x2="${px(x)}" y2="${px(bottom + 4)}" stroke="${GRID}" stroke-opacity="0.45"/>`,
      `<text x="${px(x)}" y="${px(height - 7)}" text-anchor="${anchor}" fill="${INK}">${escapeXml(tick.label)}</text>`,
    )
  }
  // Each series: its area, its line (broken where it has no value), and a dot on its latest point.
  spec.series.forEach((one, index) => {
    const runs: { x: number; y: number }[][] = [[]]
    one.values.forEach((value, at) => {
      const t = spec.times[at]
      if (value === null || t === undefined || !Number.isFinite(value)) {
        if ((runs[runs.length - 1] ?? []).length > 0) {
          runs.push([])
        }
        return
      }
      runs[runs.length - 1]?.push({ x: xOf(t), y: yOf(value) })
    })
    for (const run of runs) {
      if (run.length === 0) {
        continue
      }
      const line = run.map(point => `${px(point.x)},${px(point.y)}`).join(' ')
      const first = run[0]
      const last = run[run.length - 1]
      if (one.isArea === true && first !== undefined && last !== undefined && run.length > 1) {
        parts.push(`<path d="M${px(first.x)},${px(bottom)} L${line.replace(/ /g, ' L')} L${px(last.x)},${px(bottom)} Z" fill="url(#fill${index})"/>`)
      }
      parts.push(
        run.length > 1
          ? `<polyline points="${line}" fill="none" stroke="${one.color}" stroke-width="${one.isDashed === true ? 1.5 : 2}"` +
              `${one.isDashed === true ? ' stroke-dasharray="4 3" stroke-opacity="0.7"' : ''} stroke-linejoin="round" stroke-linecap="round"/>`
          : `<circle cx="${px(run[0]?.x ?? 0)}" cy="${px(run[0]?.y ?? 0)}" r="2" fill="${one.color}"/>`,
      )
    }
    const tail = runs.filter(run => run.length > 0).at(-1)?.at(-1)
    if (tail !== undefined && one.isDashed !== true) {
      parts.push(`<circle cx="${px(tail.x)}" cy="${px(tail.y)}" r="6" fill="${one.color}" fill-opacity="0.22"/>`, `<circle cx="${px(tail.x)}" cy="${px(tail.y)}" r="3" fill="${one.color}"/>`)
    }
  })
  // The legend: a swatch, the name and the latest value of each series.
  let x = 14
  for (const one of spec.series) {
    const latest = lastValue(one.values)
    const name = escapeXml(one.name)
    const value = latest === undefined ? '' : escapeXml(legend(latest))
    parts.push(
      one.isDashed === true
        ? `<line x1="${px(x)}" y1="17" x2="${px(x + 12)}" y2="17" stroke="${one.color}" stroke-width="2" stroke-dasharray="3 2"/>`
        : `<rect x="${px(x)}" y="12" width="12" height="10" rx="3" fill="${one.color}"/>`,
      `<text x="${px(x + 18)}" y="21" fill="${INK}">${name}</text>`,
    )
    x += 18 + textWidth(one.name, 11) + 6
    if (value !== '') {
      parts.push(`<text x="${px(x)}" y="21" fill="${one.color}" font-weight="600">${value}</text>`)
      x += textWidth(value, 11) + 18
    } else {
      x += 12
    }
  }
  if (values.length === 0) {
    parts.push(`<text x="${px(width / 2)}" y="${px((plotTop + bottom) / 2 + 4)}" text-anchor="middle" fill="${INK}">${escapeXml(spec.empty ?? 'No data yet')}</text>`)
  }
  parts.push('</svg>')
  return { source: parts.join(''), width, height }
}

/** A tick every 30 seconds over the last two minutes, as time before `to`. */
export const liveTicks = (to: number): TimeTick[] =>
  [120, 90, 60, 30, 0].map(seconds => ({ t: to - seconds * 1000, label: seconds === 0 ? 'now' : `−${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` }))

const MINUTE = 60_000
const CLOCK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 240, 480].map(minutes => minutes * MINUTE)

/** A wall-clock tick label: `2:05 PM`. */
export const clockLabel = (t: number): string => {
  const date = new Date(t)
  const hours = date.getHours()
  return `${hours % 12 === 0 ? 12 : hours % 12}:${String(date.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`
}

/** Round wall-clock ticks across a span: the shortest step that leaves at most `most` of them. */
export const clockTicks = (from: number, to: number, most = 6): TimeTick[] => {
  const span = Math.max(1, to - from)
  const step = CLOCK_STEPS.find(one => span / one <= most) ?? CLOCK_STEPS[CLOCK_STEPS.length - 1] ?? MINUTE
  const ticks: TimeTick[] = []
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) {
    ticks.push({ t, label: clockLabel(t) })
  }
  return ticks
}

/** A small line over the last values, for a stat card: x from `x0`, y within [`top`, `top + height`]. */
const sparkPath = (values: readonly number[], x0: number, width: number, top: number, height: number, color: string, id: string): string => {
  if (values.length < 2) {
    return ''
  }
  const high = Math.max(...values, 1e-9)
  const points = values.map((value, index) => ({ x: x0 + (index / (values.length - 1)) * width, y: top + height - (Math.max(0, value) / high) * height }))
  const line = points.map(point => `${px(point.x)},${px(point.y)}`).join(' ')
  return (
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity="0.3"/>` +
    `<stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>` +
    `<path d="M${px(x0)},${px(top + height)} L${line.replace(/ /g, ' L')} L${px(x0 + width)},${px(top + height)} Z" fill="url(#${id})"/>` +
    `<polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>`
  )
}

export type StatCard = {
  label: string
  value: string
  color: string
  note: string
  /** The recent values the card's sparkline draws; empty for none. */
  spark: readonly number[]
}

const CARD_MIN_WIDTH = 168
const CARD_HEIGHT = 104
const CARD_GAP = 12

/** How many cards a row takes at `width`, the rows as even as they can be: seven at five a row draw as four and three. */
export const cardsPerRow = (width: number, count: number): number => {
  if (count <= 0) {
    return 1
  }
  const most = Math.max(1, Math.min(count, Math.floor((width + CARD_GAP) / (CARD_MIN_WIDTH + CARD_GAP))))
  return Math.ceil(count / Math.ceil(count / most))
}

/** Stat cards in a grid: a label, a large value in its colour, a note, and a sparkline along the bottom. */
export const statCards = (cards: readonly StatCard[], width: number): ChartSvg => {
  const columns = cardsPerRow(width, cards.length)
  const rows = Math.max(1, Math.ceil(cards.length / columns))
  const cardWidth = (width - CARD_GAP * (columns - 1)) / columns
  const height = rows * CARD_HEIGHT + (rows - 1) * CARD_GAP
  const parts: string[] = [open(width, height)]
  cards.forEach((one, index) => {
    const x = (index % columns) * (cardWidth + CARD_GAP)
    const y = Math.floor(index / columns) * (CARD_HEIGHT + CARD_GAP)
    const room = cardWidth - 28
    const valueSize = Math.max(14, Math.min(24, room / Math.max(1, [...one.value].length * 0.6)))
    parts.push(
      card(x, y, cardWidth, CARD_HEIGHT),
      `<text x="${px(x + 14)}" y="${px(y + 24)}" fill="${INK}" font-size="11" font-weight="600" letter-spacing="0.06em">${escapeXml(one.label.toUpperCase())}</text>`,
      `<text x="${px(x + 14)}" y="${px(y + 54)}" fill="${one.color}" font-size="${px(valueSize)}" font-weight="700">${escapeXml(one.value)}</text>`,
      `<text x="${px(x + 14)}" y="${px(y + 72)}" fill="${INK}" font-size="11">${escapeXml(fitText(one.note, room, 11))}</text>`,
      sparkPath(one.spark, x + 14, cardWidth - 28, y + 78, 16, one.color, `spark${index}`),
    )
  })
  parts.push('</svg>')
  return { source: parts.join(''), width, height }
}

/** Text cut with an ellipsis to fit `room` px at `size`. */
export const fitText = (text: string, room: number, size: number): string => {
  const chars = [...text]
  const most = Math.max(1, Math.floor(room / (size * 0.58)))
  return chars.length <= most ? text : `${chars.slice(0, Math.max(1, most - 1)).join('')}…`
}

export type BarRow = {
  label: string
  value: number
  /** The value as it reads at the bar's end. */
  text: string
  color: string
  /** A dim second label under the first; '' for none. */
  note?: string
}

const BAR_ROW = 30
const BAR_ROW_NOTE = 42

/** Horizontal bars, one row each, scaled to the largest: label left, bar, value right. */
export const barChart = (rows: readonly BarRow[], width: number): ChartSvg => {
  const hasNotes = rows.some(row => (row.note ?? '') !== '')
  const rowHeight = hasNotes ? BAR_ROW_NOTE : BAR_ROW
  const height = Math.max(1, rows.length) * rowHeight + 16
  const labelWidth = Math.min(Math.max(120, width * 0.36), 340)
  const valueWidth = Math.min(140, Math.max(64, ...rows.map(row => textWidth(row.text, 11) + 12)))
  const barX = 14 + labelWidth + 12
  const barWidth = Math.max(40, width - barX - valueWidth - 14)
  const top = Math.max(1e-9, ...rows.map(row => row.value))
  const parts: string[] = [open(width, height), card(0, 0, width, height)]
  rows.forEach((row, index) => {
    const y = 8 + index * rowHeight
    const middle = y + (hasNotes ? 16 : rowHeight / 2)
    const filled = row.value > 0 ? Math.max(3, (row.value / top) * barWidth) : 0
    parts.push(
      `<text x="14" y="${px(middle + 4)}" fill="${STRONG_INK}">${escapeXml(fitText(row.label, labelWidth, 11))}</text>`,
      ...(hasNotes && (row.note ?? '') !== '' ? [`<text x="14" y="${px(middle + 18)}" fill="${INK}" font-size="10">${escapeXml(fitText(row.note ?? '', labelWidth, 10))}</text>`] : []),
      `<rect x="${px(barX)}" y="${px(middle - 5)}" width="${px(barWidth)}" height="10" rx="5" fill="${GRID}" fill-opacity="0.16"/>`,
      filled > 0 ? `<rect x="${px(barX)}" y="${px(middle - 5)}" width="${px(filled)}" height="10" rx="5" fill="${row.color}"/>` : '',
      `<text x="${px(width - 14)}" y="${px(middle + 4)}" text-anchor="end" fill="${row.color}" font-weight="600">${escapeXml(row.text)}</text>`,
    )
  })
  if (rows.length === 0) {
    parts.push(`<text x="${px(width / 2)}" y="${px(height / 2 + 4)}" text-anchor="middle" fill="${INK}">Nothing measured yet</text>`)
  }
  parts.push('</svg>')
  return { source: parts.join(''), width, height }
}

export type SharePart = { label: string; value: number; color: string; text: string }

/** One stacked bar of shares, with each part's colour, name, share and value in a legend under it. */
export const shareBar = (title: string, parts: readonly SharePart[], width: number): ChartSvg => {
  const total = parts.reduce((sum, part) => sum + Math.max(0, part.value), 0)
  const shown = parts.filter(part => part.value > 0)
  const legend = shown.map(part => ({ part, text: `${part.label} ${Math.round((part.value / Math.max(1e-9, total)) * 100)}% · ${part.text}` }))
  // Legend items flow in rows.
  const placed: { x: number; y: number; part: SharePart; text: string }[] = []
  let x = 14
  let y = 66
  for (const item of legend) {
    const itemWidth = 18 + textWidth(item.text, 11) + 16
    if (x + itemWidth > width - 14 && x > 14) {
      x = 14
      y += 20
    }
    placed.push({ x, y, ...item })
    x += itemWidth
  }
  const height = (placed.length === 0 ? 66 : y) + 18
  const out: string[] = [open(width, height), card(0, 0, width, height), `<text x="14" y="24" fill="${INK}" font-weight="600">${escapeXml(title)}</text>`]
  const barX = 14
  const barWidth = width - 28
  out.push(`<clipPath id="bar"><rect x="${px(barX)}" y="34" width="${px(barWidth)}" height="14" rx="7"/></clipPath>`, `<g clip-path="url(#bar)">`)
  out.push(`<rect x="${px(barX)}" y="34" width="${px(barWidth)}" height="14" fill="${GRID}" fill-opacity="0.16"/>`)
  let at = barX
  for (const part of shown) {
    const segment = (part.value / Math.max(1e-9, total)) * barWidth
    out.push(`<rect x="${px(at)}" y="34" width="${px(Math.max(0, segment - (segment > 3 ? 1 : 0)))}" height="14" fill="${part.color}"/>`)
    at += segment
  }
  out.push('</g>')
  if (shown.length === 0) {
    out.push(`<text x="14" y="${px(66)}" fill="${INK}">Nothing measured yet</text>`)
  }
  for (const item of placed) {
    out.push(
      `<rect x="${px(item.x)}" y="${px(item.y - 9)}" width="10" height="10" rx="3" fill="${item.part.color}"/>`,
      `<text x="${px(item.x + 16)}" y="${px(item.y)}" fill="${INK}">${escapeXml(item.text)}</text>`,
    )
  }
  out.push('</svg>')
  return { source: out.join(''), width, height }
}

// ------------------------------------------------------------------------- //
// How wide a chart is drawn in a pane
// ------------------------------------------------------------------------- //

/**
 * The desktop's measure of a pane: the columns a drawing is told are cells of
 * the pane's code font (12 px Anthropic Mono, 7.2 px across), while a Box's
 * padding counts in `ch` of the tree's body font (13 px Anthropic Sans, 7.85
 * px), as the code view measures them too.
 */
export const DESKTOP_CELL_PX = 7.2
export const DESKTOP_CH_PX = 7.85
/** What the pane's own padding takes from a chart's room off the terminal: `paddingX={1}` around every tab (pane.tsx), 1 ch each side. */
export const PANE_INSET_CH = 2
/** Pixels to spare, so rounding never leaves a chart wider than its room: a sliver beside one is unseen, one too wide is shrunk to fit. */
const FIT_SLACK_PX = 2
/** The narrowest a chart is drawn: a narrower room shrinks the drawing, its shape kept. */
export const MIN_CHART_PX = 320
/** The widest a chart is drawn: a wider room leaves space beside it. */
export const MAX_CHART_PX = 1800

/**
 * The room a chart has across a pane `columns` cells wide, inside `insetCh`
 * of padding: whole CSS pixels, a little to spare. The desktop counts the
 * columns down from the body's width, so the body is at least this wide.
 */
export const chartRoom = (columns: number, insetCh: number): number =>
  Math.max(1, Math.floor(columns * DESKTOP_CELL_PX - insetCh * DESKTOP_CH_PX - FIT_SLACK_PX))

/** The width a chart is drawn at in `room` px: the room itself, within the narrowest and widest a chart is drawn. */
export const chartWidth = (room: number): number => Math.max(MIN_CHART_PX, Math.min(MAX_CHART_PX, room))

/**
 * The size an Svg of `chart` is given in `room` px: the document's own where
 * it fits, else shrunk to the room with its shape kept, as an image of it
 * would be; in hundredths of a pixel, within the engine's bounds for an Svg.
 *
 * Given up front, an Svg's box keeps its size while a new source decodes. The
 * desktop builds each redraw's DOM afresh, every Svg a new image, and an image
 * with no size of its own is 0 px tall until it decodes: the column shrinks,
 * and a pane scrolled past the charts is pulled back up.
 */
export const chartSize = (chart: ChartSvg, room: number): { width: number; height: number } => {
  const scale = Math.min(1, room / chart.width, MAX_SVG_PX / chart.width, MAX_SVG_PX / chart.height)
  const size = (value: number): number => Math.max(1, Math.round(value * scale * 100) / 100)
  return { width: size(chart.width), height: size(chart.height) }
}
