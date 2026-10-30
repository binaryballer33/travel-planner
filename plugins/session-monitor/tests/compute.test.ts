import type { BoxProps, ElementConstructor, RenderElement, SvgProps, TextProps } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { addBatteryPoint, MAX_BATTERY_POINTS } from '../hooks/lib/battery'
import {
  axisTicks,
  barChart,
  cardsPerRow,
  chartRoom,
  chartSize,
  chartWidth,
  clockLabel,
  clockTicks,
  escapeXml,
  fitText,
  liveTicks,
  MAX_CHART_PX,
  MIN_CHART_PX,
  niceStep,
  PANE_INSET_CH,
  shareBar,
  statCards,
  timeChart,
  trimZeros,
  type ChartSvg,
} from '../hooks/lib/charts'
import { MAX_SVG_PX } from '../hooks/lib/codeview'
import { emptyLive } from '../hooks/lib/commands'
import { fmtBytes, fmtMemory, fmtPct } from '../hooks/lib/format'
import { coarsen, foldTrend, MAX_TREND, mergePoints, TREND_STEP_MS, type TrendSample } from '../hooks/lib/trend'
import { chartFit, fmtRam, frameOf, memoryOfRam, ramShare } from '../hooks/view/compute'
import { areaChart, chart } from '../hooks/view/kit'
import type { BatteryReading, TrendPoint } from '../types'
import { keysOf, laterTicks, NOW, PANE, RAM, seconds, start, TICK, world, type Drawable, tabButton } from './world'

const sample = (t: number, fields: Partial<TrendSample> = {}): TrendSample => ({
  t,
  cpuPct: 10,
  watts: 1,
  mem: 100,
  netInBps: 0,
  netOutBps: 0,
  diskRBps: 0,
  diskWBps: 0,
  energyJ: 0,
  cpuS: 0,
  netIn: 0,
  netOut: 0,
  ...fields,
})

/** A trend's first point; a test fails here when there is none. */
const firstPoint = (trend: readonly TrendPoint[]): TrendPoint => {
  const point = trend[0]
  if (point === undefined) {
    throw new Error('the trend has no point')
  }
  return point
}

/** The polylines' points of an SVG, as [x, y] pairs. */
const polylines = (svg: string): number[][][] =>
  [...svg.matchAll(/<polyline points="([^"]+)"/g)].map(match => (match[1] ?? '').split(' ').map(pair => pair.split(',').map(Number)))

/** The size an SVG document gives itself: its root's `width` and `height`. */
const ownSize = (source: string): { width: number; height: number } => {
  const match = /^<svg [^>]*?width="([\d.]+)" height="([\d.]+)"/.exec(source)
  return { width: Number(match?.[1] ?? 0), height: Number(match?.[2] ?? 0) }
}

/** An Svg as drawn: the key of the Box that holds it (an Svg keeps none of its own), the size its props give, and its document. */
type DrawnSvg = { key: string | undefined; alt: string; width: unknown; height: unknown; source: string }

/** A drawn element's own fields, read without trusting their shape. */
const nodeOf = (value: unknown): { type: unknown; props: Record<string, unknown>; children: unknown[] } | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const props: unknown = 'props' in value ? value.props : undefined
  const children: unknown = 'children' in value ? value.children : undefined
  return {
    type: 'type' in value ? value.type : undefined,
    props: typeof props === 'object' && props !== null ? { ...props } : {},
    children: Array.isArray(children) ? children : [],
  }
}

/** Every Svg a drawing holds, in document order, with the key of the nearest keyed Box around it. */
const drawnSvgs = async (ui: Drawable): Promise<DrawnSvg[]> => {
  const found: DrawnSvg[] = []
  const walk = (value: unknown, key: string | undefined): void => {
    const node = nodeOf(value)
    if (node === undefined) {
      return
    }
    if (node.type === 'Svg') {
      found.push({ key, alt: String(node.props.alt), width: node.props.width, height: node.props.height, source: String(node.props.source) })
      return
    }
    const own = node.type === 'Box' && typeof node.props.key === 'string' ? node.props.key : key
    node.children.forEach(child => walk(child, own))
  }
  walk(await ui.drawn(), undefined)
  return found
}

