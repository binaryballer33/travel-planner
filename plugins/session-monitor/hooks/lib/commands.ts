// Command records: what a tool call was, how it ended, and the resources its
// processes used, folded in from the sampler's process groups.

import type {
  CommandMetrics,
  CommandRecord,
  CommandStatus,
  GroupSample,
  HistoryPoint,
  LiveMetrics,
  Totals,
} from '../../types'
import { classifyTool, refineAccess } from './access'
import { fmtBytes, fmtDuration, oneLine, sanitize } from './format'
import { actorOf, summarizeCall } from './summary'
import { ZERO_RATES, ZERO_TOTALS, type SamplerTick } from './sampler'
import { foldTrend, TREND_STEP_MS } from './trend'

export const MAX_COMMANDS = 400
export const MAX_OUTPUT_CHARS = 60_000
const OUTPUT_HEAD = 8_000
const HISTORY_POINTS = 120
/** How long after a command ends reaped CPU may still be its tail. */
const REAP_GRACE_MS = 1_500
/** How far a shell's start may lead or trail its tool call's. */
const START_SKEW_MS = 2_000

export const emptyMetrics = (): CommandMetrics => ({
  ...ZERO_TOTALS,
  ...ZERO_RATES,
  mem: 0,
  peakMem: 0,
  procs: 0,
  isSampled: false,
  isEstimate: false,
})

export const emptyLive = (now: number): LiveMetrics => ({
  status: 'starting',
  t: now,
  startedAt: now,
  session: { ...ZERO_TOTALS, ...ZERO_RATES, mem: 0 },
  peakMem: 0,
  system: { netInBps: 0, netOutBps: 0, netIn: 0, netOut: 0 },
  groups: [],
  shortLived: { ...ZERO_TOTALS },
  history: [],
  trend: [],
  trendStepMs: TREND_STEP_MS,
  jPerCpuS: 0,
})

type Input = Readonly<Record<string, unknown>>

