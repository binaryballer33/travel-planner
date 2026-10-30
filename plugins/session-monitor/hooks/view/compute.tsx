// Compute: every chart of what the session's processes use. Stat cards for
// now, then CPU, memory, power and energy (with the battery), the internet,
// the disk, where it all went by process group, and what each prompt and the
// heaviest commands used. The charts span the last two minutes, second by
// second, or the whole session; SVG where the surface draws it, block
// characters in the terminal. Memory is shown with its share of the RAM.

import type { RenderElement } from 'claude-code'

import type { BatteryReading, BatteryView, ComputeRange, LiveMetrics } from '../../types'
import { attribute, systemWatts, type Attribution } from '../lib/battery'
import {
  barChart,
  chartRoom,
  chartSize,
  chartWidth,
  clockTicks,
  liveTicks,
  PANE_INSET_CH,
  shareBar,
  statCards,
  timeChart,
  type BarRow,
  type ChartSeries,
  type ChartSvg,
  type SharePart,
  type StatCard,
  type TimeTick,
} from '../lib/charts'
import {
  fmtBytes,
  fmtClock,
  fmtCpuSeconds,
  fmtDuration,
  fmtEnergy,
  fmtMemory,
  fmtMemShare,
  fmtPct,
  fmtRate,
  fmtWatts,
  memShare,
  meter,
  oneLine,
  sparkline,
  toneCpu,
  toneEnergy,
  toneMem,
  toneNetTotal,
  toneRate,
  toneWatts,
  type Tone,
} from '../lib/format'
import { promptFacts } from '../lib/prompts'
import { CPU, energySum, energyText, label, MEM, NET_IN, NET_OUT, picker, POWER, section, subheading, type Actions, type PaneData, type Ui } from './kit'
import { shares } from './overview'

/** Disk reads and writes, and energy summed over time. */
export const DISK_READ = '#06b6d4'
export const DISK_WRITE = '#ec4899'
export const ENERGY = '#f97316'
export const BATTERY = '#22c55e'

const MAIN_HEIGHT = 176
const SMALL_HEIGHT = 150
/** How many prompts and commands the bar charts list. */
const BARS_SHOWN = 8

/** The room a chart has across the tab, in CSS pixels, and the width each is drawn at. */
export type ChartFit = { room: number; width: number }

/** How the tab's charts fit a pane `columns` wide: the pane's body less its own padding. */
export const chartFit = (columns: number): ChartFit => {
  const room = chartRoom(columns, PANE_INSET_CH)
  return { room, width: chartWidth(room) }
}

type SvgElement = NonNullable<Ui['Svg']>

/**
 * A chart as the surface's Svg, sized up front, in a column Box that holds
 * its key (the engine's `<Svg>` keeps no key, only its source, alt, size and
 * isInteractive). The desktop builds each redraw's DOM afresh, every Svg a
 * new image; one with no size of its own is 0 px tall until its new source
 * decodes, and the tab redraws with the live figures, so a pane scrolled down
 * past the charts was pulled back up every couple of seconds (see `chartSize`).
 */
const chartSvg = (ui: Ui, Svg: SvgElement, key: string, alt: string, chart: ChartSvg, fit: ChartFit): RenderElement => {
  const { Box } = ui
  return (
    <Box key={key} flexDirection="column">
      <Svg source={chart.source} alt={alt} {...chartSize(chart, fit.room)} />
    </Box>
  )
}

/** The Mac's RAM as it is sold, in binary gigabytes: `16 GB`. */
export const fmtRam = (bytes: number): string => (bytes >= 1024 ** 3 ? `${Math.round(bytes / 1024 ** 3)} GB` : fmtBytes(bytes))

/** Memory's share of the RAM: `7.0% of 16 GB`; '' while the RAM is not known. */
export const ramShare = (bytes: number, total: number): string => {
  const share = memShare(bytes, total)
  return share === undefined ? '' : `${fmtMemShare(share)} of ${fmtRam(total)}`
}

/** Memory beside other shares (a share bar's parts): `300 MB (1.7% of RAM)`; the bytes alone while the RAM is not known. */
export const memoryOfRam = (bytes: number, total: number): string => {
  const share = memShare(bytes, total)
  return share === undefined || bytes <= 0 ? fmtBytes(bytes) : `${fmtBytes(bytes)} (${fmtMemShare(share)} of RAM)`
}