/** A sampler tick a few seconds after TICK, its figures changed, so the live tab draws anew. */
const laterTick = (index: number): Record<string, unknown> => ({
  ...TICK,
  t: seconds(NOW + 2_000 + index * 1_000),
  session: { ...TICK.session, cpuPct: 6 + index * 3, mem: 439e6 + index * 25e6, watts: 0.5 + index * 0.1, netInBps: 2_100_000 + index * 50_000 },
})

describe('the session trend', () => {
  test('ticks inside a step fold into one point: means weighted by ticks, peaks kept, the latest totals', () => {
    let trend: TrendPoint[] = []
    let step = TREND_STEP_MS
    for (const [offset, cpu, energy] of [
      [0, 10, 1],
      [2_000, 30, 2],
      [4_000, 20, 3],
    ] as const) {
      const folded = foldTrend(trend, step, sample(NOW + offset, { cpuPct: cpu, energyJ: energy, mem: cpu * 10 }))
      trend = folded.trend
      step = folded.stepMs
    }
    expect(trend).toHaveLength(1)
    expect(trend[0]).toMatchObject({ ticks: 3, cpuPct: 20, cpuPeak: 30, mem: 200, memPeak: 300, energyJ: 3 })
    expect(trend[0]?.t).toBe(Math.floor(NOW / TREND_STEP_MS) * TREND_STEP_MS)
    // The next step starts a point of its own.
    trend = foldTrend(trend, step, sample(NOW + TREND_STEP_MS + 1, { energyJ: 9 })).trend
    expect(trend).toHaveLength(2)
    expect(trend[1]?.energyJ).toBe(9)
    // A clock that went back adds nothing.
    expect(foldTrend(trend, step, sample(NOW - 60_000)).trend).toEqual(trend)
  })

  test('past MAX_TREND points the step doubles and neighbours merge, so a long session stays short', () => {
    let trend: TrendPoint[] = []
    let step = TREND_STEP_MS
    const ticks = (MAX_TREND + 1) * 5
    for (let index = 0; index < ticks; index += 1) {
      const folded = foldTrend(trend, step, sample(index * 2_000, { cpuS: index }))
      trend = folded.trend
      step = folded.stepMs
    }
    expect(step).toBe(TREND_STEP_MS * 2)
    expect(trend.length).toBeLessThanOrEqual(MAX_TREND)
    expect(trend.every(point => point.t % step === 0)).toBe(true)
    // Nothing is lost: every tick is counted once, and the latest totals stand.
    expect(trend.reduce((total, point) => total + point.ticks, 0)).toBe(ticks)
    expect(trend[trend.length - 1]?.cpuS).toBe(ticks - 1)
  })

  test('merging and re-cutting keep the earlier start and the later totals', () => {
    const a = firstPoint(foldTrend([], TREND_STEP_MS, sample(0, { cpuPct: 10, cpuS: 1 })).trend)
    const b: TrendPoint = { ...a, t: TREND_STEP_MS, cpuPct: 30, cpuPeak: 30, cpuS: 5, ticks: 3 }
    expect(mergePoints(a, b)).toMatchObject({ t: 0, ticks: 4, cpuPct: 25, cpuPeak: 30, cpuS: 5 })
    expect(coarsen([a, b], TREND_STEP_MS * 2)).toHaveLength(1)
  })

  test('the live figures carry the trend and each point the disk rates', () => {
    const live = emptyLive(NOW)
    expect(live.trend).toEqual([])
    expect(live.trendStepMs).toBe(TREND_STEP_MS)
  })
})

