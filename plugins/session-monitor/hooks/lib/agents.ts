// Agents: the sub-agents, teammates, workflows and background shells a
// session started, folded from `$.agent.list()` snapshots, each agent's own
// model requests, turns and tool calls, the spawns that started them and the
// Agent, Workflow and TaskStop calls around them. Pure: register.tsx holds the
// state and feeds these.

import type { AgentInfo, TurnUsage } from 'claude-code'

import type { AgentHistory, AgentKind, AgentPhase, AgentRecord, AgentRun, AgentRunStatus, CommandRecord, CommandStatus, CostBreakdown } from '../../types'
import { oneLine, SPINNER, type Tone } from './format'
import { addParts } from './spend'

export const MAX_AGENTS = 200
/** A workflow whose agents have all ended and that has been quiet this long reads as finished. */
export const WORKFLOW_QUIET_MS = 10 * 60_000
const LABEL_CHARS = 200

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const textOf = (value: Record<string, unknown>, key: string): string | undefined => {
  const field = value[key]
  return typeof field === 'string' && field !== '' ? field : undefined
}

/** A non-empty string field of a tool's input or result. */
export const textField = (value: unknown, key: string): string | undefined => (isRecord(value) ? textOf(value, key) : undefined)

const numberOf = (value: Record<string, unknown>, key: string): number | undefined => {
  const field = value[key]
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined
}

// ------------------------------------------------------------------------- //
// Status words
// ------------------------------------------------------------------------- //

export const isEnded = (status: AgentRunStatus): boolean => status === 'completed' || status === 'failed' || status === 'killed'

/** Working now: an idle teammate is alive but not working. */
export const isLive = (status: AgentRunStatus): boolean => status === 'running' || status === 'pending' || status === 'waiting'

export const agentGlyph = (status: AgentRunStatus, frame: number): string => {
  switch (status) {
    case 'running':
      return SPINNER[frame % SPINNER.length] ?? '•'
    case 'pending':
      return '○'
    case 'waiting':
      return '◷'
    case 'idle':
      return '◌'
    case 'completed':
      return '✓'
    case 'failed':
      return '✗'
    case 'killed':
      return '⊘'
  }
}

export const agentTone = (status: AgentRunStatus): Tone => {
  switch (status) {
    case 'running':
      return 'warning'
    case 'pending':
      return 'subtle'
    case 'waiting':
      return 'suggestion'
    case 'idle':
      return 'inactive'
    case 'completed':
      return 'success'
    case 'failed':
      return 'error'
    case 'killed':
      return 'inactive'
  }
}

/** What the row calls it: the agent type for a sub-agent, else its kind. */
export const kindText = (record: AgentRecord): string => {
  switch (record.kind) {
    case 'workflow':
      return 'workflow'
    case 'shell':
      return 'shell'
    case 'teammate':
      return 'teammate'
    case 'workflow-agent':
    case 'subagent':
      return record.type === '' ? 'agent' : record.type
  }
}

export const elapsedOf = (record: AgentRecord, now: number): number => Math.max(0, (record.endedAt ?? now) - record.startedAt)

// ------------------------------------------------------------------------- //
// Records
// ------------------------------------------------------------------------- //

/** What an agent is called before anything names it. */
const placeholderOf = (id: string): string => `Agent ${id.slice(0, 10)}`

export const blankAgent = (id: string, kind: AgentKind, now: number): AgentRecord => ({
  id,
  kind,
  label: kind === 'workflow' ? 'Workflow' : placeholderOf(id),
  type: kind === 'workflow' ? 'workflow' : '',
  status: 'running',
  isBackground: kind === 'workflow',
  wasListed: false,
  requests: 0,
  turns: 0,
  toolCalls: 0,
  tokensIn: 0,
  tokensOut: 0,
  contextTokens: 0,
  activeMs: 0,
  startedAt: now,
  lastActivityAt: now,
})

/** What to call the agent a tool call ran in (a command row's actor): its name or task, '' when unknown. */
export const agentLabelOf = (records: readonly AgentRecord[], agentId: string): string => {
  const record = records.find(one => one.id === agentId)
  return record === undefined || record.label === placeholderOf(agentId) ? '' : record.label
}

/** Changes the record with this id, first making it when there is none; the list keeps its order. */
const upsert = (
  list: readonly AgentRecord[],
  id: string,
  make: () => AgentRecord,
  change: (record: AgentRecord) => AgentRecord,
): AgentRecord[] => {
  const index = list.findIndex(one => one.id === id)
  if (index < 0) {
    return [...list, change(make())]
  }
  return list.map((one, at) => (at === index ? change(one) : one))
}

const label = (text: string): string => oneLine(text, LABEL_CHARS)

/** Ended agents stay ended unless their loop runs again; a step or a spawn says it does. */
const revive = (record: AgentRecord): AgentRecord =>
  isEnded(record.status) || record.status === 'pending' || record.status === 'idle' || record.status === 'waiting'
    ? { ...record, status: 'running', endedAt: undefined, isEndAssumed: undefined }
    : record

const end = (record: AgentRecord, status: AgentRunStatus, now: number): AgentRecord =>
  isEnded(record.status) ? record : { ...record, status, endedAt: now, lastActivityAt: now }