/** The parts of a line that have something to say, joined. */
const joined = (parts: readonly string[]): string => parts.filter(part => part !== '').join(' · ')

/** The points a range draws, the span it covers and its time ticks, each metric as its own series of values. */
type Frame = {
  times: number[]
  from: number
  to: number
  ticks: TimeTick[]
  cpu: number[]
  cpuPeak?: number[]
  mem: number[]
  memPeak?: number[]
  watts: number[]
  netIn: number[]
  netOut: number[]
  diskR: number[]
  diskW: number[]
  /** The session's energy so far at each point; only the session's range has it. */
  energy?: number[]
}

export const frameOf = (live: LiveMetrics, range: ComputeRange): Frame => {
  if (range === 'session') {
    const trend = live.trend
    const to = Math.max(live.t, (trend[trend.length - 1]?.t ?? live.t) + live.trendStepMs)
    const from = Math.min(trend[0]?.t ?? live.startedAt, to - 60_000)
    return {
      times: trend.map(point => point.t),
      from,
      to,
      ticks: clockTicks(from, to),
      cpu: trend.map(point => point.cpuPct),
      cpuPeak: trend.map(point => point.cpuPeak),
      mem: trend.map(point => point.mem),
      memPeak: trend.map(point => point.memPeak),
      watts: trend.map(point => point.watts),
      netIn: trend.map(point => point.netInBps),
      netOut: trend.map(point => point.netOutBps),
      diskR: trend.map(point => point.diskRBps),
      diskW: trend.map(point => point.diskWBps),
      energy: trend.map(point => point.energyJ),
    }
  }
  const history = live.history
  const to = history[history.length - 1]?.t ?? live.t
  return {
    times: history.map(point => point.t),
    from: to - 120_000,
    to,
    ticks: liveTicks(to),
    cpu: history.map(point => point.cpuPct),
    mem: history.map(point => point.mem),
    watts: history.map(point => point.watts),
    netIn: history.map(point => point.netInBps),
    netOut: history.map(point => point.netOutBps),
    diskR: history.map(point => point.diskRBps),
    diskW: history.map(point => point.diskWBps),
  }
}

/** What a chart over time draws. */
type TimeChartOptions = {
  /** The chart's key (its Box's), the same at every redraw. */
  key: string
  alt: string
  series: readonly (ChartSeries & { tone: Tone })[]
  format: (value: number) => string
  /** How the legend reads the latest values, where it says more than the axis; `format` when absent. */
  legend?: (value: number) => string
  height?: number
  /** A floor for the value axis' top. */
  minTop?: number
}

/** A chart over time: the SVG where the surface draws one, a sparkline per series in the terminal. */
const timeChartElement = (data: PaneData, ui: Ui, frame: Frame, options: TimeChartOptions): RenderElement => {
  const { Box, Text, Svg } = ui
  const { series } = options
  if (Svg !== undefined && data.surface !== 'terminal') {
    const fit = chartFit(data.columns)
    const chart = timeChart({
      times: frame.times,
      series,
      width: fit.width,
      height: options.height ?? MAIN_HEIGHT,
      format: options.format,
      legend: options.legend,
      from: frame.from,
      to: frame.to,
      ticks: frame.ticks,
      minTop: options.minTop ?? 0,
    })
    return chartSvg(ui, Svg, options.key, options.alt, chart, fit)
  }
  const width = Math.max(10, Math.min(120, data.columns - 22))
  return (
    <Box flexDirection="column">
      {series
        .filter(one => one.isDashed !== true)
        .map(one => {
          const values = one.values.map(value => value ?? 0)
          return (
            <Box flexDirection="row" columnGap={2}>
              {label(ui, one.name, 16)}
              <Text color={one.tone}>{sparkline(values, width)}</Text>
            </Box>
          )
        })}
    </Box>
  )
}

/** A percent on an axis: whole steps without a decimal. */
export const fmtPctAxis = (value: number): string => (Number.isInteger(value) ? `${value}%` : fmtPct(value))

/** The highest value over the frame. */
const peak = (values: readonly number[]): number => Math.max(0, ...values)

const rangeWords = (range: ComputeRange): string => (range === 'live' ? 'the last 2 minutes' : 'the whole session')