describe('charts', () => {
  test('round scales: 1, 2, 2.5 or 5 times a power of ten, from 0 to at least the top', () => {
    expect([0.3, 1.2, 2.2, 4, 7, 23, 0].map(niceStep)).toEqual([0.5, 2, 2.5, 5, 10, 25, 1])
    expect(axisTicks(37)).toEqual([0, 10, 20, 30, 40])
    expect(axisTicks(0)).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(axisTicks(1e9).at(-1)).toBeGreaterThanOrEqual(1e9)
  })

  test('time ticks: every 30 seconds over two minutes; round clock times over a session', () => {
    expect(liveTicks(NOW).map(tick => [tick.t, tick.label])).toEqual([
      [NOW - 120_000, '−2:00'],
      [NOW - 90_000, '−1:30'],
      [NOW - 60_000, '−1:00'],
      [NOW - 30_000, '−0:30'],
      [NOW, 'now'],
    ])
    const hour = new Date(2026, 9, 14, 14, 0, 0).getTime()
    expect(clockLabel(hour + 5 * 60_000)).toBe('2:05 PM')
    expect(clockLabel(new Date(2026, 9, 14, 0, 30).getTime())).toBe('12:30 AM')
    const ticks = clockTicks(hour + 60_000, hour + 50 * 60_000)
    expect(ticks.map(tick => tick.label)).toEqual(['2:10 PM', '2:20 PM', '2:30 PM', '2:40 PM', '2:50 PM'])
    expect(clockTicks(hour, hour + 3 * 60_000).length).toBeLessThanOrEqual(6)
  })

  test('a time chart: a card, a grid with labels, a line over a soft area, the latest value in the legend', () => {
    const times = [NOW - 2_000, NOW - 1_000, NOW]
    const drawn = timeChart({
      times,
      series: [
        { name: 'CPU', color: '#f59e0b', values: [10, 50, 30], isArea: true },
        { name: 'peak', color: '#f59e0b', values: [20, 80, null], isDashed: true },
      ],
      width: 600,
      height: 160,
      format: fmtPct,
      from: NOW - 120_000,
      to: NOW,
      ticks: liveTicks(NOW),
    })
    // The document and the size it draws at, which an Svg of it is given.
    expect(drawn).toMatchObject({ width: 600, height: 160 })
    const svg = drawn.source
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="160" viewBox="0 0 600 160"')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(svg).toContain('rx="10"')
    expect(svg).toContain('<linearGradient id="fill0"')
    expect(svg).toContain('fill="url(#fill0)"')
    expect(svg).toContain('stroke-dasharray="4 3"')
    // The axis runs from 0 to the peak in round steps; the legend carries the latest values.
    for (const text of ['>0<', '>20%<', '>40%<', '>60%<', '>80%<', '>−2:00<', '>now<', '>CPU<', '>30%<', '>peak<']) {
      expect(svg).toContain(text)
    }
    // Three points on the line, the latest at the right edge; the dashed peak breaks where it has no value.
    const [line, peak] = polylines(svg)
    expect(line).toHaveLength(3)
    expect(line?.[2]?.[0]).toBe(584)
    expect(peak).toHaveLength(2)
    // Higher values sit higher.
    expect((line?.[1]?.[1] ?? 0) < (line?.[0]?.[1] ?? 0)).toBe(true)
  })

  test('a chart with no values says so; a floor keeps idle noise flat', () => {
    const empty = timeChart({ times: [], series: [{ name: 'CPU', color: '#000', values: [] }], width: 400, height: 120, format: fmtPct, from: 0, to: 1, ticks: [], empty: 'Waiting for the sampler' })
    expect(empty.source).toContain('Waiting for the sampler')
    const flat = timeChart({ times: [0, 1], series: [{ name: 'CPU', color: '#000', values: [0.1, 0.2] }], width: 400, height: 120, format: value => `${value}%`, from: 0, to: 1, ticks: [], minTop: 5 }).source
    expect(flat).toContain('>6%<')
    expect(flat).not.toContain('>0.2%<<')
  })

  test('a legend may read the latest values its own way: memory with its share of the RAM, the axis in bytes alone', () => {
    const svg = timeChart({
      times: [0, 1],
      series: [{ name: 'Memory', color: '#10b981', values: [1.1e9, 1.21e9], isArea: true }],
      width: 600,
      height: 176,
      format: fmtBytes,
      legend: value => fmtMemory(value, RAM),
      from: 0,
      to: 1,
      ticks: [],
    }).source
    expect(svg).toContain('>1.21 GB (7.0%)<')
    for (const tick of ['>500 MB<', '>1 GB<', '>1.5 GB<']) {
      expect(svg).toContain(tick)
    }
    // The share is the legend's alone.
    expect(svg.match(/%/g)).toHaveLength(1)
  })

  test('stat cards: as many a row as fit, a value in its colour, a note, a sparkline', () => {
    // Six fit at 1200 px: seven draw as four and three, six as one row.
    expect(cardsPerRow(1200, 7)).toBe(4)
    expect(cardsPerRow(1200, 6)).toBe(6)
    expect(cardsPerRow(360, 7)).toBe(2)
    expect(cardsPerRow(100, 7)).toBe(1)
    expect(cardsPerRow(800, 0)).toBe(1)
    const cards = statCards(
      [
        { label: 'CPU', value: '12%', color: '#f59e0b', note: '4m of CPU time', spark: [1, 5, 3] },
        { label: 'Memory', value: '1.21 GB', color: '#10b981', note: 'peak 1.4 GB', spark: [] },
        { label: 'Disk', value: '0 B/s', color: '#ec4899', note: 'read 0 B · wrote 12.4 MB', spark: [0, 0] },
      ],
      400,
    )
    const svg = cards.source
    // Two a row at 400 px: two rows, 104 px each with a 12 px gap.
    expect(cards).toMatchObject({ width: 400, height: 220 })
    expect(ownSize(svg)).toEqual({ width: 400, height: 220 })
    expect(svg).toContain('>CPU<')
    expect(svg).toContain('fill="#f59e0b" font-size="24" font-weight="700">12%<')
    expect(svg).toContain('>peak 1.4 GB<')
    expect(svg).toContain('read 0 B · wrote 12.4 MB')
    expect(polylines(svg)).toHaveLength(2)
  })

  test('bars scale to the largest; labels are cut to fit and escaped', () => {
    const bars = barChart(
      [
        { label: 'Fix <the> "tests" & more', value: 30, text: '30 J', color: '#f97316', note: 'CPU 10s' },
        { label: 'x'.repeat(400), value: 15, text: '15 J', color: '#f97316' },
        { label: 'idle', value: 0, text: '0 J', color: '#f97316' },
      ],
      800,
    )
    const svg = bars.source
    // Three rows of 42 px (one has a note), and 16 px around them.
    expect(bars).toMatchObject({ width: 800, height: 142 })
    expect(ownSize(svg)).toEqual({ width: 800, height: 142 })
    expect(svg).toContain('Fix &lt;the&gt; &quot;tests&quot; &amp; more')
    expect(svg).toContain('…<')
    const widths = [...svg.matchAll(/<rect x="[\d.]+" y="[\d.]+" width="([\d.]+)" height="10" rx="5" fill="#f97316"\/>/g)].map(match => Number(match[1]))
    // The second is half the first; the idle one draws no bar.
    expect(widths).toHaveLength(2)
    expect(Math.round(((widths[1] ?? 0) / (widths[0] ?? 1)) * 100)).toBe(50)
    expect(barChart([], 400).source).toContain('Nothing measured yet')
  })

  test('a share bar: each part its slice, its name, share and value under it', () => {
    const bar = shareBar(
      'Energy',
      [
        { label: 'Claude engine', value: 75, color: '#d97757', text: '75 J' },
        { label: 'Commands you ran', value: 25, color: '#f59e0b', text: '25 J' },
        { label: 'This monitor', value: 0, color: '#6b7280', text: '0 J' },
      ],
      600,
    )
    const svg = bar.source
    // One row of legend under the bar.
    expect(bar).toMatchObject({ width: 600, height: 84 })
    expect(ownSize(svg)).toEqual({ width: 600, height: 84 })
    expect(svg).toContain('>Energy<')
    expect(svg).toContain('Claude engine 75% · 75 J')
    expect(svg).toContain('Commands you ran 25% · 25 J')
    expect(svg).not.toContain('This monitor')
    expect(shareBar('CPU', [], 600).source).toContain('Nothing measured yet')
  })

  test("axis labels lose the zeros a round step leaves", () => {
    expect(['8.00 W', '1.50 GB', '2.0%', '400 kB/s', '0.25 W', '1.20 MB/s', '10.0 J'].map(trimZeros)).toEqual(['8 W', '1.5 GB', '2%', '400 kB/s', '0.25 W', '1.2 MB/s', '10 J'])
    const svg = timeChart({ times: [0, 1], series: [{ name: 'Power', color: '#000', values: [3, 7] }], width: 400, height: 120, format: value => `${value.toFixed(2)} W`, from: 0, to: 1, ticks: [] }).source
    expect(svg).toContain('>8 W<')
    // The legend keeps its digits.
    expect(svg).toContain('>7.00 W<')
  })

  test('text for SVG: escaped, and cut to the room it has', () => {
    expect(escapeXml(`a<b>&"c'`)).toBe('a&lt;b&gt;&amp;&quot;c&apos;')
    expect(fitText('short', 200, 11)).toBe('short')
    expect(fitText('a much longer line of text', 60, 11)).toMatch(/…$/)
  })
})