/** Merges one `$.agent.list()` snapshot; agents gone from it are kept (the engine drops ended ones). */
export const mergeAgentList = (list: readonly AgentRecord[], infos: readonly AgentInfo[], now: number): AgentRecord[] => {
  let merged: AgentRecord[] = [...list]
  const seen = new Set<string>()
  for (const info of infos) {
    seen.add(info.id)
    merged = upsert(
      merged,
      info.id,
      () => ({ ...blankAgent(info.id, 'subagent', now), status: info.status }),
      record => {
        const isTeammate = info.teammateId !== undefined || info.type === 'teammate'
        // A snapshot can trail the turn that ended the agent: ended stays ended.
        const status = isEnded(record.status) && !isEnded(info.status) ? record.status : info.status
        const isChanged = status !== record.status
        return {
          ...record,
          kind: isTeammate ? 'teammate' : record.kind,
          label: label(info.name ?? (info.description || info.type || record.label)),
          type: info.type || record.type,
          name: info.name ?? record.name,
          teammateId: info.teammateId ?? record.teammateId,
          parentId: record.parentId ?? info.parentId,
          status,
          endedAt: isEnded(status) ? (record.endedAt ?? now) : undefined,
          lastActivityAt: isChanged ? now : record.lastActivityAt,
          wasListed: true,
        }
      },
    )
  }
  // An agent the list showed and no longer does was dropped once it ended.
  return merged.map(record =>
    record.wasListed && !seen.has(record.id) && !isEnded(record.status) ? end(record, 'completed', now) : record,
  )
}

export type StepFacts = {
  model: string
  effort: string
  usage: TurnUsage | null
  /** The tools the response asked for, in order; empty when it only answered. */
  toolNames?: readonly string[]
  /** The response's visible text. */
  answer?: string
  stopReason?: string | null
}

const ANSWER_CHARS = 400

/** A model request began in the agent's loop: it waits on the model until the response is in. */
export const recordAgentRequest = (list: readonly AgentRecord[], agentId: string, now: number): AgentRecord[] =>
  upsert(
    list,
    agentId,
    () => blankAgent(agentId, 'subagent', now),
    record => ({
      ...revive(record),
      phase: { kind: 'request', since: now, detail: `request ${record.requests + 1}` },
      lastRequestAt: now,
      lastActivityAt: now,
    }),
  )

/** What the loop does once a response is in: run the tools it asked for, or end its turn. */
const phaseAfter = (step: StepFacts, now: number): AgentPhase | undefined => {
  if (step.toolNames === undefined) {
    return undefined
  }
  return step.toolNames.length > 0
    ? { kind: 'between', since: now, detail: `asked to run ${oneLine(step.toolNames.join(', '), 80)}` }
    : { kind: 'answered', since: now, detail: step.stopReason !== undefined && step.stopReason !== null ? `stopped: ${step.stopReason}` : 'answered' }
}

/** The runs an agent keeps, the latest last. */
export const MAX_RUNS = 20

const BRIEF_CHARS = 400

/** What a prompt asks for, in one line: its opening, past headings, list marks and code. */
export const briefOf = (prompt: string): string => {
  const text = prompt
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .split('\n')
    .map(line => line.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, '').trim())
    .filter(line => line !== '')
    .join(' ')
  // A stop only ends a sentence before a space, so `register.tsx` and `e.g` stay whole.
  const sentences = text.match(/[\s\S]*?[.!?]+(?=\s|$)|[\s\S]+$/g) ?? [text]
  let brief = ''
  for (const sentence of sentences) {
    if (brief !== '' && brief.length + sentence.length > BRIEF_CHARS) {
      break
    }
    brief += sentence
    if (brief.length >= 160) {
      break
    }
  }
  return oneLine(brief.trim(), BRIEF_CHARS)
}

/** A request in the agent's loop: the open run counts it, or it opens a new run. */
const stepRuns = (runs: readonly AgentRun[] | undefined, now: number): AgentRun[] => {
  const list = runs ?? []
  const last = list[list.length - 1]
  if (last !== undefined && last.endedAt === undefined) {
    return [...list.slice(0, -1), { ...last, requests: last.requests + 1 }]
  }
  return [...list, { startedAt: now, requests: 1 }].slice(-MAX_RUNS)
}

/** The loop's turn ended: the open run closes (one that never made a request opens and closes at once). */
const endRuns = (runs: readonly AgentRun[] | undefined, startedAt: number, reason: string, now: number): AgentRun[] => {
  const list = runs ?? []
  const last = list[list.length - 1]
  if (last !== undefined && last.endedAt === undefined) {
    return [...list.slice(0, -1), { ...last, endedAt: now, reason }]
  }
  return [...list, { startedAt, endedAt: now, requests: 0, reason }].slice(-MAX_RUNS)
}

/** A request's price, counted toward the agent whose loop made it; nothing for an agent not yet seen. */
export const recordAgentSpend = (list: readonly AgentRecord[], agentId: string, usd: number, blockKey: string | undefined, parts?: CostBreakdown): AgentRecord[] =>
  list.some(one => one.id === agentId)
    ? list.map(one =>
        one.id !== agentId
          ? one
          : {
              ...one,
              usd: (one.usd ?? 0) + usd,
              ...(parts === undefined ? {} : { parts: addParts(one.parts, parts) }),
              blockKey: blockKey ?? one.blockKey,
              blockUsd: blockKey === undefined || blockKey === one.blockKey ? (one.blockUsd ?? 0) + (blockKey === undefined ? 0 : usd) : usd,
            },
      )
    : [...list]