/** Now: a card per figure, its sparkline the last two minutes. */
const nowSection = (data: PaneData, live: LiveMetrics, ui: Ui): RenderElement => {
  const { Box, Text, Svg } = ui
  const s = live.session
  const history = live.history
  const hours = (live.t - live.startedAt) / 3_600_000
  const cards: (StatCard & { tone: Tone })[] = [
    { label: 'CPU', value: fmtPct(s.cpuPct), color: CPU, tone: toneCpu(s.cpuPct), note: `${fmtCpuSeconds(s.cpuS)} of CPU time`, spark: history.map(point => point.cpuPct) },
    {
      label: 'Memory',
      value: fmtBytes(s.mem),
      color: MEM,
      tone: toneMem(s.mem),
      // The share first, so a narrow card that cuts the note keeps it.
      note: joined([ramShare(s.mem, data.memTotal), `peak ${fmtBytes(live.peakMem)}`]),
      spark: history.map(point => point.mem),
    },
    { label: 'Power', value: fmtWatts(s.watts), color: POWER, tone: toneWatts(s.watts), note: `peak ${fmtWatts(peak(history.map(point => point.watts)))} in 2 min`, spark: history.map(point => point.watts) },
    {
      label: 'Energy',
      value: energyText(s).replace(/ \(.*\)$/, ''),
      color: ENERGY,
      tone: toneEnergy(energySum(s)),
      note: hours > 0.01 ? `avg ${fmtWatts(energySum(s) / (hours * 3600))} over ${fmtDuration(live.t - live.startedAt)}` : `over ${fmtDuration(live.t - live.startedAt)}`,
      spark: live.trend.map(point => point.energyJ),
    },
    {
      label: 'Download',
      value: fmtRate(s.netInBps),
      color: NET_IN,
      tone: toneRate(s.netInBps),
      note: `${fmtBytes(s.netIn)} in total`,
      spark: history.map(point => point.netInBps),
    },
    {
      label: 'Upload',
      value: fmtRate(s.netOutBps),
      color: NET_OUT,
      tone: toneRate(s.netOutBps),
      note: `${fmtBytes(s.netOut)} in total`,
      spark: history.map(point => point.netOutBps),
    },
    {
      label: 'Disk',
      value: fmtRate(s.diskRBps + s.diskWBps),
      color: DISK_WRITE,
      tone: toneRate(s.diskRBps + s.diskWBps),
      note: `read ${fmtBytes(s.diskR)} · wrote ${fmtBytes(s.diskW)}`,
      spark: history.map(point => point.diskRBps + point.diskWBps),
    },
  ]
  if (Svg !== undefined && data.surface !== 'terminal') {
    const fit = chartFit(data.columns)
    return section(ui, 'Now', 'this session’s processes · every 2 seconds', [
      chartSvg(ui, Svg, 'compute:now', 'CPU, memory, power, energy, download, upload and disk now', statCards(cards, fit.width), fit),
    ])
  }
  return section(ui, 'Now', 'this session’s processes · every 2 seconds', [
    <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap + 2} rowGap={data.space.row}>
      {cards.map(one => (
        <Box flexDirection="column" flexShrink={0}>
          <Text dimColor>{one.label}</Text>
          <Text color={one.tone} bold>
            {one.value}
          </Text>
          <Text dimColor>{one.note}</Text>
        </Box>
      ))}
    </Box>,
  ])
}

const cpuSection = (data: PaneData, live: LiveMetrics, frame: Frame, ui: Ui): RenderElement => {
  const s = live.session
  const series: (ChartSeries & { tone: Tone })[] = [
    { name: frame.cpuPeak !== undefined ? 'CPU, average' : 'CPU', color: CPU, values: frame.cpu, isArea: true, tone: 'warning' },
    ...(frame.cpuPeak !== undefined ? [{ name: 'peak', color: CPU, values: frame.cpuPeak, isDashed: true, tone: 'warning' as const }] : []),
  ]
  return section(ui, 'CPU', `now ${fmtPct(s.cpuPct)} · peak ${fmtPct(peak(frame.cpuPeak ?? frame.cpu))} in ${rangeWords(data.ui.computeRange)} · ${fmtCpuSeconds(s.cpuS)} used · 100% is one core`, [
    timeChartElement(data, ui, frame, { key: 'compute:cpu', alt: `CPU over ${rangeWords(data.ui.computeRange)}`, series, format: fmtPctAxis, minTop: 5 }),
  ])
}