describe('sizing a chart to the pane', () => {
  test('the room: the pane’s cells of 7.2 px less its padding of 1 ch a side, in whole pixels with a little to spare', () => {
    expect(PANE_INSET_CH).toBe(2)
    expect(chartRoom(120, PANE_INSET_CH)).toBe(846)
    // Never wider than the body the desktop counted the cells from, and no more than a few pixels narrower.
    for (const columns of [30, 84, 120, 200, 333]) {
      const room = chartRoom(columns, PANE_INSET_CH)
      expect(Number.isInteger(room)).toBe(true)
      expect(room).toBeLessThanOrEqual(columns * 7.2 - 2 * 7.85)
      expect(room).toBeGreaterThan(columns * 7.2 - 2 * 7.85 - 4)
    }
    expect(chartRoom(0, PANE_INSET_CH)).toBe(1)
  })

  test('the width a chart is drawn at: its room, within the narrowest and widest a chart is drawn', () => {
    expect(chartWidth(846)).toBe(846)
    expect(chartWidth(100)).toBe(MIN_CHART_PX)
    expect(chartWidth(9_000)).toBe(MAX_CHART_PX)
    expect(chartFit(120)).toEqual({ room: 846, width: 846 })
    expect(chartFit(84)).toEqual({ room: 587, width: 587 })
    // Too narrow for a chart: drawn at the narrowest and shrunk to the room.
    expect(chartFit(30)).toEqual({ room: 198, width: MIN_CHART_PX })
    // Wider than any chart is drawn: room is left beside it.
    expect(chartFit(400)).toEqual({ room: 2_862, width: MAX_CHART_PX })
  })

  test('the size an Svg is given: its document’s where it fits, else shrunk with its shape kept, never past the engine’s bounds', () => {
    const drawn = (width: number, height: number): ChartSvg => ({ source: '<svg/>', width, height })
    expect(chartSize(drawn(846, 176), 846)).toEqual({ width: 846, height: 176 })
    expect(chartSize(drawn(587, 336), 900)).toEqual({ width: 587, height: 336 })
    expect(chartSize(drawn(320, 176), 198)).toEqual({ width: 198, height: 108.9 })
    expect(chartSize(drawn(1_800, 9_000), 2_000)).toEqual({ width: 819.2, height: MAX_SVG_PX })
  })

  test('the kit’s chart (no tab draws it now) is sized up front too: as wide as the pane’s charts, 56 px tall', () => {
    const area = areaChart([{ values: [1, 3, 2], color: '#10b981' }], 846, 56)
    expect(area).toMatchObject({ width: 846, height: 56 })
    expect(ownSize(area.source)).toEqual({ width: 846, height: 56 })
    // A kit whose Svg hands its props back, to see what the chart gives it.
    const Svg: ElementConstructor<SvgProps> = props => ({ type: 'Svg', props: { source: props.source, alt: props.alt, width: props.width, height: props.height } })
    const Box: ElementConstructor<BoxProps> = () => ({ type: 'Box' })
    const Text: ElementConstructor<TextProps> = () => ({ type: 'Text' })
    const drawnAt = (columns: number): RenderElement => chart({ surface: 'desktop', columns }, { Box, Text, Svg }, 'CPU', [{ values: [1, 3, 2], color: '#f59e0b', tone: 'warning' }])
    expect(drawnAt(120)).toMatchObject({ type: 'Svg', props: { alt: 'CPU', width: 846, height: 56 } })
    expect(drawnAt(400)).toMatchObject({ type: 'Svg', props: { width: MAX_CHART_PX, height: 56 } })
    const svg = drawnAt(120)
    expect(svg.type === 'Svg' ? ownSize(svg.props.source) : undefined).toEqual({ width: 846, height: 56 })
  })
})