const usageIn = (usage: TurnUsage): number => usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens

/** One model request inside an agent's loop: it runs, on this model, and its tokens count. */
export const recordAgentStep = (list: readonly AgentRecord[], agentId: string, step: StepFacts, now: number): AgentRecord[] =>
  upsert(
    list,
    agentId,
    () => blankAgent(agentId, 'subagent', now),
    record => {
      const usage = step.usage
      return {
        ...revive(record),
        model: step.model,
        effort: step.effort,
        requests: record.requests + 1,
        tokensIn: record.tokensIn + (usage === null ? 0 : usageIn(usage)),
        tokensOut: record.tokensOut + (usage === null ? 0 : usage.output_tokens),
        contextTokens: usage === null ? record.contextTokens : usageIn(usage) + usage.output_tokens,
        runs: stepRuns(record.runs, now),
        phase: phaseAfter(step, now) ?? record.phase,
        lastAnswer: step.answer === undefined ? record.lastAnswer : oneLine(step.answer, ANSWER_CHARS),
        stopReason: step.stopReason === undefined ? record.stopReason : (step.stopReason ?? undefined),
        lastActivityAt: now,
      }
    },
  )

export type TurnFacts = { reason: 'answer' | 'aborted' | 'refusal' | 'error'; durationMs: number; usage?: TurnUsage }

/**
 * One run of an agent's loop ended: a teammate goes idle, any other agent
 * has finished (a message may run it again, under the same id).
 */
export const recordAgentTurn = (list: readonly AgentRecord[], agentId: string, turn: TurnFacts, now: number): AgentRecord[] =>
  upsert(
    list,
    agentId,
    () => blankAgent(agentId, 'subagent', now),
    record => {
      const usage = turn.usage
      // Steps that carried no usage (made-up responses) leave the turn's total to count.
      const hasSteps = record.tokensIn + record.tokensOut > 0
      const counted: AgentRecord = {
        ...record,
        turns: record.turns + 1,
        activeMs: record.activeMs + Math.max(0, turn.durationMs),
        tokensIn: hasSteps || usage === undefined ? record.tokensIn : usageIn(usage),
        tokensOut: hasSteps || usage === undefined ? record.tokensOut : usage.output_tokens,
        model: record.model ?? usage?.model,
        runs: endRuns(record.runs, Math.max(record.startedAt, now - Math.max(0, turn.durationMs)), turn.reason, now),
        phase: { kind: 'ended', since: now, detail: RUN_ENDS[turn.reason] },
        lastActivityAt: now,
      }
      if (record.kind === 'teammate') {
        return { ...counted, status: 'idle' }
      }
      const status: AgentRunStatus = turn.reason === 'answer' ? 'completed' : turn.reason === 'aborted' ? 'killed' : 'failed'
      return { ...counted, status, endedAt: now }
    },
  )

/** A tool call made inside an agent's loop. */
export const recordAgentToolCall = (list: readonly AgentRecord[], agentId: string, now: number, summary = ''): AgentRecord[] =>
  upsert(
    list,
    agentId,
    () => blankAgent(agentId, 'subagent', now),
    record => ({
      ...(record.isEndAssumed === true ? revive(record) : record),
      status: record.status === 'pending' ? 'running' : record.isEndAssumed === true ? 'running' : record.status,
      toolCalls: record.toolCalls + 1,
      phase: { kind: 'tool', since: now, detail: summary !== '' ? oneLine(summary, 120) : 'a tool call' },
      lastActivityAt: now,
    }),
  )

const CALL_ENDS: Readonly<Record<CommandStatus, string>> = {
  ok: 'finished',
  error: 'failed',
  denied: 'was denied',
  background: 'went to the background',
  running: 'is running',
}

/** A tool call inside the agent's loop answered: the loop sends its next request. */
export const recordAgentToolEnd = (list: readonly AgentRecord[], agentId: string, tool: string, status: CommandStatus, now: number): AgentRecord[] =>
  list.map(record =>
    record.id !== agentId || isEnded(record.status)
      ? record
      : { ...record, phase: { kind: 'between', since: now, detail: `${oneLine(tool, 40)} ${CALL_ENDS[status]}; its next request is due` }, lastActivityAt: now },
  )

const RUN_ENDS: Readonly<Record<TurnFacts['reason'], string>> = { answer: 'answered', aborted: 'stopped', refusal: 'refused', error: 'failed' }

const ago = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds}s` : seconds < 3_600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`
}

/** What the agent is doing, in a sentence, with how long it has been at it. */
export const phaseText = (record: AgentRecord, now: number): string => {
  const phase = record.phase
  if (record.kind === 'shell' || record.kind === 'workflow') {
    return ''
  }
  if (phase === undefined) {
    return record.requests === 0 && record.toolCalls === 0 ? 'Nothing seen from it yet.' : 'No request or tool call of its has been seen in progress.'
  }
  const since = ago(now - phase.since)
  switch (phase.kind) {
    case 'request':
      return `Waiting for the model to answer its ${phase.detail} (${since}).`
    case 'tool':
      return `Running a tool: ${phase.detail} (${since}).`
    case 'between':
      return `Its last step ${phase.detail.startsWith('asked') ? phase.detail : `ended: ${phase.detail}`} (${since} ago).`
    case 'answered':
      return `Answered (${phase.detail}) ${since} ago; its turn has not been reported ended.`
    case 'ended':
      return record.isEndAssumed === true ? `Quiet for ${ago(now - record.lastActivityAt)}; its end was never reported.` : `Its turn ended: ${phase.detail} (${since} ago).`
  }
}