const memorySection = (data: PaneData, live: LiveMetrics, frame: Frame, ui: Ui): RenderElement => {
  const series: (ChartSeries & { tone: Tone })[] = [
    { name: frame.memPeak !== undefined ? 'Memory, average' : 'Memory', color: MEM, values: frame.mem, isArea: true, tone: 'success' },
    ...(frame.memPeak !== undefined ? [{ name: 'peak', color: MEM, values: frame.memPeak, isDashed: true, tone: 'success' as const }] : []),
  ]
  const mem = live.session.mem
  const share = ramShare(mem, data.memTotal)
  return section(ui, 'Memory', joined([`now ${fmtBytes(mem)}`, share === '' ? '' : `${share} RAM`, `peak ${fmtMemory(live.peakMem, data.memTotal)} this session`]), [
    timeChartElement(data, ui, frame, {
      key: 'compute:memory',
      alt: `Memory over ${rangeWords(data.ui.computeRange)}`,
      series,
      format: fmtBytes,
      // The axis in bytes; the legend's latest values with their share of the RAM.
      legend: value => fmtMemory(value, data.memTotal),
      minTop: 64e6,
    }),
  ])
}

/** Power, energy summed (the session's range), and the battery. */
const energySection = (data: PaneData, live: LiveMetrics, frame: Frame, ui: Ui): RenderElement => {
  const { Text } = ui
  const s = live.session
  const charts: RenderElement[] = [
    timeChartElement(data, ui, frame, {
      key: 'compute:power',
      alt: `Power over ${rangeWords(data.ui.computeRange)}`,
      series: [{ name: 'Power', color: POWER, values: frame.watts, isArea: true, tone: 'error' }],
      format: fmtWatts,
      minTop: 0.5,
    }),
  ]
  if (frame.energy !== undefined) {
    charts.push(
      timeChartElement(data, ui, frame, {
        key: 'compute:energy',
        alt: 'Energy used over the session',
        series: [{ name: 'Energy used', color: ENERGY, values: frame.energy, isArea: true, tone: 'warning' }],
        format: value => fmtEnergy(value).replace(/ \(.*\)$/, ''),
        height: SMALL_HEIGHT,
        minTop: 1,
      }),
    )
  }
  return section(ui, 'Power & energy', `now ${fmtWatts(s.watts)} · ${energyText(s).replace(/ \(.*\)$/, '')} used`, [
    ...charts,
    <Text dimColor>
      Energy is the macOS kernel’s per-process estimate; ≈ marks CPU time priced at {live.jPerCpuS.toFixed(2)} J per CPU-second.
    </Text>,
    ...(data.battery !== null ? batteryRows(data, data.battery, ui) : []),
  ])
}

const shareTone = (share: number): Tone => (share >= 50 ? 'error' : share >= 20 ? 'warning' : 'success')

const attributionText = (ui: Ui, result: Attribution): RenderElement => {
  const { Text } = ui
  if (result.state === 'on-power') {
    return (
      <Text dimColor>
        on the power adapter, so the drop can’t be attributed · the work used ≈{fmtEnergy(result.workJ)} ({result.workBatteryPct.toFixed(2)}% of a full
        battery)
      </Text>
    )
  }
  if (result.state === 'too-short') {
    return (
      <Text dimColor>
        no charge lost yet · the work used ≈{fmtEnergy(result.workJ)} ({result.workBatteryPct.toFixed(2)}% of a full battery)
      </Text>
    )
  }
  const share = result.sharePct ?? 0
  return (
    <Text>
      <Text dimColor>work ≈</Text>
      <Text bold>{fmtEnergy(result.workJ)}</Text>
      <Text dimColor> of {fmtEnergy(result.drainJ)} drained = </Text>
      <Text color={shareTone(share)} bold>
        {share.toFixed(0)}% of the drop
      </Text>
      <Text dimColor> · {result.workBatteryPct.toFixed(2)}% of a full battery</Text>
    </Text>
  )
}

