// Past sessions read back from Claude Code's own transcripts
// (`sampler/transcripts.py`): the project's sessions for the picker, one
// session's prompts and calls as a record the pane can draw, and this
// session's earlier activity, put back when the app reopens. The monitor's
// own records (lib/history.ts) begin with the version that kept them and hold
// figures a transcript has not (energy, network, memory); a transcript goes
// back as far as Claude Code kept it and holds each call's output. Pure.

import type { CommandRecord, CommandSpend, CostBreakdown, PromptRecord, PromptRun, SessionEntry, SessionSnapshot, UsageView } from '../../types'
import { finishRecord, startRecord } from './commands'
import { SNAPSHOT_VERSION } from './history'
import { quickSummary } from './prompts'
import { addParts, EMPTY_SPEND, requestSpend, shareOut, type RequestSpend } from './spend'

/** The reader, relative to the plugin's folder. */
export const TRANSCRIPTS_SCRIPT = 'sampler/transcripts.py'

/** How many sessions the picker lists, the monitor's records and the transcripts' together. */
export const MAX_LISTED = 40

/** A session as the reader lists it. */
export type TranscriptSummary = {
  id: string
  startedAt: number
  lastAt: number
  title: string
  prompts: number
  calls: number
  cwd: string
  branch: string
}

/** Tokens one model's requests reported, summed, and how many requests; of the cache writes, those kept an hour (absent from an older reader's answer). */
export type TranscriptUsage = { model: string; requests: number; input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number }

/** A prompt: its main loop's requests by model, and when its last record was written. */
export type TranscriptPrompt = { id: string; text: string; at: number; usage?: TranscriptUsage[]; endedAt?: number }

export type TranscriptCall = {
  id: string
  name: string
  input: Record<string, unknown>
  startedAt: number
  endedAt?: number
  isError: boolean
  output: string
  model?: string
  promptId?: string
  /** Its whole output's length (`output` is cut), and the request that read it, by its message id. */
  outputChars?: number
  readBy?: string
}

/** One agent's calls as the reader reads them from its own transcript, and the requests that read them. */
export type TranscriptAgent = { id: string; calls: TranscriptCall[]; requests: Record<string, TranscriptUsage> }