/** Why the row shows the status it does, where that needs saying; undefined where the status speaks for itself. */
export const statusNote = (record: AgentRecord, now: number): string | undefined => {
  if (record.isEndAssumed === true) {
    return (
      'Marked done by the monitor: Claude Code started this agent without an Agent call and never reported its end, it is not in ' +
      "Claude's agent list, and nothing came from it for a minute. Anything new from it brings it back."
    )
  }
  if (isLive(record.status) && isOrphan(record)) {
    return (
      'Claude Code started this agent itself, without an Agent call (an internal helper such as prompt suggestions, or a fork), so it may ' +
      'never report an end. The monitor marks it done after a minute with nothing from it, unless it is waiting on the model or a tool.'
    )
  }
  if (isLive(record.status) && now - record.lastActivityAt >= 5 * 60_000 && record.phase?.kind !== 'request' && record.phase?.kind !== 'tool') {
    return `Nothing from it for ${ago(now - record.lastActivityAt)}; it still counts as running until Claude reports its end or drops it from the agent list.`
  }
  return undefined
}

/** How long an agent Claude Code never reports the end of may stay quiet before the mod marks it done. */
export const ORPHAN_QUIET_MS = 60_000

/**
 * An agent Claude Code started without an Agent call (an internal helper such
 * as prompt suggestions, or a fork) and never listed: no end is reported for it.
 */
export const isOrphan = (record: AgentRecord): boolean => record.kind === 'subagent' && !record.wasListed && record.toolUseId === undefined

/** Marks done the orphans that went quiet while not waiting on the model or a tool; anything new from one brings it back. */
export const settleOrphans = (list: readonly AgentRecord[], now: number): AgentRecord[] =>
  list.map(record =>
    isLive(record.status) &&
    isOrphan(record) &&
    record.phase?.kind !== 'request' &&
    record.phase?.kind !== 'tool' &&
    now - record.lastActivityAt >= ORPHAN_QUIET_MS
      ? {
          ...record,
          status: 'completed',
          endedAt: record.lastActivityAt,
          isEndAssumed: true,
          phase: { kind: 'ended', since: record.lastActivityAt, detail: 'no end reported; quiet since' },
        }
      : record,
  )

/** What an `agent.spawn` settled to: the started agent, and where it came from. */
export type SpawnFacts = {
  agentId: string
  /** The Agent call, or for a workflow's agent the Workflow call that started its run (may be ''). */
  toolUseId: string
  description: string
  subagentType: string
  model: string
  /** The prompt that started it; its opening becomes the agent's brief. */
  prompt?: string
  name?: string
  teammateId?: string
  parentAgentId?: string
  isBackground: boolean
  isTeammate: boolean
  workflow?: { runId: string; agentIndex: number }
}

/** The workflow row a workflow agent belongs to: by its Workflow call, else by its run. */
const findWorkflow = (list: readonly AgentRecord[], toolUseId: string, runId: string): AgentRecord | undefined =>
  list.find(one => one.kind === 'workflow' && toolUseId !== '' && one.toolUseId === toolUseId) ??
  list.find(one => one.kind === 'workflow' && runId !== '' && one.runId === runId)

/** A spawn: the agent's row, nested under its workflow's (made now when the launch was not seen). */
export const recordSpawn = (list: readonly AgentRecord[], spawn: SpawnFacts, now: number): AgentRecord[] => {
  let merged: AgentRecord[] = [...list]
  let parentId = spawn.parentAgentId
  const run = spawn.workflow
  if (run !== undefined) {
    const known = findWorkflow(merged, spawn.toolUseId, run.runId)
    const workflowId = known?.id ?? (spawn.toolUseId !== '' ? spawn.toolUseId : run.runId)
    merged = upsert(
      merged,
      workflowId,
      () => ({ ...blankAgent(workflowId, 'workflow', now), toolUseId: spawn.toolUseId || undefined, parentId: spawn.parentAgentId }),
      record => ({ ...record, runId: record.runId ?? (run.runId || undefined), status: record.status === 'pending' ? 'running' : record.status, lastActivityAt: now }),
    )
    parentId = workflowId
  }
  const kind: AgentKind = run !== undefined ? 'workflow-agent' : spawn.isTeammate ? 'teammate' : 'subagent'
  return upsert(
    merged,
    spawn.agentId,
    () => blankAgent(spawn.agentId, kind, now),
    record => ({
      ...revive(record),
      kind,
      label: label(spawn.name ?? (spawn.description || spawn.subagentType || record.label)),
      type: spawn.subagentType || record.type,
      brief: spawn.prompt !== undefined && spawn.prompt.trim() !== '' ? briefOf(spawn.prompt) : record.brief,
      name: spawn.name ?? record.name,
      teammateId: spawn.teammateId ?? record.teammateId,
      toolUseId: spawn.toolUseId || record.toolUseId,
      parentId: parentId ?? record.parentId,
      isBackground: spawn.isBackground,
      model: record.model ?? (spawn.model || undefined),
      startedAt: Math.min(record.startedAt, now),
      lastActivityAt: now,
    }),
  )
}