const batteryNow = (ui: Ui, reading: BatteryReading): RenderElement => {
  const { Text } = ui
  const watts = systemWatts(reading)
  const state = reading.isCharging ? 'charging' : reading.isExternal ? 'on power, not charging' : 'on battery'
  return (
    <Text>
      <Text color={reading.percent <= 20 ? 'error' : reading.percent <= 40 ? 'warning' : 'success'} bold>
        🔋 {reading.percent}%
      </Text>
      <Text dimColor> · {state}</Text>
      {watts > 0 && <Text color={toneWatts(watts / 4)}> · Mac drawing {fmtWatts(watts)}</Text>}
      {reading.minutesLeft !== undefined && !reading.isExternal && <Text dimColor> · {fmtDuration(reading.minutesLeft * 60_000)} left</Text>}
    </Text>
  )
}

/** The battery: its charge over the session, before the work and now, and how much of the drop the work explains, per prompt too. */
const batteryRows = (data: PaneData, battery: BatteryView, ui: Ui): RenderElement[] => {
  const { Box, Text, Svg } = ui
  const { start, latest: now } = battery
  if (!battery.hasBattery || start === null || now === null) {
    return battery.checkedAt > 0 ? [subheading(ui, 'Battery'), <Text dimColor>No battery on this Mac.</Text>] : []
  }
  const session = attribute(start, now)
  const turns = battery.turns.filter(turn => turn.end !== undefined).slice(-6).reverse()
  const points = battery.history
  const fit = chartFit(data.columns)
  const chart =
    Svg !== undefined && data.surface !== 'terminal' && points.length > 1
      ? [
          chartSvg(
            ui,
            Svg,
            'compute:battery',
            'Battery charge over the session',
            timeChart({
              times: points.map(point => point.t),
              series: [{ name: 'Battery', color: BATTERY, values: points.map(point => point.percent), isArea: true }],
              width: fit.width,
              height: SMALL_HEIGHT,
              format: value => `${Math.round(value)}%`,
              from: points[0]?.t ?? start.t,
              to: Math.max(points[points.length - 1]?.t ?? now.t, (points[0]?.t ?? start.t) + 60_000),
              ticks: clockTicks(points[0]?.t ?? start.t, points[points.length - 1]?.t ?? now.t),
              minTop: 100,
            }),
            fit,
          ),
        ]
      : []
  return [
    <Box flexDirection="row" flexWrap="wrap" columnGap={2} alignItems="center">
      {subheading(ui, 'Battery')}
      <Text dimColor>before the work, now, and how much of the drop the work explains</Text>
    </Box>,
    batteryNow(ui, now),
    ...chart,
    <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap} rowGap={data.space.row}>
      <Text>
        <Text dimColor>Since {fmtClock(start.t, data.now)} </Text>
        <Text bold>{start.percent}%</Text>
        <Text dimColor> → </Text>
        <Text bold>{now.percent}%</Text>
        <Text color={session.dropPct > 0 ? 'warning' : 'success'}> (−{session.dropPct}%)</Text>
        <Text dimColor> over {fmtDuration(session.minutes * 60_000)}</Text>
      </Text>
      {attributionText(ui, session)}
    </Box>,
    ...(turns.length === 0
      ? [<Text dimColor>Each prompt’s battery use appears here once it finishes.</Text>]
      : turns.map(turn => {
          const end = turn.end ?? turn.start
          const result = attribute(turn.start, end)
          return (
            <Box flexDirection="row" columnGap={data.space.gap}>
              <Box flexShrink={0}>
                <Text dimColor>{fmtClock(turn.start.t, data.now)}</Text>
              </Box>
              <Box flexShrink={0}>
                <Text>
                  {turn.start.percent}% → {end.percent}%
                </Text>
              </Box>
              <Box flexShrink={0}>
                {result.state === 'measured' ? (
                  <Text color={shareTone(result.sharePct ?? 0)}>{(result.sharePct ?? 0).toFixed(0)}% from the work</Text>
                ) : (
                  <Text dimColor>{result.state === 'on-power' ? 'on power' : 'too short to measure'}</Text>
                )}
              </Box>
              <Box flexShrink={0}>
                <Text dimColor>≈{fmtEnergy(result.workJ)}</Text>
              </Box>
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Text dimColor>
                  {turn.prompt === '' ? '(continued)' : `“${oneLine(turn.prompt, 80)}”`}
                </Text>
              </Box>
            </Box>
          )
        })),
  ]
}

