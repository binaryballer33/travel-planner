// The sampler's JSON-lines protocol: validated parsing, times converted to ms.

import type { GroupKind, GroupSample, Rates, SystemMetrics, Totals } from '../../types'

export type SessionSample = Totals & Rates & { mem: number }
export type SystemSample = SystemMetrics

export type SamplerTick = {
  type: 'tick'
  t: number
  groups: GroupSample[]
  ended: GroupSample[]
  session: SessionSample
  reaped: { cpuS: number; energyEstJ: number }
  system: SystemSample
  jPerCpuS: number
}

export type SamplerMessage =
  | { type: 'hello'; root: number; self: number; ncpu: number; t: number }
  | { type: 'error'; message: string }
  | SamplerTick

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** A figure the sampler may leave out while it is not measured: a number from 0 up, else absent. */
const figure = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined)

export const ZERO_TOTALS: Totals = { cpuS: 0, energyJ: 0, energyEstJ: 0, netIn: 0, netOut: 0, diskR: 0, diskW: 0, netActiveS: 0 }
export const ZERO_RATES: Rates = { cpuPct: 0, watts: 0, netInBps: 0, netOutBps: 0, diskRBps: 0, diskWBps: 0 }

const totals = (value: unknown): Totals =>
  isRecord(value)
    ? {
        cpuS: num(value.cpuS),
        energyJ: num(value.energyJ),
        energyEstJ: num(value.energyEstJ),
        netIn: num(value.netIn),
        netOut: num(value.netOut),
        diskR: num(value.diskR),
        diskW: num(value.diskW),
        netActiveS: num(value.netActiveS),
      }
    : { ...ZERO_TOTALS }

const rates = (value: Json): Rates => ({
  cpuPct: num(value.cpuPct),
  watts: num(value.watts),
  netInBps: num(value.netInBps),
  netOutBps: num(value.netOutBps),
  diskRBps: num(value.diskRBps),
  diskWBps: num(value.diskWBps),
})

const KINDS: readonly GroupKind[] = ['claude', 'bash', 'service', 'helper', 'monitor']

const kindOf = (value: unknown): GroupKind | undefined => KINDS.find(kind => kind === value)

const group = (value: unknown): GroupSample | undefined => {
  if (!isRecord(value) || typeof value.id !== 'string') {
    return undefined
  }
  const kind = kindOf(value.kind)
  if (kind === undefined) {
    return undefined
  }
  const sample: GroupSample = {
    ...rates(value),
    id: value.id,
    kind,
    label: typeof value.label === 'string' ? value.label : kind,
    pid: num(value.pid),
    procs: num(value.procs),
    startedAt: num(value.startedAt) * 1000,
    mem: num(value.mem),
    peakMem: num(value.peakMem),
    tot: totals(value.tot),
  }
  if (typeof value.cmd === 'string') {
    sample.cmd = value.cmd
  }
  if (typeof value.endedAt === 'number') {
    sample.endedAt = value.endedAt * 1000
  }
  return sample
}

const groups = (value: unknown): GroupSample[] =>
  Array.isArray(value) ? value.map(group).filter((one): one is GroupSample => one !== undefined) : []

/** The whole Mac: what an older sampler does not send stays absent rather than reading 0. */
const system = (value: Json): SystemSample => {
  const ram = figure(value.memTotal)
  return {
    netInBps: num(value.netInBps),
    netOutBps: num(value.netOutBps),
    netIn: num(value.netIn),
    netOut: num(value.netOut),
    cpuPct: figure(value.cpuPct),
    memUsed: figure(value.memUsed),
    memTotal: ram !== undefined && ram > 0 ? ram : undefined,
    latencyMs: figure(value.latencyMs),
  }
}

export const parseMessage = (line: string): SamplerMessage | undefined => {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(value)) {
    return undefined
  }
  if (value.type === 'hello') {
    return { type: 'hello', root: num(value.root), self: num(value.self), ncpu: num(value.ncpu), t: num(value.t) * 1000 }
  }
  if (value.type === 'error') {
    return { type: 'error', message: typeof value.message === 'string' ? value.message : 'sampler error' }
  }
  if (value.type !== 'tick') {
    return undefined
  }
  const session = isRecord(value.session) ? value.session : {}
  const reaped = isRecord(value.reaped) ? value.reaped : {}
  return {
    type: 'tick',
    t: num(value.t) * 1000,
    groups: groups(value.groups),
    ended: groups(value.ended),
    session: { ...totals(session), ...rates(session), mem: num(session.mem) },
    reaped: { cpuS: num(reaped.cpuS), energyEstJ: num(reaped.energyEstJ) },
    system: system(isRecord(value.system) ? value.system : {}),
    jPerCpuS: num(value.jPerCpuS),
  }
}

/** Splits streamed text into whole lines, holding a partial last line back. */
export class LineBuffer {
  private pending = ''

  push(text: string): string[] {
    this.pending += text
    const lines = this.pending.split('\n')
    this.pending = lines.pop() ?? ''
    return lines.filter(line => line.trim() !== '')
  }
}