const text = (input: Input, key: string): string | undefined => {
  const value = input[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

export type Summary = { title: string; description?: string; filePath?: string; isBackground: boolean }

/** A one-line title for any tool call, from the input fields that name what it does. */
export const summarizeInput = (tool: string, input: Input): Summary => {
  const base = { isBackground: false }
  switch (tool) {
    case 'Bash':
      return {
        title: text(input, 'command') ?? '(empty command)',
        description: text(input, 'description'),
        isBackground: input.run_in_background === true,
      }
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit': {
      const filePath = text(input, 'file_path') ?? '(no path)'
      return { ...base, title: filePath, filePath }
    }
    case 'NotebookEdit': {
      const filePath = text(input, 'notebook_path') ?? '(no path)'
      return { ...base, title: filePath, filePath }
    }
    case 'Grep':
      return { ...base, title: `${text(input, 'pattern') ?? ''}${text(input, 'path') ? `  in ${text(input, 'path')}` : ''}` }
    case 'Glob':
      return { ...base, title: text(input, 'pattern') ?? '' }
    case 'WebFetch':
      return { ...base, title: text(input, 'url') ?? '', description: text(input, 'prompt') }
    case 'WebSearch':
      return { ...base, title: text(input, 'query') ?? '' }
    case 'Agent':
    case 'Task':
      return { ...base, title: text(input, 'description') ?? text(input, 'subagent_type') ?? 'agent', description: text(input, 'prompt') }
    default: {
      const first = Object.entries(input).find(([key, value]) => key !== 'tool' && key !== 'tool_use_id' && typeof value === 'string')
      const name = tool.startsWith('mcp__') ? tool.slice(5).replace('__', ' › ') : tool
      return { ...base, title: first !== undefined ? `${name}  ${String(first[1])}` : name }
    }
  }
}

export const startRecord = (
  id: string,
  tool: string,
  input: Input,
  now: number,
  agentId?: string,
  origin: string = 'engine',
): CommandRecord => {
  const summary = summarizeInput(tool, input)
  return {
    id,
    tool,
    title: sanitize(summary.title).slice(0, 4000),
    description: summary.description === undefined ? undefined : oneLine(summary.description, 300),
    startedAt: now,
    status: 'running',
    access: classifyTool(tool, input),
    agentId,
    isBackground: summary.isBackground,
    groups: [],
    reapedCpuS: 0,
    reapedEnergyJ: 0,
    metrics: emptyMetrics(),
    outputChars: 0,
    outputLines: 0,
    preview: '',
    filePath: summary.filePath,
    summary: summarizeCall(tool, input),
    actor: actorOf(origin, agentId),
  }
}

export const parseExitCode = (output: string): number | undefined => {
  const match = /exit(?:ed with)? code[:\s]+(-?\d+)/i.exec(output)
  return match === null ? undefined : Number(match[1])
}

/** Keeps the head and the tail of a long output, where the context and the errors are. */
export const clipOutput = (output: string): string => {
  const clean = sanitize(output)
  if (clean.length <= MAX_OUTPUT_CHARS) {
    return clean
  }
  const tail = MAX_OUTPUT_CHARS - OUTPUT_HEAD
  const omitted = clean.length - MAX_OUTPUT_CHARS
  return `${clean.slice(0, OUTPUT_HEAD)}\n\n… ${omitted.toLocaleString('en-US')} characters omitted …\n\n${clean.slice(-tail)}`
}

export type Outcome = { isDenied: boolean; isError: boolean; text: string; isReadOnly: boolean }

export const finishRecord = (record: CommandRecord, outcome: Outcome, now: number): CommandRecord => {
  const status: CommandStatus = outcome.isDenied
    ? 'denied'
    : outcome.isError
      ? 'error'
      : record.isBackground && record.tool === 'Bash'
        ? 'background'
        : 'ok'
  const output = sanitize(outcome.text)
  const lines = output === '' ? 0 : output.split('\n').length
  const exitCode = record.tool === 'Bash' ? (parseExitCode(output) ?? (status === 'ok' ? 0 : undefined)) : undefined
  return {
    ...record,
    status,
    access: refineAccess(record.access, outcome.isReadOnly),
    endedAt: now,
    exitCode,
    outputChars: output.length,
    outputLines: lines,
    preview: oneLine(output.split('\n').find(line => line.trim() !== '') ?? '', 200),
    metrics: status === 'background' ? record.metrics : { ...record.metrics, ...ZERO_RATES, mem: 0 },
  }
}

/** Sums a command's group snapshots and reaped share into its metrics. */
export const foldMetrics = (record: CommandRecord): CommandMetrics => {
  const metrics = emptyMetrics()
  for (const group of record.groups) {
    const isLive = group.endedAt === undefined
    metrics.cpuS += group.tot.cpuS
    metrics.energyJ += group.tot.energyJ
    metrics.energyEstJ += group.tot.energyEstJ
    metrics.netIn += group.tot.netIn
    metrics.netOut += group.tot.netOut
    metrics.diskR += group.tot.diskR
    metrics.diskW += group.tot.diskW
    metrics.netActiveS += group.tot.netActiveS
    metrics.peakMem = Math.max(metrics.peakMem, group.peakMem)
    if (isLive) {
      metrics.cpuPct += group.cpuPct
      metrics.watts += group.watts
      metrics.netInBps += group.netInBps
      metrics.netOutBps += group.netOutBps
      metrics.diskRBps += group.diskRBps
      metrics.diskWBps += group.diskWBps
      metrics.mem += group.mem
      metrics.procs += group.procs
    }
  }
  metrics.cpuS += record.reapedCpuS
  metrics.energyEstJ += record.reapedEnergyJ
  metrics.isSampled = record.groups.length > 0
  metrics.isEstimate = metrics.energyEstJ > 0.0005 || record.reapedCpuS > 0
  return metrics
}

const normalize = (command: string): string => command.trim().replace(/\s+/g, ' ')

/** How well a shell's decoded command matches a Bash call: 3 exact, 2 prefix, 0 none. */
export const matchScore = (shellCommand: string | undefined, record: CommandRecord): number => {
  if (shellCommand === undefined || shellCommand === '') {
    return 0
  }
  const a = normalize(shellCommand)
  const b = normalize(record.title)
  if (a === b) {
    return 3
  }
  const head = Math.min(200, a.length, b.length)
  return head >= 8 && a.slice(0, head) === b.slice(0, head) ? 2 : 0
}

const isCandidate = (record: CommandRecord, group: GroupSample): boolean =>
  record.tool === 'Bash' &&
  record.status !== 'denied' &&
  record.groups.length === 0 &&
  record.startedAt <= group.startedAt + START_SKEW_MS &&
  (record.endedAt === undefined || record.endedAt >= group.startedAt - START_SKEW_MS)

export type TickResult = {
  commands: CommandRecord[]
  /** Reaped CPU no command claimed, and shells no tool call ran (a `!` command). */
  unclaimed: Totals
  changed: boolean
}

/** Folds one sampler tick into the command records. Pure. */
export const applyTickToCommands = (commands: readonly CommandRecord[], tick: SamplerTick): TickResult => {
  const records = commands.map(record => ({ ...record, groups: [...record.groups] }))
  const owner = new Map<string, CommandRecord>()
  for (const record of records) {
    for (const group of record.groups) {
      owner.set(group.id, record)
    }
  }
  const unclaimed: Totals = { ...ZERO_TOTALS }
  const touched = new Set<CommandRecord>()
  const shells = [...tick.groups, ...tick.ended].filter(group => group.kind === 'bash')
  for (const group of shells) {
    let record = owner.get(group.id)
    if (record === undefined) {
      const scored = records
        .filter(candidate => isCandidate(candidate, group))
        .map(candidate => ({ candidate, score: matchScore(group.cmd, candidate) }))
        .filter(({ score }) => score > 0 || group.cmd === undefined || group.cmd === '')
        .sort((a, b) => b.score - a.score || Math.abs(a.candidate.startedAt - group.startedAt) - Math.abs(b.candidate.startedAt - group.startedAt))
      record = scored[0]?.candidate
      if (record !== undefined) {
        owner.set(group.id, record)
      }
    }
    if (record === undefined) {
      if (group.endedAt !== undefined) {
        addTotals(unclaimed, group.tot)
      }
      continue
    }
    const index = record.groups.findIndex(one => one.id === group.id)
    if (index >= 0) {
      record.groups[index] = group
    } else {
      record.groups.push(group)
    }
    touched.add(record)
  }

  if (tick.reaped.cpuS > 0) {
    const windowStart = tick.t - REAP_GRACE_MS
    const active = records.filter(
      record =>
        record.tool === 'Bash' &&
        record.status !== 'denied' &&
        record.startedAt <= tick.t &&
        (record.endedAt === undefined || record.endedAt >= windowStart),
    )
    const unsampled = active.filter(record => record.groups.length === 0)
    const justEnded = active.filter(
      record => record.groups.length > 0 && record.groups.every(group => group.endedAt !== undefined && group.endedAt >= windowStart),
    )
    const takers = unsampled.length > 0 ? unsampled : justEnded
    if (takers.length === 0) {
      unclaimed.cpuS += tick.reaped.cpuS
      unclaimed.energyEstJ += tick.reaped.energyEstJ
    } else {
      for (const record of takers) {
        record.reapedCpuS += tick.reaped.cpuS / takers.length
        record.reapedEnergyJ += tick.reaped.energyEstJ / takers.length
        touched.add(record)
      }
    }
  }

  for (const record of touched) {
    const metrics = foldMetrics(record)
    record.metrics = record.status === 'running' || record.status === 'background' ? metrics : { ...metrics, ...ZERO_RATES, mem: 0, procs: 0 }
    if (record.status === 'background' && record.groups.length > 0 && record.groups.every(group => group.endedAt !== undefined)) {
      record.status = 'ok'
      record.endedAt = Math.max(...record.groups.map(group => group.endedAt ?? 0))
    }
  }
  return { commands: records, unclaimed, changed: touched.size > 0 }
}

export const addTotals = (into: Totals, add: Totals): void => {
  into.cpuS += add.cpuS
  into.energyJ += add.energyJ
  into.energyEstJ += add.energyEstJ
  into.netIn += add.netIn
  into.netOut += add.netOut
  into.diskR += add.diskR
  into.diskW += add.diskW
  into.netActiveS += add.netActiveS
}

/** Folds one sampler tick into the live view. Pure. */
export const applyTickToLive = (live: LiveMetrics, tick: SamplerTick, unclaimed: Totals): LiveMetrics => {
  const shortLived: Totals = { ...live.shortLived }
  for (const group of tick.ended) {
    if (group.kind === 'helper' || group.kind === 'service') {
      addTotals(shortLived, group.tot)
    }
  }
  addTotals(shortLived, unclaimed)
  const point: HistoryPoint = {
    t: tick.t,
    netInBps: tick.session.netInBps,
    netOutBps: tick.session.netOutBps,
    cpuPct: tick.session.cpuPct,
    watts: tick.session.watts,
    mem: tick.session.mem,
    diskRBps: tick.session.diskRBps,
    diskWBps: tick.session.diskWBps,
  }
  const s = tick.session
  const trend = foldTrend(live.trend, live.trendStepMs, {
    ...point,
    energyJ: s.energyJ + s.energyEstJ,
    cpuS: s.cpuS,
    netIn: s.netIn,
    netOut: s.netOut,
  })
  return {
    ...live,
    status: 'running',
    message: undefined,
    t: tick.t,
    session: tick.session,
    peakMem: Math.max(live.peakMem, tick.session.mem),
    system: tick.system,
    groups: tick.groups,
    shortLived,
    history: [...live.history, point].slice(-HISTORY_POINTS),
    trend: trend.trend,
    trendStepMs: trend.stepMs,
    jPerCpuS: tick.jPerCpuS,
  }
}

export const upsert = (commands: readonly CommandRecord[], record: CommandRecord): CommandRecord[] => {
  const index = commands.findIndex(one => one.id === record.id)
  if (index < 0) {
    return [...commands, record].slice(-MAX_COMMANDS)
  }
  const updated = [...commands]
  updated[index] = record
  return updated
}

export const mapRecord = (
  commands: readonly CommandRecord[],
  id: string,
  change: (record: CommandRecord) => CommandRecord,
): CommandRecord[] => commands.map(record => (record.id === id ? change(record) : record))

// ------------------------------------------------------------------------- //
// Alerts: what a shell call raises a toast for
// ------------------------------------------------------------------------- //

/** A shell call that moves this much over the network raises a toast. */
export const ALERT_NET_BYTES = 50e6
/** A shell call still running after this long raises a toast. */
export const ALERT_SLOW_MS = 120_000

/** One alert a call raises: its kind (each is raised once per call) and the toast's text. */
export type CallAlert = { kind: 'net' | 'slow'; text: string }

/**
 * The alerts a call raises now: a shell call that moved ALERT_NET_BYTES, or
 * still runs after ALERT_SLOW_MS. Energy raises none: it shows on the call's
 * row. Other tools raise none. A failed call's toast is raised when it ends.
 */
export const alertsOf = (record: CommandRecord, now: number): CallAlert[] => {
  if (record.tool !== 'Bash') {
    return []
  }
  const m = record.metrics
  const title = oneLine(record.title, 60)
  const net = m.netIn + m.netOut
  return [
    ...(net >= ALERT_NET_BYTES ? [{ kind: 'net' as const, text: `⇅ ${fmtBytes(net)} of network: ${title}` }] : []),
    ...(record.status === 'running' && now - record.startedAt >= ALERT_SLOW_MS
      ? [{ kind: 'slow' as const, text: `⏱ running ${fmtDuration(now - record.startedAt)}: ${title}` }]
      : []),
  ]
}