/** The internet: the session's rates over the range, its totals, the whole Mac's, and who moved the bytes. */
const networkSection = (data: PaneData, live: LiveMetrics, frame: Frame, ui: Ui): RenderElement => {
  const { Box, Text, Svg } = ui
  const s = live.session
  const machine = live.system.netInBps + live.system.netOutBps
  const mine = s.netInBps + s.netOutBps
  const parts = shares(live, data.commands)
  const total = Math.max(1, s.netIn + s.netOut)
  const colors: Readonly<Record<Tone, string>> = SHARE_COLORS
  const fit = chartFit(data.columns)
  const breakdown =
    Svg !== undefined && data.surface !== 'terminal'
      ? [
          chartSvg(
            ui,
            Svg,
            'compute:network-parts',
            'Bytes moved by each part of the session',
            shareBar(
              'Who moved the bytes',
              parts.map((part): SharePart => ({ label: part.name, value: part.totals.netIn + part.totals.netOut, color: colors[part.tone], text: fmtBytes(part.totals.netIn + part.totals.netOut) })),
              fit.width,
            ),
            fit,
          ),
        ]
      : parts.map(part => (
          <Box flexDirection="row" columnGap={data.space.gap}>
            {label(ui, part.name, 28)}
            <Text color={part.tone}>{meter((part.totals.netIn + part.totals.netOut) / total, 10)}</Text>
            <Text color={toneNetTotal(part.totals.netIn)}>↓ {fmtBytes(part.totals.netIn)}</Text>
            <Text color={toneNetTotal(part.totals.netOut)}>↑ {fmtBytes(part.totals.netOut)}</Text>
            {part.rateIn + part.rateOut > 1 && <Text color={toneRate(part.rateIn + part.rateOut)}>({fmtRate(part.rateIn + part.rateOut)})</Text>}
          </Box>
        ))
  return section(ui, 'Internet', 'since the session started · live', [
    <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap + 1} rowGap={data.space.row}>
      <Text>
        <Text color={NET_IN} bold>
          ↓ {fmtBytes(s.netIn)}
        </Text>
        <Text dimColor> down</Text>
      </Text>
      <Text>
        <Text color={NET_OUT} bold>
          ↑ {fmtBytes(s.netOut)}
        </Text>
        <Text dimColor> up</Text>
      </Text>
      <Text>
        <Text dimColor>now </Text>
        <Text color={toneRate(s.netInBps)}>↓ {fmtRate(s.netInBps)}</Text>
        <Text dimColor> · </Text>
        <Text color={toneRate(s.netOutBps)}>↑ {fmtRate(s.netOutBps)}</Text>
      </Text>
    </Box>,
    timeChartElement(data, ui, frame, {
      key: 'compute:network',
      alt: `Session network over ${rangeWords(data.ui.computeRange)}`,
      series: [
        { name: 'Download', color: NET_IN, values: frame.netIn, isArea: true, tone: 'suggestion' },
        { name: 'Upload', color: NET_OUT, values: frame.netOut, tone: 'merged' },
      ],
      format: fmtRate,
      minTop: 10_000,
    }),
    <Text dimColor>
      Whole Mac now ↓ {fmtRate(live.system.netInBps)} ↑ {fmtRate(live.system.netOutBps)}
      {machine > 1 ? ` · this session ${fmtPct(Math.min(100, (mine / machine) * 100))} of it` : ''}
    </Text>,
    ...breakdown,
  ])
}

const diskSection = (data: PaneData, live: LiveMetrics, frame: Frame, ui: Ui): RenderElement => {
  const s = live.session
  return section(ui, 'Disk', `read ${fmtBytes(s.diskR)} · wrote ${fmtBytes(s.diskW)} this session`, [
    timeChartElement(data, ui, frame, {
      key: 'compute:disk',
      alt: `Disk reads and writes over ${rangeWords(data.ui.computeRange)}`,
      series: [
        { name: 'Read', color: DISK_READ, values: frame.diskR, isArea: true, tone: 'suggestion' },
        { name: 'Write', color: DISK_WRITE, values: frame.diskW, tone: 'merged' },
      ],
      format: fmtRate,
      height: SMALL_HEIGHT,
      minTop: 10_000,
    }),
  ])
}