describe('memory’s share of the RAM', () => {
  test('as the tab says it: the RAM as it is sold, the share of it; nothing more while the RAM is not known', () => {
    expect(fmtRam(RAM)).toBe('16 GB')
    expect(fmtRam(8 * 1024 ** 3)).toBe('8 GB')
    expect(fmtRam(512e6)).toBe('512 MB')
    expect(ramShare(1.21e9, RAM)).toBe('7.0% of 16 GB')
    expect(ramShare(4.3e9, RAM)).toBe('25% of 16 GB')
    expect(ramShare(1.21e9, 0)).toBe('')
    // Beside the shares a share bar draws, the RAM is named.
    expect(memoryOfRam(300e6, RAM)).toBe('300 MB (1.7% of RAM)')
    expect(memoryOfRam(300e6, 0)).toBe('300 MB')
    expect(memoryOfRam(0, RAM)).toBe('0 B')
  })
})

describe('the battery history', () => {
  const reading = (t: number, percent: number): BatteryReading => ({ t, percent, mah: 0, maxMah: 0, mv: 11_000, ma: -1_000, isCharging: false, isExternal: false, sessionJ: 0 })

  test('one point a moment, oldest first, the draw in watts, capped', () => {
    let history = addBatteryPoint([], reading(NOW + 60_000, 49))
    history = addBatteryPoint(history, reading(NOW, 50))
    history = addBatteryPoint(history, reading(NOW, 50))
    expect(history).toEqual([
      { t: NOW, percent: 50, watts: 11, isExternal: false },
      { t: NOW + 60_000, percent: 49, watts: 11, isExternal: false },
    ])
    let many = history
    for (let index = 0; index < MAX_BATTERY_POINTS + 5; index += 1) {
      many = addBatteryPoint(many, reading(NOW + index * 1_000 + 120_000, 40))
    }
    expect(many).toHaveLength(MAX_BATTERY_POINTS)
  })
})