/** One session as the reader reads it. */
export type TranscriptSession = {
  id: string
  title: string
  cwd: string
  branch: string
  startedAt: number
  lastAt: number
  prompts: TranscriptPrompt[]
  calls: TranscriptCall[]
  /** The requests that read a call's output, by message id. */
  requests?: Record<string, TranscriptUsage>
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const SESSION_ID = /^[A-Za-z0-9-]{1,80}$/

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const summaryOf = (value: unknown): TranscriptSummary | undefined => {
  if (!isRecord(value) || !SESSION_ID.test(str(value.id)) || num(value.startedAt) <= 0) {
    return undefined
  }
  return {
    id: str(value.id),
    startedAt: num(value.startedAt),
    lastAt: Math.max(num(value.startedAt), num(value.lastAt)),
    title: str(value.title).slice(0, 200),
    prompts: num(value.prompts),
    calls: num(value.calls),
    cwd: str(value.cwd),
    branch: str(value.branch),
  }
}

/** The reader's `list` answer: the sessions that parse, each id once (its latest). */
export const parseSummaries = (text: string): TranscriptSummary[] => {
  const value = parseJson(text)
  const byId = new Map<string, TranscriptSummary>()
  for (const one of Array.isArray(value) ? value : []) {
    const summary = summaryOf(one)
    const known = summary === undefined ? undefined : byId.get(summary.id)
    if (summary !== undefined && (known === undefined || known.lastAt < summary.lastAt)) {
      byId.set(summary.id, summary)
    }
  }
  return [...byId.values()].sort((a, b) => b.lastAt - a.lastAt)
}

const MESSAGE_ID = /^[A-Za-z0-9_-]{1,120}$/

const usageOf = (value: unknown): TranscriptUsage | undefined =>
  isRecord(value) && str(value.model) !== '' && num(value.requests) > 0
    ? {
        model: str(value.model).slice(0, 120),
        requests: num(value.requests),
        input: num(value.input),
        output: num(value.output),
        cacheRead: num(value.cacheRead),
        cacheWrite: num(value.cacheWrite),
        ...(typeof value.cacheWrite1h === 'number' ? { cacheWrite1h: Math.min(num(value.cacheWrite1h), num(value.cacheWrite)) } : {}),
      }
    : undefined

const promptOf = (value: unknown): TranscriptPrompt | undefined => {
  if (!isRecord(value) || str(value.id) === '' || str(value.text) === '') {
    return undefined
  }
  const usage = (Array.isArray(value.usage) ? value.usage : []).flatMap((one): TranscriptUsage[] => {
    const read = usageOf(one)
    return read === undefined ? [] : [read]
  })
  const endedAt = num(value.endedAt)
  return { id: str(value.id), text: str(value.text), at: num(value.at), ...(usage.length > 0 ? { usage } : {}), ...(endedAt > 0 ? { endedAt } : {}) }
}

const callOf = (value: unknown): TranscriptCall | undefined => {
  if (!isRecord(value) || str(value.id) === '' || str(value.name) === '') {
    return undefined
  }
  const endedAt = num(value.endedAt)
  return {
    id: str(value.id),
    name: str(value.name),
    input: isRecord(value.input) ? value.input : {},
    startedAt: num(value.startedAt),
    ...(endedAt > 0 ? { endedAt } : {}),
    isError: value.isError === true,
    output: str(value.output),
    ...(str(value.model) !== '' ? { model: str(value.model) } : {}),
    ...(str(value.promptId) !== '' ? { promptId: str(value.promptId) } : {}),
    ...(typeof value.outputChars === 'number' ? { outputChars: num(value.outputChars) } : {}),
    ...(MESSAGE_ID.test(str(value.readBy)) ? { readBy: str(value.readBy) } : {}),
  }
}

/** The reader's `read` answer; undefined for an error or what does not parse. */
export const parseSession = (text: string): TranscriptSession | undefined => {
  const value = parseJson(text)
  if (!isRecord(value) || !SESSION_ID.test(str(value.id)) || !Array.isArray(value.prompts) || !Array.isArray(value.calls)) {
    return undefined
  }
  const prompts = value.prompts.flatMap((one): TranscriptPrompt[] => {
    const prompt = promptOf(one)
    return prompt === undefined ? [] : [prompt]
  })
  return { id: str(value.id), title: str(value.title), cwd: str(value.cwd), branch: str(value.branch), startedAt: num(value.startedAt), lastAt: num(value.lastAt), prompts, calls: callsOfAnswer(value.calls), requests: requestsOf(value.requests) }
}

/** The calls of an answer that parse. */
const callsOfAnswer = (value: unknown): TranscriptCall[] =>
  (Array.isArray(value) ? value : []).flatMap((one): TranscriptCall[] => {
    const call = callOf(one)
    return call === undefined ? [] : [call]
  })

/** The requests of an answer that parse, by message id. */
const requestsOf = (value: unknown): Record<string, TranscriptUsage> =>
  Object.fromEntries(
    Object.entries(isRecord(value) ? value : {}).flatMap(([id, one]): [string, TranscriptUsage][] => {
      const usage = usageOf(one)
      return MESSAGE_ID.test(id) && usage !== undefined ? [[id, usage]] : []
    }),
  )

/** An agent id as the reader takes one, and as Claude Code names an agent's transcript. */
export const AGENT_ID = /^[A-Za-z0-9_-]{1,80}$/

/** The reader's `agents` answer: each agent found, its calls and their readers; undefined for an error or what does not parse. */
export const parseAgents = (text: string): TranscriptAgent[] | undefined => {
  const value = parseJson(text)
  if (!isRecord(value) || !Array.isArray(value.agents)) {
    return undefined
  }
  return value.agents.flatMap((one): TranscriptAgent[] =>
    isRecord(one) && AGENT_ID.test(str(one.id)) ? [{ id: str(one.id), calls: callsOfAnswer(one.calls), requests: requestsOf(one.requests) }] : [],
  )
}

/**
 * One model's requests priced as one request of their summed tokens (its price
 * is linear in them), its cache writes at the rate of how long each was kept;
 * undefined for a model without a price.
 */
const priceOf = (usage: TranscriptUsage): RequestSpend | undefined =>
  requestSpend(
    { input_tokens: usage.input, output_tokens: usage.output, cache_read_input_tokens: usage.cacheRead, cache_creation_input_tokens: usage.cacheWrite },
    usage.model,
    usage.cacheWrite > 0 ? (usage.cacheWrite1h ?? 0) / usage.cacheWrite : 0,
  )

/**
 * A transcript's prompt's work as the pane records a run: its requests'
 * tokens and price, ended at its last record. Undefined when no request
 * worked for it. What only the live session sees (turns, time worked,
 * context, windows, the machine's counters) is left out.
 */
export const runOfTranscript = (prompt: TranscriptPrompt): PromptRun | undefined => {
  const usage = prompt.usage ?? []
  const requests = usage.reduce((total, one) => total + one.requests, 0)
  if (requests === 0) {
    return undefined
  }
  const sum = (field: 'input' | 'output' | 'cacheRead' | 'cacheWrite'): number => usage.reduce((total, one) => total + one[field], 0)
  const parts = usage.reduce<CostBreakdown | undefined>((total, one) => {
    const price = priceOf(one)
    return price === undefined ? total : addParts(total, price.parts)
  }, undefined)
  return {
    turns: 1,
    workMs: 0,
    endedAt: Math.max(prompt.at, prompt.endedAt ?? prompt.at),
    requests,
    tokens: { input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite') },
    usd: usage.reduce((total, one) => total + (priceOf(one)?.usd ?? 0), 0),
    ...(parts === undefined ? {} : { parts }),
    // The model that answered most of them.
    model: [...usage].sort((a, b) => b.requests - a.requests)[0]?.model,
  }
}

/** A transcript's session as the picker lists it: marked as read from its transcript. */
export const entryOfSummary = (summary: TranscriptSummary): SessionEntry => ({
  id: summary.id,
  startedAt: summary.startedAt,
  lastAt: summary.lastAt,
  title: summary.title,
  prompts: summary.prompts,
  commands: summary.calls,
  bytes: 0,
  source: 'transcript',
})

/**
 * The picker's list: the monitor's records and the transcripts' sessions
 * together, each session once (the monitor's record, which has its figures,
 * taking a title from the transcript when it has none), the running one left
 * out, the newest MAX_LISTED.
 */
export const mergeEntries = (stored: readonly SessionEntry[], found: readonly TranscriptSummary[], liveId: string): SessionEntry[] => {
  const titles = new Map(found.map(one => [one.id, one.title]))
  const byId = new Map<string, SessionEntry>()
  for (const entry of stored) {
    byId.set(entry.id, entry.title === '' ? { ...entry, title: titles.get(entry.id) ?? '' } : entry)
  }
  for (const summary of found) {
    if (!byId.has(summary.id)) {
      byId.set(summary.id, entryOfSummary(summary))
    }
  }
  return [...byId.values()]
    .filter(one => one.id !== liveId)
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, MAX_LISTED)
}

const EMPTY_USAGE: UsageView = { contextWindow: 0, rateLimits: [], model: '', turns: 0, sessionStartedAt: 0, updatedAt: 0 }

/** A transcript's prompt as the pane records one: its task is its prompt id, which its calls carry; its run, its requests' tokens. */
export const promptOfTranscript = (prompt: TranscriptPrompt): PromptRecord => {
  const run = runOfTranscript(prompt)
  return {
    id: `t:${prompt.id}`,
    text: prompt.text,
    summary: quickSummary(prompt.text),
    isModelSummary: false,
    at: prompt.at,
    origin: 'composer',
    taskId: prompt.id,
    ...(run !== undefined ? { run } : {}),
  }
}

/** A transcript's call as the pane records one: started (inside `agentId`, an agent's), then finished with its outcome and output. */
export const commandOfTranscript = (call: TranscriptCall, agentId?: string): CommandRecord => {
  const started = startRecord(call.id, call.name, call.input, call.startedAt, agentId, 'engine')
  const record =
    call.endedAt === undefined
      ? { ...started, status: 'denied' as const, endedAt: call.startedAt }
      : finishRecord(started, { isDenied: false, isError: call.isError, text: call.output, isReadOnly: false }, call.endedAt)
  return {
    ...record,
    ...(call.outputChars !== undefined ? { outputChars: call.outputChars } : {}),
    ...(call.model !== undefined ? { model: call.model } : {}),
    ...(call.promptId !== undefined ? { promptId: call.promptId } : {}),
  }
}

/**
 * A transcript's calls, each with its share of the request that read its
 * output, split by size as the live session splits it (lib/spend.ts
 * shareOut); a call no priced request read has none.
 */
export const commandsOfTranscript = (session: TranscriptSession): CommandRecord[] => sharedCommands(session.calls, session.requests ?? {})

/** An agent's calls from its own transcript as the pane records them: inside it, each with its share of the request that read it. */
export const commandsOfAgent = (agent: TranscriptAgent): CommandRecord[] => sharedCommands(agent.calls, agent.requests, agent.id)

/** Calls as records, inside `agentId` when one's, each with its share of the priced request that read its output. */
const sharedCommands = (calls: readonly TranscriptCall[], requests: Readonly<Record<string, TranscriptUsage>>, agentId?: string): CommandRecord[] => {
  const records = calls.map(call => commandOfTranscript(call, agentId))
  const readers = new Map<string, CommandRecord[]>()
  calls.forEach((call, index) => {
    const record = records[index]
    if (call.readBy !== undefined && record !== undefined) {
      readers.set(call.readBy, [...(readers.get(call.readBy) ?? []), record])
    }
  })
  const shares = new Map<string, CommandSpend>()
  for (const [id, read] of readers) {
    const usage = requests[id]
    const request = usage === undefined ? undefined : priceOf(usage)
    if (request !== undefined) {
      for (const [callId, share] of shareOut(request, read.map(record => ({ id: record.id, weight: record.outputChars + record.title.length })))) {
        shares.set(callId, share)
      }
    }
  }
  return records.map(record => {
    const share = shares.get(record.id)
    return share === undefined ? record : { ...record, spend: share }
  })
}

/**
 * A transcript as a past session's record: its prompts with their requests'
 * tokens, and its calls with their shares of them, each call's output kept
 * beside it (`outputs`, never stored); the figures only the monitor measures
 * (energy, network, memory) are absent.
 */
export const snapshotOfTranscript = (session: TranscriptSession, project: string): SessionSnapshot => {
  const commands = commandsOfTranscript(session)
  return {
    v: SNAPSHOT_VERSION,
    id: session.id,
    project,
    root: session.cwd,
    branch: session.branch,
    head: '',
    startedAt: session.startedAt,
    lastAt: session.lastAt,
    title: session.title,
    prompts: session.prompts.map(promptOfTranscript),
    commands,
    agents: [],
    touched: [],
    worktree: [],
    commits: [],
    artifacts: [],
    usage: { ...EMPTY_USAGE, sessionStartedAt: session.startedAt },
    spend: EMPTY_SPEND,
    sources: { urls: 0, domains: 0, searches: 0 },
    models: [],
    source: 'transcript',
    outputs: Object.fromEntries(session.calls.filter(call => call.output !== '').map(call => [call.id, call.output])),
  }
}

/** A prompt the transcript holds within this long before the record's first is the same prompt, seen by both. */
export const PROMPT_SLACK_MS = 5_000

/**
 * A session's record joined with its transcript: the record's prompts and
 * calls with their figures, and the transcript's from before the record began
 * or that fitting it dropped; each call's output from the transcript. Either
 * side alone is shown as it is; undefined when there is neither.
 */
export const joinTranscript = (
  stored: SessionSnapshot | undefined,
  transcript: TranscriptSession | undefined,
  project: string,
): SessionSnapshot | undefined => {
  if (transcript === undefined) {
    return stored
  }
  const found = snapshotOfTranscript(transcript, project)
  if (stored === undefined) {
    return found
  }
  const calls = new Set(stored.commands.map(one => one.id))
  const firstPrompt = stored.prompts.reduce((first, one) => Math.min(first, one.at), Infinity)
  return {
    ...stored,
    title: stored.title !== '' ? stored.title : found.title,
    lastAt: Math.max(stored.lastAt, found.lastAt),
    prompts: [...found.prompts.filter(one => one.at < firstPrompt - PROMPT_SLACK_MS), ...stored.prompts].sort((a, b) => a.at - b.at),
    commands: [...found.commands.filter(one => !calls.has(one.id)), ...stored.commands].sort((a, b) => a.startedAt - b.startedAt),
    outputs: found.outputs,
  }
}
