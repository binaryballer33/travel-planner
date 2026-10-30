// The whole session's trend: each tick folded into a span of TREND_STEP_MS
// (means and peaks, the totals where the span ended). Past MAX_TREND spans
// neighbours merge and the step doubles, so a long session stays short. Pure.

import type { TrendPoint } from '../../types'

/** The first step: ten seconds a point. */
export const TREND_STEP_MS = 10_000
/** How many points the trend keeps before its step doubles. */
export const MAX_TREND = 360

/** One tick as the trend takes it: the rates now and the session's totals so far. */
export type TrendSample = {
  t: number
  cpuPct: number
  watts: number
  mem: number
  netInBps: number
  netOutBps: number
  diskRBps: number
  diskWBps: number
  energyJ: number
  cpuS: number
  netIn: number
  netOut: number
}

const mean = (a: number, aTicks: number, b: number, bTicks: number): number => (a * aTicks + b * bTicks) / Math.max(1, aTicks + bTicks)

/** Two neighbouring points as one: the earlier's start, means weighted by ticks, the higher peaks, the later's totals. */
export const mergePoints = (first: TrendPoint, second: TrendPoint): TrendPoint => ({
  t: first.t,
  ticks: first.ticks + second.ticks,
  cpuPct: mean(first.cpuPct, first.ticks, second.cpuPct, second.ticks),
  cpuPeak: Math.max(first.cpuPeak, second.cpuPeak),
  watts: mean(first.watts, first.ticks, second.watts, second.ticks),
  mem: mean(first.mem, first.ticks, second.mem, second.ticks),
  memPeak: Math.max(first.memPeak, second.memPeak),
  netInBps: mean(first.netInBps, first.ticks, second.netInBps, second.ticks),
  netOutBps: mean(first.netOutBps, first.ticks, second.netOutBps, second.ticks),
  diskRBps: mean(first.diskRBps, first.ticks, second.diskRBps, second.ticks),
  diskWBps: mean(first.diskWBps, first.ticks, second.diskWBps, second.ticks),
  energyJ: second.energyJ,
  cpuS: second.cpuS,
  netIn: second.netIn,
  netOut: second.netOut,
})

const pointOf = (sample: TrendSample, start: number): TrendPoint => ({
  t: start,
  ticks: 1,
  cpuPct: sample.cpuPct,
  cpuPeak: sample.cpuPct,
  watts: sample.watts,
  mem: sample.mem,
  memPeak: sample.mem,
  netInBps: sample.netInBps,
  netOutBps: sample.netOutBps,
  diskRBps: sample.diskRBps,
  diskWBps: sample.diskWBps,
  energyJ: sample.energyJ,
  cpuS: sample.cpuS,
  netIn: sample.netIn,
  netOut: sample.netOut,
})

/** The points re-cut at a step twice as long: those that now share a span merge. */
export const coarsen = (trend: readonly TrendPoint[], stepMs: number): TrendPoint[] => {
  const merged: TrendPoint[] = []
  for (const point of trend) {
    const start = Math.floor(point.t / stepMs) * stepMs
    const last = merged[merged.length - 1]
    if (last !== undefined && last.t === start) {
      merged[merged.length - 1] = mergePoints(last, point)
    } else {
      merged.push({ ...point, t: start })
    }
  }
  return merged
}

/** Folds one tick into the trend: into the latest point while its span lasts, else a new one. */
export const foldTrend = (trend: readonly TrendPoint[], stepMs: number, sample: TrendSample): { trend: TrendPoint[]; stepMs: number } => {
  const step = stepMs > 0 ? stepMs : TREND_STEP_MS
  const start = Math.floor(sample.t / step) * step
  const last = trend[trend.length - 1]
  if (last !== undefined && sample.t < last.t) {
    // A clock that went back: nothing to fold the tick into.
    return { trend: [...trend], stepMs: step }
  }
  const next = last !== undefined && last.t === start ? [...trend.slice(0, -1), mergePoints(last, pointOf(sample, start))] : [...trend, pointOf(sample, start)]
  if (next.length <= MAX_TREND) {
    return { trend: next, stepMs: step }
  }
  return { trend: coarsen(next, step * 2), stepMs: step * 2 }
}