describe('the Compute tab', () => {
  test('the frame: the last two minutes second by second, or the whole session from its trend', () => {
    const live = { ...emptyLive(NOW), t: NOW + 10_000, history: [{ t: NOW + 9_000, netInBps: 1, netOutBps: 2, cpuPct: 3, watts: 4, mem: 5, diskRBps: 6, diskWBps: 7 }] }
    const recent = frameOf(live, 'live')
    expect(recent).toMatchObject({ from: NOW + 9_000 - 120_000, to: NOW + 9_000, cpu: [3], diskW: [7] })
    expect(recent.cpuPeak).toBeUndefined()
    const whole = frameOf({ ...live, trend: foldTrend([], TREND_STEP_MS, sample(NOW, { cpuPct: 8, energyJ: 2 })).trend }, 'session')
    expect(whole.cpu).toEqual([8])
    expect(whole.cpuPeak).toEqual([8])
    expect(whole.energy).toEqual([2])
    expect(whole.to - whole.from).toBeGreaterThanOrEqual(60_000)
  })

  test('desktop: stat cards and a chart per measure; the range picker spans the whole session', { timeoutMs: 30_000 }, async ($, on) => {
    const clock = world(on)
    laterTicks.value = [{ ...TICK, t: (NOW + 30_000) / 1000, session: { ...TICK.session, cpuS: 40, energyJ: 60, cpuPct: 40, diskRBps: 5_000, diskWBps: 9_000 } }]
    await start($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'tab:compute' })
    const alts = async (): Promise<string[]> => (await ui.findAll({ type: 'Svg' })).map(found => String(found.props.alt))
    expect(await alts()).toEqual([
      'CPU, memory, power, energy, download, upload and disk now',
      'CPU over the last 2 minutes',
      'Memory over the last 2 minutes',
      'Power over the last 2 minutes',
      'Battery charge over the session',
      'Session network over the last 2 minutes',
      'Bytes moved by each part of the session',
      'Disk reads and writes over the last 2 minutes',
      'CPU time by part of the session',
      'Energy by part of the session',
      'Network by part of the session',
      'Memory now by part of the session',
      'Energy used by the heaviest commands',
    ])
    const sources = (await ui.findAll({ type: 'Svg' })).map(found => String(found.props.source))
    expect(sources.every(source => source.startsWith('<svg') && source.length < 131_072)).toBe(true)
    // The cards say what the session uses now.
    expect(sources[0]).toContain('>CPU<')
    expect(sources[0]).toContain('>40%<')
    expect(sources[0]).toContain('>MEMORY<')
    // The whole session: a point per step, peaks dashed, and energy summed over time.
    await ui.select({ key: 'range', value: 'session' })
    expect(await alts()).toContain('CPU over the whole session')
    expect(await alts()).toContain('Energy used over the session')
    const cpu = (await ui.findAll({ type: 'Svg' })).find(found => found.props.alt === 'CPU over the whole session')
    expect(String(cpu?.props.source)).toContain('stroke-dasharray="4 3"')
    expect(await ui.find({ type: 'Text', text: /^a point every 10s, since / })).toBeDefined()
    // The range is kept for later sessions.
    await ui.select({ key: 'range', value: 'live' })
    expect(await alts()).toContain('CPU over the last 2 minutes')
  })

  test('terminal: tiles and block-character sparklines, the same sections', { timeoutMs: 30_000 }, async ($, on) => {
    const clock = world(on)
    await start($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:compute' })
    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Download' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^[▁▂▃▄▅▆▇█]+$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'CPU time' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '7% of the drop' })).toBeDefined()
    expect((await tabButton(ui, 'compute'))?.props.label).toBe('Compute')
  })

  test('desktop: every chart under a key of its own and sized up front, its size its document’s, at any pane width', { timeoutMs: 30_000 }, async ($, on) => {
    const clock = world(on)
    await start($, clock)
    for (const columns of [120, 84, 200, 30]) {
      const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: columns } })
      await ui.press({ key: 'tab:compute' })
      const svgs = await drawnSvgs(ui)
      const fit = chartFit(columns)
      expect(svgs.map(svg => svg.key)).toEqual([
        'compute:now',
        'compute:cpu',
        'compute:memory',
        'compute:power',
        'compute:battery',
        'compute:network',
        'compute:network-parts',
        'compute:disk',
        'compute:where:cpu',
        'compute:where:energy',
        'compute:where:network',
        'compute:where:memory',
        'compute:heaviest',
      ])
      for (const svg of svgs) {
        const own = ownSize(svg.source)
        // Each document is drawn as wide as the tab's charts are at this width ...
        expect(own.width).toBe(fit.width)
        if (fit.width <= fit.room) {
          // ... and its Svg is given exactly its size: nothing is scaled.
          expect({ width: svg.width, height: svg.height }).toEqual(own)
        } else {
          // ... or, in a pane too narrow for it, the room's width at the document's shape.
          expect(svg.width).toBe(fit.room)
          expect(Math.abs(Number(svg.height) - (own.height * fit.room) / own.width)).toBeLessThan(0.01)
        }
      }
      await ui.unmount()
    }
  })

  test('desktop: a redraw with new live figures keeps every chart’s key and size; only the documents change', { timeoutMs: 30_000 }, async ($, on) => {
    const clock = world(on)
    // More ticks than starting the session takes (12 s of them), so some arrive with the tab open.
    laterTicks.value = Array.from({ length: 24 }, (_, index) => laterTick(index))
    await start($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'tab:compute' })
    const before = await drawnSvgs(ui)
    const keys = await keysOf(ui, 'compute:')
    expect(keys).toHaveLength(13)
    await clock.advance(4_000)
    await clock.settle()
    const after = await drawnSvgs(ui)
    // The live figures moved on, and the tab drew its charts anew ...
    expect(after.find(svg => svg.key === 'compute:now')?.source).not.toBe(before.find(svg => svg.key === 'compute:now')?.source)
    expect(after.find(svg => svg.key === 'compute:cpu')?.source).not.toBe(before.find(svg => svg.key === 'compute:cpu')?.source)
    // ... under the same keys, at the same sizes: the boxes the desktop lays out never change height while the new images decode.
    expect(await keysOf(ui, 'compute:')).toEqual(keys)
    expect(after.map(svg => [svg.key, svg.width, svg.height])).toEqual(before.map(svg => [svg.key, svg.width, svg.height]))
  })

  test('desktop: memory with its share of the RAM on its card, in its chart’s legend, beside its section and over where it went', { timeoutMs: 30_000 }, async ($, on) => {
    const clock = world(on)
    await start($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'tab:compute' })
    const svgs = await drawnSvgs(ui)
    const source = (key: string): string => svgs.find(svg => svg.key === key)?.source ?? ''
    // The session holds 439 MB: 2.6% of the Mac's 16 GB.
    expect(source('compute:now')).toContain('>439 MB<')
    expect(source('compute:now')).toContain('>2.6% of 16 GB · peak 439 MB<')
    expect(source('compute:memory')).toContain('>439 MB (2.6%)<')
    expect(await ui.find({ type: 'Text', text: 'now 439 MB · 2.6% of 16 GB RAM · peak 439 MB (2.6%) this session' })).toBeDefined()
    // Each part's memory with its share of the RAM, beside its share of the session's; the parts' in all over the bar.
    const where = source('compute:where:memory')
    expect(where).toContain('>Memory now · 439 MB, 2.6% of 16 GB RAM<')
    expect(where).toContain('>Claude engine 68% · 300 MB (1.7% of RAM)<')
    expect(where).toContain('>MCP servers &amp; services 27% · 120 MB (0.7% of RAM)<')
    expect(where).toContain('>This monitor 4% · 19.0 MB (0.1% of RAM)<')
  })

  test('terminal: memory with its share of the RAM on its tile and in where it went', { timeoutMs: 30_000 }, async ($, on) => {
    const clock = world(on)
    await start($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:compute' })
    expect(await ui.find({ type: 'Text', text: '2.6% of 16 GB · peak 439 MB' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'now 439 MB · 2.6% of 16 GB RAM · peak 439 MB (2.6%) this session' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Memory now · 439 MB, 2.6% of 16 GB RAM' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '300 MB (1.7% of RAM)' })).toBeDefined()
  })
})

describe('memory slivers on the Compute tab', () => {
  test('a share under 0.05% reads <0.1%, not 0.0%', () => {
    const ram = 64 * 1024 ** 3
    expect(ramShare(34.2e6, ram)).toBe('<0.1% of 64 GB')
    expect(memoryOfRam(34.2e6, ram)).toBe('34.2 MB (<0.1% of RAM)')
    expect(memoryOfRam(4.3e9, 16 * 1024 ** 3)).toBe('4.30 GB (25% of RAM)')
  })
})