export type WorkflowMeta = { name?: string; description?: string; phases: string[] }

const QUOTED = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g

const quotedAfter = (source: string, key: string): string | undefined => {
  const match = new RegExp(`\\b${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`).exec(source)
  return match?.[2]
}

/** A workflow script's `export const meta = { name, description, phases }`, read from its text. */
export const parseWorkflowMeta = (script: string): WorkflowMeta => {
  const at = script.search(/\bmeta\s*=/)
  if (at < 0) {
    return { phases: [] }
  }
  const head = script.slice(at, at + 6_000)
  const phasesAt = head.search(/\bphases\s*:/)
  const before = phasesAt < 0 ? head : head.slice(0, phasesAt)
  const block = phasesAt < 0 ? undefined : /\bphases\s*:\s*\[([\s\S]*?)\]/.exec(head.slice(phasesAt))?.[1]
  let phases: string[] = []
  if (block !== undefined) {
    const titled = [...block.matchAll(/\btitle\s*:\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map(match => match[2] ?? '')
    phases = titled.length > 0 ? titled : [...block.matchAll(QUOTED)].map(match => match[2] ?? '')
  }
  const name = quotedAfter(before, 'name')
  const description = quotedAfter(before, 'description')
  return {
    name: name === undefined ? undefined : label(name),
    description: description === undefined ? undefined : oneLine(description, 400),
    phases: phases.filter(phase => phase.trim() !== '').map(phase => oneLine(phase, 80)).slice(0, 20),
  }
}

export type WorkflowLaunch = { toolUseId: string; parentId?: string; name?: string; script?: string; scriptPath?: string }

/** A Workflow call began: its row, named from the script's `meta` where it has one. */
export const launchWorkflow = (list: readonly AgentRecord[], launch: WorkflowLaunch, now: number): AgentRecord[] => {
  const meta = parseWorkflowMeta(launch.script ?? '')
  const fromPath = launch.scriptPath?.split('/').pop()?.replace(/\.[a-z]+$/i, '')
  return upsert(
    list,
    launch.toolUseId,
    () => ({ ...blankAgent(launch.toolUseId, 'workflow', now), status: 'pending', toolUseId: launch.toolUseId }),
    record => ({
      ...record,
      label: label(meta.name ?? launch.name ?? fromPath ?? record.label),
      description: meta.description ?? record.description,
      phases: meta.phases.length > 0 ? meta.phases : record.phases,
      parentId: record.parentId ?? launch.parentId,
    }),
  )
}

export type WorkflowOutcome = { isError: boolean; taskId?: string; runId?: string; workflowName?: string; error?: string }

/** What a Workflow call's result says: the run launched in the background, or why it did not. */
export const readWorkflowResult = (value: unknown, isError: boolean): WorkflowOutcome => {
  if (!isRecord(value)) {
    return { isError }
  }
  const error = textOf(value, 'error')
  return {
    isError: isError || error !== undefined,
    taskId: textOf(value, 'taskId'),
    runId: textOf(value, 'runId'),
    workflowName: textOf(value, 'workflowName'),
    error,
  }
}

/** The Workflow call answered: the run is under way (its end comes later), or it failed to start. */
export const settleWorkflow = (list: readonly AgentRecord[], toolUseId: string, outcome: WorkflowOutcome, now: number): AgentRecord[] => {
  const runId = outcome.runId
  // Agents that spawned before the call answered, filed under their run alone.
  const early = list.find(one => one.kind === 'workflow' && one.id !== toolUseId && runId !== undefined && one.runId === runId)
  const moved = early === undefined ? list : list.filter(one => one.id !== early.id).map(one => (one.parentId === early.id ? { ...one, parentId: toolUseId } : one))
  return upsert(
    moved,
    toolUseId,
    () => ({ ...blankAgent(toolUseId, 'workflow', now), toolUseId, startedAt: early?.startedAt ?? now }),
    record => {
      const named: AgentRecord = {
        ...record,
        label: outcome.workflowName !== undefined ? label(outcome.workflowName) : record.label,
        taskId: outcome.taskId ?? record.taskId,
        runId: runId ?? record.runId,
        lastActivityAt: now,
      }
      if (outcome.isError) {
        return { ...end(named, 'failed', now), description: outcome.error === undefined ? named.description : oneLine(outcome.error, 400) }
      }
      return { ...named, status: named.status === 'pending' ? 'running' : named.status }
    },
  )
}

/** What a model's Agent call answered at `tool.call`, by the variants the engine has. */
export type AgentOutcome =
  | { kind: 'completed'; agentId: string; totalTokens?: number; totalToolUseCount?: number; resolvedModel?: string; agentType?: string }
  | { kind: 'async'; agentId: string; description?: string; resolvedModel?: string }
  | { kind: 'remote'; taskId: string; description?: string }
  | { kind: 'teammate'; agentId: string; name?: string; teammateId?: string; agentType?: string; model?: string }
  | { kind: 'unknown' }

export const readAgentResult = (value: unknown): AgentOutcome => {
  if (!isRecord(value)) {
    return { kind: 'unknown' }
  }
  const status = textOf(value, 'status')
  const agentId = textOf(value, 'agentId') ?? textOf(value, 'agent_id')
  if (status === 'remote_launched') {
    const taskId = textOf(value, 'taskId')
    return taskId === undefined ? { kind: 'unknown' } : { kind: 'remote', taskId, description: textOf(value, 'description') }
  }
  if (agentId === undefined) {
    return { kind: 'unknown' }
  }
  if (status === 'async_launched') {
    return { kind: 'async', agentId, description: textOf(value, 'description'), resolvedModel: textOf(value, 'resolvedModel') }
  }
  if (status === 'teammate_spawned') {
    return {
      kind: 'teammate',
      agentId,
      name: textOf(value, 'name'),
      teammateId: textOf(value, 'teammate_id'),
      agentType: textOf(value, 'agent_type'),
      model: textOf(value, 'resolvedModel') ?? textOf(value, 'model'),
    }
  }
  // A completed call's record, or a plugin's spawn (AgentCallRecord), which the agent's own turn ends.
  if (status === 'completed') {
    return {
      kind: 'completed',
      agentId,
      totalTokens: numberOf(value, 'totalTokens'),
      totalToolUseCount: numberOf(value, 'totalToolUseCount'),
      resolvedModel: textOf(value, 'resolvedModel'),
      agentType: textOf(value, 'agentType'),
    }
  }
  return { kind: 'async', agentId, resolvedModel: textOf(value, 'resolvedModel') }
}

export type AgentCall = { toolUseId: string; description?: string; subagentType?: string; parentId?: string; isError: boolean }

/** A model's Agent call answered: the agent it started, finished (foreground) or under way (background). */
export const settleAgentCall = (list: readonly AgentRecord[], call: AgentCall, outcome: AgentOutcome, now: number): AgentRecord[] => {
  if (call.isError || outcome.kind === 'unknown') {
    // The spawn's row, when the call failed after it started one.
    const started = list.find(one => one.toolUseId === call.toolUseId && one.kind !== 'workflow')
    return call.isError && started !== undefined ? list.map(one => (one.id === started.id ? end(one, 'failed', now) : one)) : [...list]
  }
  const make = (id: string, kind: AgentKind): AgentRecord => ({
    ...blankAgent(id, kind, now),
    label: label(call.description ?? call.subagentType ?? id),
    type: call.subagentType ?? '',
    toolUseId: call.toolUseId,
    parentId: call.parentId,
  })
  switch (outcome.kind) {
    case 'remote':
      return upsert(list, outcome.taskId, () => make(outcome.taskId, 'subagent'), record => ({
        ...record,
        type: record.type || 'remote',
        taskId: outcome.taskId,
        isBackground: true,
        lastActivityAt: now,
      }))
    case 'async':
      return upsert(list, outcome.agentId, () => make(outcome.agentId, 'subagent'), record => ({
        ...record,
        isBackground: true,
        toolUseId: record.toolUseId ?? call.toolUseId,
        model: record.model ?? outcome.resolvedModel,
        lastActivityAt: now,
      }))
    case 'teammate':
      return upsert(list, outcome.agentId, () => make(outcome.agentId, 'teammate'), record => ({
        ...record,
        kind: 'teammate',
        label: outcome.name !== undefined ? label(outcome.name) : record.label,
        name: outcome.name ?? record.name,
        teammateId: outcome.teammateId ?? record.teammateId,
        type: outcome.agentType ?? record.type,
        model: record.model ?? outcome.model,
        isBackground: true,
        lastActivityAt: now,
      }))
    case 'completed':
      return upsert(list, outcome.agentId, () => make(outcome.agentId, 'subagent'), record => ({
        ...end(record, 'completed', now),
        type: record.type || (outcome.agentType ?? ''),
        model: record.model ?? outcome.resolvedModel,
        toolCalls: Math.max(record.toolCalls, outcome.totalToolUseCount ?? 0),
        contextTokens: outcome.totalTokens ?? record.contextTokens,
      }))
  }
}

/** Ends these rows, and the agents of any workflow among them, which end with their run. */
const endWithRuns = (list: readonly AgentRecord[], ids: ReadonlySet<string>, status: AgentRunStatus, now: number): AgentRecord[] =>
  list.map(one =>
    ids.has(one.id) || (one.kind === 'workflow-agent' && one.parentId !== undefined && ids.has(one.parentId)) ? end(one, status, now) : one,
  )

/** A TaskStop call stopped this task: the agent, workflow or remote agent it names, by id, task id or name. */
export const stopTask = (list: readonly AgentRecord[], taskId: string, now: number): AgentRecord[] => {
  const stopped = list.filter(one => one.id === taskId || one.taskId === taskId || (one.name !== undefined && one.name === taskId))
  return endWithRuns(list, new Set(stopped.map(one => one.id)), 'killed', now)
}

/** One background task the session still has in flight, as a Stop hook reads it. */
export type TaskSnapshot = { id: string; type: string; description: string; name?: string }

/**
 * The tasks still in flight when the main loop stopped: a workflow or remote
 * agent no longer among them has finished; a workflow not yet known is added.
 */
export const reconcileTasks = (list: readonly AgentRecord[], tasks: readonly TaskSnapshot[], now: number): AgentRecord[] => {
  const inFlight = new Set(tasks.map(task => task.id))
  const done = list.filter(one => one.taskId !== undefined && !inFlight.has(one.taskId) && !isEnded(one.status))
  let merged: AgentRecord[] = endWithRuns(list, new Set(done.map(one => one.id)), 'completed', now)
  for (const task of tasks) {
    if (task.type !== 'workflow' || merged.some(one => one.taskId === task.id)) {
      continue
    }
    merged = upsert(
      merged,
      task.id,
      () => ({ ...blankAgent(task.id, 'workflow', now), taskId: task.id }),
      record => ({ ...record, label: label(task.name ?? (task.description || record.label)), description: task.description === '' ? record.description : oneLine(task.description, 400) }),
    )
  }
  return merged
}

/** At most `max` records: every working one, then the most recently ended. */
export const capAgents = (list: readonly AgentRecord[], max: number): AgentRecord[] => {
  if (list.length <= max) {
    return [...list]
  }
  const dropped = new Set(
    list
      .filter(one => isEnded(one.status))
      .sort((a, b) => (a.endedAt ?? a.lastActivityAt) - (b.endedAt ?? b.lastActivityAt))
      .slice(0, list.length - max)
      .map(one => one.id),
  )
  return list.filter(one => !dropped.has(one.id))
}

// ------------------------------------------------------------------------- //
// What the tab draws
// ------------------------------------------------------------------------- //

const shellStatus = (status: CommandStatus): AgentRunStatus =>
  status === 'running' || status === 'background' ? 'running' : status === 'ok' ? 'completed' : status === 'error' ? 'failed' : 'killed'

export const SHELL_PREFIX = 'shell:'

/** Background shell commands as agent rows, nested under the agent that ran them. */
export const shellRecords = (commands: readonly CommandRecord[]): AgentRecord[] =>
  commands
    .filter(command => command.tool === 'Bash' && command.isBackground)
    .map(command => {
      const status = shellStatus(command.status)
      return {
        ...blankAgent(`${SHELL_PREFIX}${command.id}`, 'shell', command.startedAt),
        label: label(command.description ?? command.title),
        type: 'shell',
        description: command.title,
        status,
        parentId: command.agentId,
        toolUseId: command.id,
        isBackground: true,
        model: command.model,
        effort: command.effort,
        endedAt: isEnded(status) ? command.endedAt : undefined,
        lastActivityAt: command.endedAt ?? command.startedAt,
      }
    })

/**
 * The tool calls an agent's opened row lists, the newest first: those made
 * inside it, or for a workflow those its agents made. A background shell
 * lists none: its row is a call itself, which the Commands tab opens.
 */
export const callsOf = (record: AgentRecord, agents: readonly AgentRecord[], commands: readonly CommandRecord[]): CommandRecord[] => {
  const owners = new Set(ownersOf(record, agents))
  return commands.filter(call => call.agentId !== undefined && owners.has(call.agentId)).reverse()
}

/**
 * The agents whose calls are an agent's: its own, or a workflow's agents';
 * none for a background shell.
 */
export const ownersOf = (record: AgentRecord, agents: readonly AgentRecord[]): string[] =>
  record.kind === 'shell' ? [] : record.kind === 'workflow' ? agents.filter(one => one.parentId === record.id).map(one => one.id) : [record.id]

/**
 * The calls made inside an agent, the newest first: those the monitor holds,
 * and those read from its transcript (`history`, when it is this agent's)
 * that it does not, older than the calls it keeps or from before it loaded.
 */
export const allCallsOf = (record: AgentRecord, agents: readonly AgentRecord[], commands: readonly CommandRecord[], history: AgentHistory | null): CommandRecord[] => {
  const held = callsOf(record, agents, commands)
  if (history === null || history.agentId !== record.id || history.calls.length === 0) {
    return held
  }
  const owners = new Set(ownersOf(record, agents))
  const ids = new Set(held.map(call => call.id))
  const read = history.calls.filter(call => call.agentId !== undefined && owners.has(call.agentId) && !ids.has(call.id))
  return [...held, ...read].sort((a, b) => b.startedAt - a.startedAt)
}

/**
 * Whether the Agents tab's open row (`openId`) lists this call: a press on
 * one it lists opens the call there, any other in the Commands tab.
 */
export const listsCall = (openId: string | null | undefined, callId: string, agents: readonly AgentRecord[], commands: readonly CommandRecord[], history: AgentHistory | null = null): boolean => {
  const open = agents.find(one => one.id === openId)
  return open !== undefined && allCallsOf(open, agents, commands, history).some(call => call.id === callId)
}

/**
 * The status a row shows: its own, except a workflow whose agents have all
 * ended and that has been quiet a long while, which has finished even when
 * the end was not seen.
 */
export const effectiveStatus = (record: AgentRecord, all: readonly AgentRecord[], now: number): AgentRunStatus => {
  if (record.kind !== 'workflow' || isEnded(record.status)) {
    return record.status
  }
  const children = all.filter(one => one.parentId === record.id)
  if (children.length === 0 || children.some(one => !isEnded(one.status))) {
    return record.status
  }
  const quietSince = Math.max(record.lastActivityAt, ...children.map(one => one.endedAt ?? one.lastActivityAt))
  return now - quietSince >= WORKFLOW_QUIET_MS ? 'completed' : record.status
}

/** The tokens a row counts: the latest request's size, or the sums where no request said. */
export const tokensOf = (record: AgentRecord): number => (record.contextTokens > 0 ? record.contextTokens : record.tokensIn + record.tokensOut)

export type AgentRow = {
  record: AgentRecord
  depth: number
  status: AgentRunStatus
  /** A workflow's agents; 0 for any other row. */
  agents: number
  /** The rows drawn under it: a workflow's agents, an agent's sub-agents and background shells. */
  children: number
  /** Its own figures, or for a workflow its agents' summed. */
  tokens: number
  requests: number
  toolCalls: number
  usd: number
}

export type AgentLayout = { running: AgentRow[]; finished: AgentRow[]; runningRoots: number; finishedRoots: number }

/**
 * The rows drawn: the roots, and the rows under a parent only while it is
 * shown (`shown`, by id), every parent above them too: a parent's children
 * are folded away until it is expanded.
 */
export const visibleRows = (rows: readonly AgentRow[], shown: ReadonlySet<string>): AgentRow[] => {
  // Along the path to the row at hand: whether each parent above it shows its children.
  const path: boolean[] = []
  return rows.filter(row => {
    path.length = Math.min(path.length, row.depth)
    const isDrawn = path.every(Boolean)
    path.push(isDrawn && shown.has(row.record.id))
    return isDrawn
  })
}

/** The parents above an agent, the nearest first: its workflow's, or the agent that started it, and theirs. */
export const ancestorsOf = (id: string | null | undefined, records: readonly AgentRecord[]): string[] => {
  const byId = new Map(records.map(one => [one.id, one]))
  const found: string[] = []
  let parent = id === null || id === undefined ? undefined : byId.get(id)?.parentId
  while (parent !== undefined && parent !== id && !found.includes(parent) && found.length < MAX_DEPTH) {
    found.push(parent)
    parent = byId.get(parent)?.parentId
  }
  return found
}

/** The agents a row draws under it, oldest first: its own children. */
export const childrenOf = (record: AgentRecord, records: readonly AgentRecord[]): AgentRecord[] =>
  records.filter(one => one.parentId === record.id && one.id !== record.id).sort((a, b) => a.startedAt - b.startedAt)

const MAX_DEPTH = 6

/**
 * The rows of both sections: each top-level row with what it started nested
 * beneath it, a workflow's agents included. A tree sits in "Running now"
 * until its top row has ended; newest first in each section.
 */
export const layoutAgents = (records: readonly AgentRecord[], now: number): AgentLayout => {
  const ids = new Set(records.map(one => one.id))
  const children = new Map<string, AgentRecord[]>()
  const roots: AgentRecord[] = []
  for (const record of records) {
    const parent = record.parentId
    if (parent !== undefined && parent !== record.id && ids.has(parent)) {
      children.set(parent, [...(children.get(parent) ?? []), record])
    } else {
      roots.push(record)
    }
  }
  const seen = new Set<string>()
  const rowsOf = (record: AgentRecord, depth: number): AgentRow[] => {
    if (seen.has(record.id)) {
      return []
    }
    seen.add(record.id)
    const kids = [...(children.get(record.id) ?? [])].sort((a, b) => a.startedAt - b.startedAt)
    const status = effectiveStatus(record, records, now)
    const isWorkflow = record.kind === 'workflow'
    const sum = (pick: (one: AgentRecord) => number): number => (isWorkflow ? kids.reduce((total, one) => total + pick(one), 0) : pick(record))
    const row: AgentRow = {
      record,
      depth,
      status,
      agents: isWorkflow ? kids.length : 0,
      children: depth >= MAX_DEPTH ? 0 : kids.length,
      tokens: sum(tokensOf),
      requests: sum(one => one.requests),
      toolCalls: sum(one => one.toolCalls),
      usd: sum(one => one.usd ?? 0),
    }
    return [row, ...(depth >= MAX_DEPTH ? [] : kids.flatMap(kid => rowsOf(kid, depth + 1)))]
  }
  /** Whether anything in the tree still works or waits: a finished agent's background shell keeps it running. */
  const isTreeOpen = (record: AgentRecord, depth: number): boolean =>
    !isEnded(effectiveStatus(record, records, now)) ||
    (depth < MAX_DEPTH && (children.get(record.id) ?? []).some(kid => kid.id !== record.id && isTreeOpen(kid, depth + 1)))
  const running: AgentRow[] = []
  const finished: AgentRow[] = []
  let runningRoots = 0
  let finishedRoots = 0
  const ordered = [...roots].sort((a, b) => b.startedAt - a.startedAt)
  for (const root of ordered.filter(one => isTreeOpen(one, 0))) {
    running.push(...rowsOf(root, 0))
    runningRoots += 1
  }
  const ended = ordered
    .filter(one => !isTreeOpen(one, 0))
    .sort((a, b) => (b.endedAt ?? b.lastActivityAt) - (a.endedAt ?? a.lastActivityAt))
  for (const root of ended) {
    finished.push(...rowsOf(root, 0))
    finishedRoots += 1
  }
  return { running, finished, runningRoots, finishedRoots }
}

/** The header's figures: every row so far, and how many are working now. */
export const agentCounts = (records: readonly AgentRecord[], commands: readonly CommandRecord[], now: number): { agents: number; agentsLive: number } => {
  const all = [...records, ...shellRecords(commands)]
  return { agents: all.length, agentsLive: all.filter(one => isLive(effectiveStatus(one, all, now))).length }
}
