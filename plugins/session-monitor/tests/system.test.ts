// The whole Mac as the sampler measures it: its CPU, memory, RAM and latency
// parsed from a tick, and carried into the live view.

import { describe, expect, test } from 'claude-code/testing'

import { applyTickToLive, emptyLive } from '../hooks/lib/commands'
import { parseMessage, ZERO_TOTALS, type SamplerTick } from '../hooks/lib/sampler'

const T0 = 1_700_000_000_000

/** A tick as the sampler prints it, carrying this `system`, parsed. */
const tickWith = (system: unknown, t = T0): SamplerTick => {
  const message = parseMessage(JSON.stringify({ type: 'tick', t: t / 1000, groups: [], ended: [], session: { mem: 5 }, reaped: {}, system, jPerCpuS: 1 }))
  if (message?.type !== 'tick') {
    throw new Error('expected a tick')
  }
  return message
}

const MEASURED = { netInBps: 1_200_000, netOutBps: 40_000, netIn: 5e6, netOut: 1e6, cpuPct: 23.4, memUsed: 39.3e9, memTotal: 64e9, latencyMs: 38.2 }

describe('the whole Mac', () => {
  test('a tick carries its CPU, memory, RAM and latency beside the network', () => {
    expect(tickWith(MEASURED).system).toEqual(MEASURED)
  })

  test('a figure the sampler did not measure stays absent, never 0: an older sampler, the first tick, a failed probe', () => {
    const older = tickWith({ netInBps: 10, netOutBps: 5, netIn: 100, netOut: 50 }).system
    expect(older).toEqual({ netInBps: 10, netOutBps: 5, netIn: 100, netOut: 50 })
    expect([older.cpuPct, older.memUsed, older.memTotal, older.latencyMs]).toEqual([undefined, undefined, undefined, undefined])
    // No system at all, or nonsense in it: no RAM of 0 bytes, no negative memory.
    expect(tickWith(undefined).system).toEqual({ netInBps: 0, netOutBps: 0, netIn: 0, netOut: 0 })
    const odd = tickWith({ cpuPct: 'high', memUsed: -1, memTotal: 0, latencyMs: null }).system
    expect([odd.cpuPct, odd.memUsed, odd.memTotal, odd.latencyMs]).toEqual([undefined, undefined, undefined, undefined])
    // An idle CPU is a measured 0%.
    expect(tickWith({ ...MEASURED, cpuPct: 0 }).system.cpuPct).toBe(0)
  })

  test("the live view takes each tick's figures, and drops one the next tick no longer has", () => {
    expect(emptyLive(T0).system).toEqual({ netInBps: 0, netOutBps: 0, netIn: 0, netOut: 0 })
    let live = applyTickToLive(emptyLive(T0), tickWith(MEASURED, T0 + 1_000), ZERO_TOTALS)
    expect(live.system).toEqual(MEASURED)
    // The next probe failed: no latency, rather than the last one.
    const { latencyMs, ...unprobed } = MEASURED
    expect(latencyMs).toBe(38.2)
    live = applyTickToLive(live, tickWith({ ...unprobed, cpuPct: 4.2 }, T0 + 2_000), ZERO_TOTALS)
    expect(live.system).toEqual({ ...unprobed, cpuPct: 4.2 })
    expect(live.system.latencyMs).toBeUndefined()
  })
})