/** The part colours of the share bars, by the tone each part has in text. */
const SHARE_COLORS: Readonly<Record<Tone, string>> = {
  claude: '#d97757',
  suggestion: '#3b82f6',
  warning: '#f59e0b',
  subtle: '#9ca3af',
  inactive: '#6b7280',
  success: '#10b981',
  error: '#ef4444',
  merged: '#a855f7',
  permission: '#8b5cf6',
  text: '#a3a3a3',
}

/** Where it went: each part of the session's share of CPU time, energy, the network and memory now. */
const whereSection = (data: PaneData, live: LiveMetrics, ui: Ui): RenderElement => {
  const { Box, Text, Svg } = ui
  const parts = shares(live, data.commands)
  const memNow = (name: string): number => {
    const kinds = name.startsWith('Claude') ? ['claude'] : name.startsWith('MCP') ? ['service'] : name.startsWith('Commands') ? ['bash'] : name.startsWith('Short') ? ['helper'] : ['monitor']
    return live.groups.filter(group => kinds.includes(group.kind)).reduce((total, group) => total + group.mem, 0)
  }
  const memAll = parts.reduce((total, part) => total + memNow(part.name), 0)
  const memShareOfAll = ramShare(memAll, data.memTotal)
  const measures: {
    /** Its chart's key, after `compute:where:`. */
    id: string
    title: string
    /** The title drawn over its bar or rows: memory's says how much of the RAM the parts hold in all. */
    heading: string
    value: (part: (typeof parts)[number]) => number
    text: (value: number) => string
  }[] = [
    { id: 'cpu', title: 'CPU time', heading: 'CPU time', value: part => part.totals.cpuS, text: fmtCpuSeconds },
    { id: 'energy', title: 'Energy', heading: 'Energy', value: part => energySum(part.totals), text: value => fmtEnergy(value).replace(/ \(.*\)$/, '') },
    { id: 'network', title: 'Network', heading: 'Network', value: part => part.totals.netIn + part.totals.netOut, text: fmtBytes },
    {
      id: 'memory',
      title: 'Memory now',
      heading: joined(['Memory now', memShareOfAll === '' ? '' : `${fmtBytes(memAll)}, ${memShareOfAll} RAM`]),
      value: part => memNow(part.name),
      text: value => memoryOfRam(value, data.memTotal),
    },
  ]
  if (Svg !== undefined && data.surface !== 'terminal') {
    const fit = chartFit(data.columns)
    return section(
      ui,
      'Where it went',
      'each part of the session’s share',
      measures.map(measure =>
        chartSvg(
          ui,
          Svg,
          `compute:where:${measure.id}`,
          `${measure.title} by part of the session`,
          shareBar(
            measure.heading,
            parts.map((part): SharePart => ({ label: part.name.split(' ·')[0] ?? part.name, value: measure.value(part), color: SHARE_COLORS[part.tone], text: measure.text(measure.value(part)) })),
            fit.width,
          ),
          fit,
        ),
      ),
    )
  }
  return section(
    ui,
    'Where it went',
    'each part of the session’s share',
    measures.map(measure => {
      const sum = Math.max(1e-9, parts.reduce((total, part) => total + measure.value(part), 0))
      return (
        <Box flexDirection="column">
          <Text bold>{measure.heading}</Text>
          {parts.map(part => (
            <Box flexDirection="row" columnGap={data.space.gap}>
              {label(ui, part.name.split(' ·')[0] ?? part.name, 26)}
              <Text color={part.tone}>{meter(measure.value(part) / sum, 12)}</Text>
              <Text>{measure.text(measure.value(part))}</Text>
            </Box>
          ))}
        </Box>
      )
    }),
  )
}

