// Battery: readings from `ioreg -r -c AppleSmartBattery`, and how much of a
// drop between two readings this session's own work explains.
//
// A reading costs one ~10 ms `ioreg` call. The drain between two readings is
// the charge lost (mAh) at the pack's voltage; the work is the kernel's energy
// estimate for this session's processes over the same span. Their ratio is the
// share of the drop the work explains; the rest is the display, radios, other
// apps and the system. Nothing is attributable while the Mac is on its adapter.

import type { BatteryPoint, BatteryReading } from '../../types'

const TWO_63 = 2n ** 63n
const TWO_64 = 2n ** 64n

/** ioreg prints signed registers as unsigned 64-bit: 18446744073709550656 is -960. */
export const signed64 = (text: string): number => {
  try {
    const value = BigInt(text)
    return Number(value >= TWO_63 ? value - TWO_64 : value)
  } catch {
    return 0
  }
}

/** The battery's registers from `ioreg -r -c AppleSmartBattery` text; null without a battery. */
export const parseIoreg = (text: string, t: number, sessionJ: number): BatteryReading | null => {
  const fields = new Map<string, string>()
  for (const match of text.matchAll(/^\s*"(\w+)" = ([^\n{(]+)$/gm)) {
    const key = match[1]
    const value = match[2]
    if (key !== undefined && value !== undefined && !fields.has(key)) {
      fields.set(key, value.trim())
    }
  }
  const percent = fields.get('CurrentCapacity')
  if (percent === undefined) {
    return null
  }
  const number = (key: string): number => signed64(fields.get(key) ?? '0')
  const minutes = number('TimeRemaining')
  return {
    t,
    percent: number('CurrentCapacity'),
    mah: number('AppleRawCurrentCapacity'),
    maxMah: number('AppleRawMaxCapacity'),
    mv: number('Voltage'),
    ma: number('Amperage'),
    isCharging: fields.get('IsCharging') === 'Yes',
    isExternal: fields.get('ExternalConnected') === 'Yes',
    minutesLeft: minutes > 0 && minutes < 65_535 ? minutes : undefined,
    sessionJ,
  }
}

/** Joules from milliamp-hours at a voltage in millivolts. */
export const mahToJ = (mah: number, mv: number): number => (mah * mv * 3.6) / 1000

/** The whole Mac's draw from the battery now, in watts; 0 while charging. */
export const systemWatts = (reading: BatteryReading): number => (reading.ma < 0 ? (-reading.ma * reading.mv) / 1e6 : 0)

export type Attribution = {
  state: 'measured' | 'on-power' | 'too-short'
  minutes: number
  dropPct: number
  drainMah: number
  drainJ: number
  workJ: number
  /** The share of the drain the session's work explains, 0 to 100, when measured. */
  sharePct?: number
  /** The session's work as a share of a full battery. */
  workBatteryPct: number
}

/** How much of the battery drop from `start` to `end` this session's work explains. */
export const attribute = (start: BatteryReading, end: BatteryReading): Attribution => {
  const minutes = Math.max(0, (end.t - start.t) / 60_000)
  const workJ = Math.max(0, end.sessionJ - start.sessionJ)
  const capacityJ = mahToJ(Math.max(1, end.maxMah || start.maxMah), end.mv || start.mv)
  const drainMah = Math.max(0, start.mah - end.mah)
  const drainJ = mahToJ(drainMah, (start.mv + end.mv) / 2)
  const base = {
    minutes,
    dropPct: Math.max(0, start.percent - end.percent),
    drainMah,
    drainJ,
    workJ,
    workBatteryPct: (workJ / capacityJ) * 100,
  }
  if (start.isExternal || end.isExternal || start.isCharging || end.isCharging) {
    return { ...base, state: 'on-power' }
  }
  if (drainMah <= 0 || drainJ <= 0) {
    return { ...base, state: 'too-short' }
  }
  return { ...base, state: 'measured', sharePct: Math.min(100, (workJ / drainJ) * 100) }
}

/** How many readings the battery's chart keeps: twelve hours at one a minute. */
export const MAX_BATTERY_POINTS = 720

/** A reading added to the battery's history: one per moment, oldest first, capped. */
export const addBatteryPoint = (history: readonly BatteryPoint[], reading: BatteryReading): BatteryPoint[] => {
  const point: BatteryPoint = { t: reading.t, percent: reading.percent, watts: systemWatts(reading), isExternal: reading.isExternal || reading.isCharging }
  const kept = history.filter(one => one.t !== reading.t)
  return [...kept, point].sort((a, b) => a.t - b.t).slice(-MAX_BATTERY_POINTS)
}