/** Bars where the surface draws Svg (under `key`), a meter per row in the terminal. */
const bars = (data: PaneData, ui: Ui, key: string, alt: string, rows: readonly (BarRow & { tone: Tone })[]): RenderElement => {
  const { Box, Text, Svg } = ui
  if (Svg !== undefined && data.surface !== 'terminal') {
    const fit = chartFit(data.columns)
    return chartSvg(ui, Svg, key, alt, barChart(rows, fit.width), fit)
  }
  const top = Math.max(1e-9, ...rows.map(row => row.value))
  return (
    <Box flexDirection="column">
      {rows.map(row => (
        <Box flexDirection="row" columnGap={data.space.gap}>
          <Text color={row.tone}>{meter(row.value / top, 12)}</Text>
          <Box width={12} flexShrink={0}>
            <Text bold>{row.text}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text>{row.label}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

/** Each prompt's energy, from the session's counters around its work. */
const promptsSection = (data: PaneData, ui: Ui): RenderElement | null => {
  const { Text } = ui
  const measured = [...data.prompts]
    .sort((a, b) => b.at - a.at)
    .map(prompt => ({ prompt, facts: promptFacts(prompt, data.commands, data.now) }))
    .filter(one => one.facts.use !== undefined)
    .slice(0, BARS_SHOWN)
  if (data.prompts.length === 0) {
    return null
  }
  const rows = measured.map(({ prompt, facts }) => {
    const use = facts.use
    const energy = use?.energyJ ?? 0
    return {
      label: oneLine(prompt.summary, 80),
      note: `${fmtClock(prompt.at, data.now)} · CPU ${fmtCpuSeconds(use?.cpuS ?? 0)} · ↓ ${fmtBytes(use?.netIn ?? 0)} ↑ ${fmtBytes(use?.netOut ?? 0)}${facts.durationMs !== undefined ? ` · ${fmtDuration(facts.durationMs)}` : ''}`,
      value: energy,
      text: fmtEnergy(energy).replace(/ \(.*\)$/, ''),
      color: ENERGY,
      tone: toneEnergy(energy),
    }
  })
  return section(ui, 'By prompt', measured.length === 0 ? '' : `the energy each of the latest ${measured.length} used, from start to end`, [
    rows.length === 0 ? <Text dimColor>Each prompt’s use appears here once it finishes with the sampler running.</Text> : bars(data, ui, 'compute:prompts', 'Energy used by each prompt', rows),
  ])
}

/** The commands that used the most energy. */
const heaviestSection = (data: PaneData, ui: Ui): RenderElement | null => {
  const measured = data.commands
    .filter(record => record.tool === 'Bash' && (record.metrics.isSampled || record.metrics.cpuS > 0))
    .sort((a, b) => energySum(b.metrics) - energySum(a.metrics))
    .slice(0, BARS_SHOWN)
  if (measured.length === 0) {
    return null
  }
  const rows = measured.map(record => ({
    label: oneLine(record.summary, 80),
    note: `${oneLine(record.title, 90)} · CPU ${fmtCpuSeconds(record.metrics.cpuS)} · peak ${fmtMemory(record.metrics.peakMem, data.memTotal)}`,
    value: energySum(record.metrics),
    text: energyText(record.metrics).replace(/ \(.*\)$/, ''),
    color: CPU,
    tone: toneEnergy(energySum(record.metrics)),
  }))
  return section(ui, 'Heaviest commands', `the ${measured.length} that used the most energy`, [bars(data, ui, 'compute:heaviest', 'Energy used by the heaviest commands', rows)])
}

export const computeTab = (data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Text } = ui
  const live = data.live
  if (live === null) {
    return <Text dimColor>Loading…</Text>
  }
  const range = data.ui.computeRange
  const frame = frameOf(live, range)
  const options: { value: ComputeRange; label: string }[] = [
    { value: 'live', label: 'Last 2 minutes' },
    { value: 'session', label: 'Whole session' },
  ]
  return (
    <Box flexDirection="column" gap={data.space.section}>
      <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap} rowGap={data.space.row} alignItems="center">
        {picker(ui, 'range', 'Charts show', range, options, value => act.setComputeRange(value))}
        <Text dimColor>
          {range === 'live' ? 'a point a second' : `a point every ${fmtDuration(live.trendStepMs)}, since ${fmtClock(frame.from, data.now)}`}
        </Text>
      </Box>
      {nowSection(data, live, ui)}
      {cpuSection(data, live, frame, ui)}
      {memorySection(data, live, frame, ui)}
      {energySection(data, live, frame, ui)}
      {networkSection(data, live, frame, ui)}
      {diskSection(data, live, frame, ui)}
      {whereSection(data, live, ui)}
      {promptsSection(data, ui)}
      {heaviestSection(data, ui)}
    </Box>
  )
}
