// Past sessions: each session's record, kept in `$.store` so later sessions
// of the same project can show it in place of their own (the Prompts, Agents,
// Files, Commits and Commands tabs, and Overview's Session and Artifacts
// cards). A record holds what those draw, trimmed and capped so it stays well
// inside the store's 4 MiB, which every key shares: no outputs, no sampler
// groups, short texts. It is read back validated, what does not parse
// dropped. A project's list of its records keeps the newest MAX_SESSIONS, and
// every project's records together stay under HISTORY_CHARS. Pure.

import type {
  Access,
  CostBreakdown,
  CostPart,
  AgentKind,
  AgentPhase,
  AgentRecord,
  AgentRun,
  AgentRunStatus,
  ArtifactRecord,
  CommandActor,
  CommandFlow,
  CommandMetrics,
  CommandRecord,
  CommandSpend,
  CommandStatus,
  CommitInfo,
  FileActivity,
  FileChange,
  FileStatus,
  FlowLink,
  GitView,
  ModelUse,
  PromptRecord,
  PromptRun,
  RateLimitView,
  SessionEntry,
  SessionSnapshot,
  SessionSources,
  SourceRecord,
  SpendBlock,
  SpendView,
  Totals,
  TouchedFile,
  TurnEnd,
  UsageView,
  WindowUse,
} from '../../types'
import { isLive } from './agents'
import { emptyMetrics } from './commands'
import { clip, fmtUsd, oneLine } from './format'
import { quickSummary } from './prompts'
import { ZERO_RATES } from './sampler'
import { summarizeSources } from './sources'

/** The record's layout; a record of another is not read. */
export const SNAPSHOT_VERSION = 1
/** How many past sessions a project keeps. */
export const MAX_SESSIONS = 10
/** How much JSON one record may take, and every project's records together: the store holds 4 MiB in all, the prompts' history included. */
export const SNAPSHOT_CHARS = 96_000
export const HISTORY_CHARS = 1_000_000

/** How much of each list a record keeps: the newest. */
export const SNAPSHOT_CAPS = {
  prompts: 60,
  commands: 150,
  agents: 40,
  touched: 200,
  worktree: 100,
  commits: 30,
  commitFiles: 60,
  artifacts: 30,
  models: 12,
} as const

/** How much of a prompt's words a record keeps: a closed card shows less, an opened one this much. */
export const PROMPT_TEXT_CHARS = 1_000

/** The store key of a project's list of past sessions: by its repository's main working tree, as its prompts are. */
export const historyKey = (project: string): string => `${HISTORY_PREFIX}${project}`
export const HISTORY_PREFIX = 'sessions:'

/** The store key of one session's record. */
export const snapshotKey = (id: string): string => `${SNAPSHOT_PREFIX}${id}`
export const SNAPSHOT_PREFIX = 'session:'

/** What a past session's file shows: its text or diff as it is now. */
export const TODAY_NOTE = 'As it is today: it may have changed since that session.'

/** What a past session's commit shows when git no longer has it. */
export const MISSING_COMMIT = 'This commit is no longer in this repository (rebased, amended, or made in another clone), so its diff cannot be shown.'

// ------------------------------------------------------------------------- //
// Building a record from what the tabs draw
// ------------------------------------------------------------------------- //

/** What a session's record is built from: the pane's values now, and the record it saved last. */
export type SnapshotParts = {
  id: string
  project: string
  /** Where the record begins: a `/clear` or a resume gave the session a new id then; 0 before one. */
  floor: number
  /** When the session began, as it says; 0 when unknown. */
  startedAt: number
  prompts: readonly PromptRecord[]
  commands: readonly CommandRecord[]
  agents: readonly AgentRecord[]
  touched: readonly TouchedFile[]
  git: GitView
  artifacts: readonly ArtifactRecord[]
  usage: UsageView
  spend: SpendView
  sources: readonly SourceRecord[]
  models: readonly ModelUse[]
  /** The record saved last under this id, if any: what it held that the live lists no longer do stays. */
  previous?: SessionSnapshot
}

const cut = (text: string | undefined, max: number): string | undefined => (text === undefined ? undefined : clip(text, max))

const trimLink = (link: FlowLink): FlowLink => ({ id: link.id, tool: clip(link.tool, 80), summary: clip(link.summary, 100), uses: link.uses.slice(0, 2).map(bit => clip(bit, 40)) })

const trimFlow = (flow: CommandFlow | undefined): CommandFlow | undefined =>
  flow === undefined
    ? undefined
    : {
        after: flow.after?.slice(0, 3).map(trimLink),
        readAt: flow.readAt,
        said: cut(flow.said, 160),
        asked: flow.asked?.slice(0, 6).map(name => clip(name, 60)),
        isLast: flow.isLast,
        next: flow.next?.slice(0, 3).map(trimLink),
      }

/** A call as a record keeps it: no output (kept apart anyway), no sampler groups, no live rates; its texts short. */
const trimCommand = (record: CommandRecord): CommandRecord => ({
  ...record,
  title: clip(record.title, 400),
  description: cut(record.description, 200),
  summary: clip(record.summary, 160),
  preview: clip(record.preview, 160),
  filePath: cut(record.filePath, 400),
  groups: [],
  metrics: { ...record.metrics, ...ZERO_RATES, mem: 0, procs: 0 },
  flow: trimFlow(record.flow),
  actor: { kind: record.actor.kind, name: clip(record.actor.name, 80) },
})

const trimPrompt = (prompt: PromptRecord): PromptRecord => ({
  ...prompt,
  text: clip(prompt.text, PROMPT_TEXT_CHARS),
  summary: clip(prompt.summary, 120),
  run: prompt.run === undefined ? undefined : { ...prompt.run, agents: prompt.run.agents?.slice(-20), windows: prompt.run.windows?.slice(0, 4) },
})

const trimAgent = (record: AgentRecord): AgentRecord => ({
  ...record,
  label: clip(record.label, 100),
  type: clip(record.type, 60),
  description: cut(record.description, 300),
  brief: cut(record.brief, 300),
  lastAnswer: cut(record.lastAnswer, 200),
  phases: record.phases?.slice(0, 10).map(one => clip(one, 60)),
  runs: record.runs?.slice(-5),
  phase: record.phase === undefined ? undefined : { ...record.phase, detail: clip(record.phase.detail, 120) },
})

const trimTouched = (file: TouchedFile): TouchedFile => ({ ...file, tools: file.tools.slice(0, 6) })

const trimChange = (change: FileChange): FileChange => ({
  path: change.path,
  oldPath: change.oldPath,
  status: change.status,
  added: change.added,
  removed: change.removed,
  isBinary: change.isBinary,
  isUntracked: change.isUntracked,
})

const trimCommit = (commit: CommitInfo): CommitInfo => ({
  sha: commit.sha,
  short: commit.short,
  subject: clip(commit.subject, 200),
  body: clip(commit.body, 1_000),
  author: clip(commit.author, 100),
  email: clip(commit.email, 100),
  date: commit.date,
  parents: commit.parents.slice(0, 1),
  refs: '',
  files: commit.files.slice(0, SNAPSHOT_CAPS.commitFiles).map(trimChange),
  isSession: true,
})

const trimArtifact = (one: ArtifactRecord): ArtifactRecord => ({ ...one, title: clip(one.title, 120), caption: cut(one.caption, 160) })

const trimUsage = (usage: UsageView): UsageView => ({ ...usage, model: clip(usage.model, 80), rateLimits: usage.rateLimits.slice(0, 4) })

/** The live list over the earlier record's, matched by `key`: what only the record held is kept; sorted by `order`. */
const mergeBy = <T>(previous: readonly T[], current: readonly T[], key: (item: T) => string, order: (a: T, b: T) => number): T[] => {
  const ids = new Set(current.map(key))
  return [...previous.filter(item => !ids.has(key(item))), ...current].sort(order)
}

const latest = (times: readonly number[], floor: number): number => times.reduce((top, one) => (one > top ? one : top), floor)

/**
 * A session's record from the pane's values: its prompts, calls, agents,
 * files, commits and artifacts since `floor`, merged into the record it saved
 * last, each list capped to its newest and each record trimmed; and its
 * usage. Undefined while there is nothing to keep (no prompt, no call).
 */
export const buildSnapshot = (parts: SnapshotParts): SessionSnapshot | undefined => {
  const floor = parts.floor
  const before = parts.previous?.id === parts.id ? parts.previous : undefined
  const prompts = mergeBy(before?.prompts ?? [], parts.prompts.filter(one => one.at >= floor), one => one.id, (a, b) => a.at - b.at)
    .slice(-SNAPSHOT_CAPS.prompts)
    .map(trimPrompt)
  const commands = mergeBy(before?.commands ?? [], parts.commands.filter(one => one.startedAt >= floor), one => one.id, (a, b) => a.startedAt - b.startedAt)
    .slice(-SNAPSHOT_CAPS.commands)
    .map(trimCommand)
  if (prompts.length === 0 && commands.length === 0) {
    return undefined
  }
  const agents = mergeBy(before?.agents ?? [], parts.agents.filter(one => one.startedAt >= floor), one => one.id, (a, b) => a.startedAt - b.startedAt)
    .slice(-SNAPSHOT_CAPS.agents)
    .map(trimAgent)
  const touched = mergeBy(before?.touched ?? [], parts.touched.filter(one => one.lastAt >= floor), one => one.path, (a, b) => a.lastAt - b.lastAt)
    .slice(-SNAPSHOT_CAPS.touched)
    .map(trimTouched)
  const commits = mergeBy(before?.commits ?? [], parts.git.commits.filter(one => one.isSession && one.date >= floor), one => one.sha, (a, b) => b.date - a.date)
    .slice(0, SNAPSHOT_CAPS.commits)
    .map(trimCommit)
  const artifacts = mergeBy(before?.artifacts ?? [], parts.artifacts.filter(one => one.lastAt >= floor), one => one.id, (a, b) => b.lastAt - a.lastAt)
    .slice(0, SNAPSHOT_CAPS.artifacts)
    .map(trimArtifact)
  // Git not read yet: what the record said of it stands.
  const hasGit = parts.git.updatedAt > 0
  const counted = summarizeSources(parts.sources.filter(one => one.lastAt >= floor))
  const first = Math.min(...prompts.map(one => one.at), ...commands.map(one => one.startedAt))
  const began = Math.max(floor, parts.startedAt > 0 ? Math.min(parts.startedAt, first) : first)
  const startedAt = before === undefined ? began : Math.min(before.startedAt, began)
  const lastAt = latest(
    [
      ...prompts.map(one => one.run?.endedAt ?? one.at),
      ...commands.map(one => one.endedAt ?? one.startedAt),
      ...agents.map(one => one.endedAt ?? one.lastActivityAt),
      ...touched.map(one => one.lastAt),
      ...artifacts.map(one => one.lastAt),
    ],
    startedAt,
  )
  return {
    v: SNAPSHOT_VERSION,
    id: parts.id,
    project: parts.project,
    root: hasGit ? parts.git.root : (before?.root ?? ''),
    branch: hasGit ? parts.git.branch : (before?.branch ?? ''),
    head: hasGit ? parts.git.head : (before?.head ?? ''),
    startedAt,
    lastAt,
    title: prompts[0]?.summary ?? '',
    prompts,
    commands,
    agents,
    touched,
    worktree: hasGit ? parts.git.worktree.slice(0, SNAPSHOT_CAPS.worktree).map(trimChange) : (before?.worktree ?? []),
    commits,
    artifacts,
    usage: parts.usage.updatedAt > 0 || before === undefined ? trimUsage(parts.usage) : before.usage,
    spend: parts.spend.requests > 0 || before === undefined ? parts.spend : before.spend,
    sources: counted.urls + counted.searches > 0 || before === undefined ? { urls: counted.urls, domains: counted.domains, searches: counted.searches } : before.sources,
    models: parts.models.length > 0 || before === undefined ? parts.models.slice(0, SNAPSHOT_CAPS.models) : before.models,
  }
}

/** Fields whose 0 says something their absence would not: kept when a record is packed. */
const KEPT_ZEROS: ReadonlySet<string> = new Set(['exitCode', 'costUsd', 'contextPct', 'contextTokens', 'startPct', 'lastPct', 'agents'])

/** A value reading puts back when it is absent: 0, `false`, an empty text or an empty list. */
const isBlank = (value: unknown): boolean => value === 0 || value === false || value === '' || (Array.isArray(value) && value.length === 0)

/** A record as stored: JSON with its blank fields left out (a list's items are all kept), which reading puts back. */
export const packSnapshot = (snapshot: SessionSnapshot): string =>
  JSON.stringify(snapshot, (key: string, value: unknown): unknown =>
    key !== '' && !/^\d+$/.test(key) && !KEPT_ZEROS.has(key) && isBlank(value) ? undefined : value,
  )

/** Keeps the newest half of a list, down to `least`; undefined when it is that short already. */
const halve = <T>(list: readonly T[], least: number, isNewestFirst = false): T[] | undefined => {
  if (list.length <= least) {
    return undefined
  }
  const kept = Math.max(least, Math.ceil(list.length / 2))
  return isNewestFirst ? list.slice(0, kept) : list.slice(-kept)
}

/** One step of fitting a record into its budget: a smaller record, or undefined when this step can take no more. */
type FitStep = (snapshot: SessionSnapshot) => SessionSnapshot | undefined

/** A call as a record keeps it when room is short: what its row shows, without its flow. */
const leanCommand = (record: CommandRecord): CommandRecord => ({
  ...record,
  title: clip(record.title, 160),
  description: cut(record.description, 80),
  summary: clip(record.summary, 80),
  preview: clip(record.preview, 80),
  filePath: cut(record.filePath, 200),
  flow: undefined,
})

const leanAgent = (record: AgentRecord): AgentRecord => ({
  ...record,
  label: clip(record.label, 60),
  description: cut(record.description, 120),
  brief: cut(record.brief, 120),
  lastAnswer: undefined,
  phases: undefined,
  runs: record.runs?.slice(-2),
})

const leanPrompt = (prompt: PromptRecord): PromptRecord => ({
  ...prompt,
  text: clip(prompt.text, 160),
  summary: clip(prompt.summary, 80),
  run: prompt.run === undefined ? undefined : { ...prompt.run, agents: prompt.run.agents?.slice(-5), windows: prompt.run.windows?.slice(0, 2) },
})

const FIT_STEPS: readonly FitStep[] = [
  // The oldest calls first: the rows a record holds most of.
  snapshot => {
    const commands = halve(snapshot.commands, 20)
    return commands === undefined ? undefined : { ...snapshot, commands }
  },
  snapshot => {
    const touched = halve(snapshot.touched, 40)
    const worktree = halve(snapshot.worktree, 40, true)
    return touched === undefined && worktree === undefined ? undefined : { ...snapshot, touched: touched ?? snapshot.touched, worktree: worktree ?? snapshot.worktree }
  },
  snapshot => {
    const agents = halve(snapshot.agents, 10)
    return agents === undefined ? undefined : { ...snapshot, agents }
  },
  snapshot => ({
    ...snapshot,
    commits: (halve(snapshot.commits, 10, true) ?? snapshot.commits).map(commit => ({ ...commit, body: clip(commit.body, 300), files: commit.files.slice(0, 20) })),
  }),
  snapshot => ({ ...snapshot, prompts: (halve(snapshot.prompts, 20) ?? snapshot.prompts).map(prompt => ({ ...prompt, text: clip(prompt.text, 280) })) }),
  snapshot => {
    const artifacts = halve(snapshot.artifacts, 10, true)
    return artifacts === undefined ? undefined : { ...snapshot, artifacts }
  },
  // Still over: every list lean, what the rows show and little more.
  snapshot => ({
    ...snapshot,
    commands: snapshot.commands.map(leanCommand),
    agents: snapshot.agents.map(leanAgent),
    prompts: snapshot.prompts.map(leanPrompt),
    touched: halve(snapshot.touched, 20) ?? snapshot.touched,
    worktree: halve(snapshot.worktree, 20, true) ?? snapshot.worktree,
    commits: (halve(snapshot.commits, 5, true) ?? snapshot.commits).map(commit => ({ ...commit, subject: clip(commit.subject, 120), body: clip(commit.body, 120), files: commit.files.slice(0, 10) })),
    artifacts: snapshot.artifacts.map(one => ({ ...one, title: clip(one.title, 80), caption: undefined })),
  }),
  // A last resort for very long paths: fewer of everything, down to five.
  snapshot => ({
    ...snapshot,
    commands: halve(snapshot.commands, 5) ?? snapshot.commands,
    prompts: halve(snapshot.prompts, 5) ?? snapshot.prompts,
    touched: halve(snapshot.touched, 5) ?? snapshot.touched,
    worktree: halve(snapshot.worktree, 5, true) ?? snapshot.worktree,
    agents: halve(snapshot.agents, 5) ?? snapshot.agents,
    commits: halve(snapshot.commits, 5, true) ?? snapshot.commits,
    artifacts: halve(snapshot.artifacts, 5, true) ?? snapshot.artifacts,
  }),
]

/**
 * A record that fits `maxChars` of packed JSON, and that JSON: its oldest
 * calls go first, then files, agents, commits, prompts' words and artifacts,
 * each down to a floor; then every list lean, then fewer of everything. A
 * step is taken while the record is over and it still makes the record
 * smaller; one still over after them all is kept as it is.
 */
export const fitSnapshot = (snapshot: SessionSnapshot, maxChars: number): { snapshot: SessionSnapshot; json: string } => {
  let current = snapshot
  let json = packSnapshot(current)
  for (const step of FIT_STEPS) {
    while (json.length > maxChars) {
      const smaller = step(current)
      const packed = smaller === undefined ? undefined : packSnapshot(smaller)
      if (smaller === undefined || packed === undefined || packed.length >= json.length) {
        break
      }
      current = smaller
      json = packed
    }
  }
  return { snapshot: current, json }
}

// ------------------------------------------------------------------------- //
// Reading a record back: validated, what does not parse dropped
// ------------------------------------------------------------------------- //

type Json = Readonly<Record<string, unknown>>

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

const ID_CHARS = 200
const PATH_CHARS = 2_000

/** A finite number, else 0: a packed record leaves its zeros out. */
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const optNum = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const str = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '')
const optStr = (value: unknown, max: number): string | undefined => (typeof value === 'string' && value !== '' ? value.slice(0, max) : undefined)
const idOf = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' && value.length <= ID_CHARS ? value : undefined)
const flag = (value: unknown): boolean => value === true
const optFlag = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)
const oneOf = <T extends string>(value: unknown, options: readonly T[]): T | undefined => options.find(option => option === value)

/** A list's items that parse, at most `max` of them; none when it is no list. */
const listOf = <T>(value: unknown, read: (item: unknown) => T | undefined, max: number): T[] => {
  if (!Array.isArray(value)) {
    return []
  }
  const parsed: T[] = []
  for (const item of value) {
    const one = read(item)
    if (one !== undefined) {
      parsed.push(one)
    }
  }
  return parsed.slice(0, max)
}

const strings = (value: unknown, max: number, chars: number): string[] => listOf(value, item => (typeof item === 'string' ? item.slice(0, chars) : undefined), max)

const fieldsOf = (value: unknown): Json => (isRecord(value) ? value : {})

const STATUSES: readonly CommandStatus[] = ['running', 'ok', 'error', 'denied', 'background']
const ACCESSES: readonly Access[] = ['read', 'write', 'execute']
const ACTORS: readonly CommandActor['kind'][] = ['claude', 'agent', 'plugin']
const TURN_ENDS: readonly TurnEnd[] = ['answer', 'aborted', 'refusal', 'error']
const AGENT_KINDS: readonly AgentKind[] = ['subagent', 'teammate', 'workflow', 'workflow-agent', 'shell']
const AGENT_STATUSES: readonly AgentRunStatus[] = ['pending', 'running', 'waiting', 'idle', 'completed', 'failed', 'killed']
const PHASES: readonly AgentPhase['kind'][] = ['request', 'tool', 'between', 'answered', 'ended']
const ACTIVITIES: readonly FileActivity[] = ['created', 'modified', 'deleted', 'read']
const FILE_STATUSES: readonly FileStatus[] = ['A', 'M', 'D', 'R', 'C', 'T', 'U']
const ARTIFACT_KINDS: readonly ArtifactRecord['kind'][] = ['page', 'file']
/** A commit id git could have made: what alone reaches a git command line. */
const SHA = /^[0-9a-f]{7,64}$/i
/** A link a page may draw: the web's, nothing else. */
const WEB_URL = /^https?:\/\//i

const readTotals = (value: unknown): Totals | undefined =>
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
    : undefined

const readMetrics = (value: unknown): CommandMetrics => {
  const fields = fieldsOf(value)
  return { ...emptyMetrics(), ...readTotals(fields), peakMem: num(fields.peakMem), isSampled: flag(fields.isSampled), isEstimate: flag(fields.isEstimate) }
}

const readPart = (value: unknown): CostPart => {
  const fields = fieldsOf(value)
  return { tokens: num(fields.tokens), usd: num(fields.usd) }
}

/** A cost by the kind of token; undefined where none was kept (a record from before it was). */
const readParts = (value: unknown): CostBreakdown | undefined =>
  isRecord(value)
    ? { input: readPart(value.input), cacheRead: readPart(value.cacheRead), cacheWrite5m: readPart(value.cacheWrite5m), cacheWrite1h: readPart(value.cacheWrite1h), output: readPart(value.output) }
    : undefined

const readSpend = (value: unknown): CommandSpend | undefined =>
  isRecord(value) && typeof value.model === 'string'
    ? {
        usd: num(value.usd),
        tokens: num(value.tokens),
        // Packing leaves out a 0: either kind there says the record split them.
        ...(typeof value.input === 'number' || typeof value.output === 'number' ? { input: num(value.input), cached: num(value.cached), output: num(value.output) } : {}),
        ...(isRecord(value.parts) ? { parts: readParts(value.parts) } : {}),
        requestUsd: num(value.requestUsd),
        requestTokens: num(value.requestTokens),
        shares: num(value.shares),
        model: value.model.slice(0, 120),
        blockKey: optStr(value.blockKey, 80),
      }
    : undefined

const readLink = (value: unknown): FlowLink | undefined => {
  const fields = fieldsOf(value)
  const id = idOf(fields.id)
  return id === undefined ? undefined : { id, tool: str(fields.tool, 120), summary: str(fields.summary, 200), uses: strings(fields.uses, 4, 80) }
}

const readFlow = (value: unknown): CommandFlow | undefined =>
  isRecord(value)
    ? {
        after: listOf(value.after, readLink, 6),
        readAt: optNum(value.readAt),
        said: optStr(value.said, 400),
        asked: strings(value.asked, 12, 80),
        isLast: optFlag(value.isLast),
        next: listOf(value.next, readLink, 6),
      }
    : undefined

const readCommand = (value: unknown): CommandRecord | undefined => {
  const fields = fieldsOf(value)
  const id = idOf(fields.id)
  const tool = optStr(fields.tool, 200)
  const status = oneOf(fields.status, STATUSES)
  const access = oneOf(fields.access, ACCESSES)
  const startedAt = optNum(fields.startedAt)
  if (id === undefined || tool === undefined || status === undefined || access === undefined || startedAt === undefined) {
    return undefined
  }
  const actor = fieldsOf(fields.actor)
  return {
    id,
    tool,
    title: str(fields.title, 4_000),
    description: optStr(fields.description, 400),
    startedAt,
    endedAt: optNum(fields.endedAt),
    status,
    access,
    exitCode: optNum(fields.exitCode),
    agentId: optStr(fields.agentId, ID_CHARS),
    isBackground: flag(fields.isBackground),
    groups: [],
    reapedCpuS: num(fields.reapedCpuS),
    reapedEnergyJ: num(fields.reapedEnergyJ),
    metrics: readMetrics(fields.metrics),
    outputChars: num(fields.outputChars),
    outputLines: num(fields.outputLines),
    preview: str(fields.preview, 400),
    filePath: optStr(fields.filePath, PATH_CHARS),
    model: optStr(fields.model, 120),
    effort: optStr(fields.effort, 40),
    summary: str(fields.summary, 400),
    spend: readSpend(fields.spend),
    flow: readFlow(fields.flow),
    promptId: optStr(fields.promptId, ID_CHARS),
    actor: { kind: oneOf(actor.kind, ACTORS) ?? 'claude', name: str(actor.name, 120) },
  }
}

const readWindow = (value: unknown): WindowUse | undefined => {
  const fields = fieldsOf(value)
  const kind = optStr(fields.kind, 40)
  return kind === undefined
    ? undefined
    : {
        kind,
        firstPct: num(fields.firstPct),
        startPct: num(fields.startPct),
        lastPct: num(fields.lastPct),
        resetsAt: optStr(fields.resetsAt, 80),
        earlierPoints: num(fields.earlierPoints),
        resets: num(fields.resets),
      }
}

const readRun = (value: unknown): PromptRun | undefined => {
  if (!isRecord(value)) {
    return undefined
  }
  const tokens = fieldsOf(value.tokens)
  return {
    turns: num(value.turns),
    workMs: num(value.workMs),
    endedAt: optNum(value.endedAt),
    endReason: oneOf(value.endReason, TURN_ENDS),
    requests: num(value.requests),
    tokens: { input: num(tokens.input), output: num(tokens.output), cacheRead: num(tokens.cacheRead), cacheWrite: num(tokens.cacheWrite) },
    usd: num(value.usd),
    ...(isRecord(value.parts) ? { parts: readParts(value.parts) } : {}),
    model: optStr(value.model, 120),
    startTotals: readTotals(value.startTotals),
    endTotals: readTotals(value.endTotals),
    contextFirst: optNum(value.contextFirst),
    contextLast: optNum(value.contextLast),
    contextWindow: optNum(value.contextWindow),
    windows: listOf(value.windows, readWindow, 4),
    agents: Array.isArray(value.agents) ? strings(value.agents, 50, ID_CHARS) : undefined,
  }
}

const readPrompt = (value: unknown): PromptRecord | undefined => {
  const fields = fieldsOf(value)
  const id = idOf(fields.id)
  const at = optNum(fields.at)
  if (id === undefined || at === undefined) {
    return undefined
  }
  const text = str(fields.text, 4_000)
  return {
    id,
    text,
    summary: str(fields.summary, 200) || quickSummary(text),
    isModelSummary: flag(fields.isModelSummary),
    at,
    origin: str(fields.origin, 40) || 'composer',
    taskId: optStr(fields.taskId, ID_CHARS),
    requestId: optStr(fields.requestId, ID_CHARS),
    run: readRun(fields.run),
    deliveredAt: optNum(fields.deliveredAt),
    deliveredInto: optStr(fields.deliveredInto, ID_CHARS),
  }
}

const readAgentRun = (value: unknown): AgentRun | undefined => {
  const fields = fieldsOf(value)
  const startedAt = optNum(fields.startedAt)
  return startedAt === undefined ? undefined : { startedAt, endedAt: optNum(fields.endedAt), requests: num(fields.requests), reason: optStr(fields.reason, 40) }
}

const readPhase = (value: unknown): AgentPhase | undefined => {
  const fields = fieldsOf(value)
  const kind = oneOf(fields.kind, PHASES)
  return kind === undefined ? undefined : { kind, since: num(fields.since), detail: str(fields.detail, 200) }
}

const readAgent = (value: unknown): AgentRecord | undefined => {
  const fields = fieldsOf(value)
  const id = idOf(fields.id)
  const kind = oneOf(fields.kind, AGENT_KINDS)
  const status = oneOf(fields.status, AGENT_STATUSES)
  const startedAt = optNum(fields.startedAt)
  if (id === undefined || kind === undefined || status === undefined || startedAt === undefined) {
    return undefined
  }
  return {
    id,
    kind,
    label: str(fields.label, 200),
    type: str(fields.type, 100),
    description: optStr(fields.description, 600),
    status,
    parentId: optStr(fields.parentId, ID_CHARS),
    name: optStr(fields.name, 200),
    teammateId: optStr(fields.teammateId, ID_CHARS),
    toolUseId: optStr(fields.toolUseId, ID_CHARS),
    runId: optStr(fields.runId, ID_CHARS),
    taskId: optStr(fields.taskId, ID_CHARS),
    phases: Array.isArray(fields.phases) ? strings(fields.phases, 20, 100) : undefined,
    isBackground: flag(fields.isBackground),
    wasListed: flag(fields.wasListed),
    model: optStr(fields.model, 120),
    effort: optStr(fields.effort, 40),
    requests: num(fields.requests),
    turns: num(fields.turns),
    toolCalls: num(fields.toolCalls),
    tokensIn: num(fields.tokensIn),
    tokensOut: num(fields.tokensOut),
    contextTokens: num(fields.contextTokens),
    activeMs: num(fields.activeMs),
    startedAt,
    endedAt: optNum(fields.endedAt),
    lastActivityAt: optNum(fields.lastActivityAt) ?? startedAt,
    brief: optStr(fields.brief, 600),
    runs: listOf(fields.runs, readAgentRun, 20),
    usd: optNum(fields.usd),
    ...(isRecord(fields.parts) ? { parts: readParts(fields.parts) } : {}),
    blockUsd: optNum(fields.blockUsd),
    blockKey: optStr(fields.blockKey, 80),
    phase: readPhase(fields.phase),
    lastRequestAt: optNum(fields.lastRequestAt),
    lastAnswer: optStr(fields.lastAnswer, 400),
    stopReason: optStr(fields.stopReason, 40),
    isEndAssumed: optFlag(fields.isEndAssumed),
  }
}

const readTouched = (value: unknown): TouchedFile | undefined => {
  const fields = fieldsOf(value)
  const path = optStr(fields.path, PATH_CHARS)
  const activity = oneOf(fields.activity, ACTIVITIES)
  if (path === undefined || activity === undefined) {
    return undefined
  }
  const lastAt = num(fields.lastAt)
  return {
    path,
    activity,
    reads: num(fields.reads),
    edits: num(fields.edits),
    firstAt: optNum(fields.firstAt) ?? lastAt,
    lastAt,
    editedAt: optNum(fields.editedAt),
    tools: strings(fields.tools, 12, 80),
  }
}

const readChange = (value: unknown): FileChange | undefined => {
  const fields = fieldsOf(value)
  const path = optStr(fields.path, PATH_CHARS)
  const status = oneOf(fields.status, FILE_STATUSES)
  if (path === undefined || status === undefined) {
    return undefined
  }
  return {
    path,
    oldPath: optStr(fields.oldPath, PATH_CHARS),
    status,
    added: num(fields.added),
    removed: num(fields.removed),
    isBinary: flag(fields.isBinary),
    isUntracked: flag(fields.isUntracked),
  }
}

const readCommit = (value: unknown): CommitInfo | undefined => {
  const fields = fieldsOf(value)
  const sha = typeof fields.sha === 'string' && SHA.test(fields.sha) ? fields.sha : undefined
  if (sha === undefined) {
    return undefined
  }
  return {
    sha,
    short: str(fields.short, 16) || sha.slice(0, 7),
    subject: str(fields.subject, 400),
    body: str(fields.body, 4_000),
    author: str(fields.author, 200),
    email: str(fields.email, 200),
    date: num(fields.date),
    parents: strings(fields.parents, 4, 64).filter(parent => SHA.test(parent)),
    refs: '',
    files: listOf(fields.files, readChange, 200),
    isSession: true,
  }
}

const readArtifact = (value: unknown): ArtifactRecord | undefined => {
  const fields = fieldsOf(value)
  const id = optStr(fields.id, PATH_CHARS)
  const kind = oneOf(fields.kind, ARTIFACT_KINDS)
  if (id === undefined || kind === undefined) {
    return undefined
  }
  const url = optStr(fields.url, PATH_CHARS)
  const lastAt = num(fields.lastAt)
  return {
    id,
    kind,
    title: str(fields.title, 200),
    url: url !== undefined && WEB_URL.test(url) ? url : undefined,
    path: optStr(fields.path, PATH_CHARS),
    version: optStr(fields.version, 40),
    count: Math.max(1, num(fields.count)),
    firstAt: optNum(fields.firstAt) ?? lastAt,
    lastAt,
    caption: optStr(fields.caption, 400),
  }
}

const readLimit = (value: unknown): RateLimitView | undefined => {
  const fields = fieldsOf(value)
  const kind = optStr(fields.kind, 40)
  return kind === undefined ? undefined : { kind, percentUsed: num(fields.percentUsed), resetsAt: optStr(fields.resetsAt, 80) }
}

const readUsage = (value: unknown): UsageView => {
  const fields = fieldsOf(value)
  return {
    costUsd: optNum(fields.costUsd),
    contextPct: optNum(fields.contextPct),
    contextTokens: optNum(fields.contextTokens),
    contextWindow: num(fields.contextWindow),
    rateLimits: listOf(fields.rateLimits, readLimit, 6),
    model: str(fields.model, 120),
    turns: num(fields.turns),
    sessionStartedAt: num(fields.sessionStartedAt),
    updatedAt: num(fields.updatedAt),
  }
}

const readBlock = (value: unknown): SpendBlock | null => {
  const fields = fieldsOf(value)
  const key = optStr(fields.key, 80)
  return key === undefined
    ? null
    : { key, usd: num(fields.usd), tokens: num(fields.tokens), requests: num(fields.requests), startPct: optNum(fields.startPct), lastPct: optNum(fields.lastPct) }
}

const readSpendView = (value: unknown): SpendView => {
  const fields = fieldsOf(value)
  return {
    totalUsd: num(fields.totalUsd),
    totalTokens: num(fields.totalTokens),
    requests: num(fields.requests),
    block: readBlock(fields.block),
    pctPerUsd: optNum(fields.pctPerUsd),
  }
}

const readModel = (value: unknown): ModelUse | undefined => {
  const fields = fieldsOf(value)
  const model = optStr(fields.model, 120)
  return model === undefined
    ? undefined
    : {
        model,
        effort: str(fields.effort, 40) || 'default',
        turns: num(fields.turns),
        prompts: num(fields.prompts),
        requests: num(fields.requests),
        toolCalls: num(fields.toolCalls),
        agentRequests: num(fields.agentRequests),
      }
}

const readSources = (value: unknown): SessionSources => {
  const fields = fieldsOf(value)
  return { urls: num(fields.urls), domains: num(fields.domains), searches: num(fields.searches) }
}

/** A session's record as the store holds it (packed or not), validated: undefined when it is none, or of another layout. */
export const readSnapshot = (value: unknown): SessionSnapshot | undefined => {
  const fields = fieldsOf(value)
  const id = idOf(fields.id)
  const startedAt = optNum(fields.startedAt)
  if (fields.v !== SNAPSHOT_VERSION || id === undefined || startedAt === undefined) {
    return undefined
  }
  return {
    v: SNAPSHOT_VERSION,
    id,
    project: str(fields.project, PATH_CHARS),
    root: str(fields.root, PATH_CHARS),
    branch: str(fields.branch, 200),
    head: str(fields.head, 64),
    startedAt,
    lastAt: Math.max(startedAt, num(fields.lastAt)),
    title: str(fields.title, 200),
    prompts: listOf(fields.prompts, readPrompt, SNAPSHOT_CAPS.prompts),
    commands: listOf(fields.commands, readCommand, SNAPSHOT_CAPS.commands),
    agents: listOf(fields.agents, readAgent, SNAPSHOT_CAPS.agents),
    touched: listOf(fields.touched, readTouched, SNAPSHOT_CAPS.touched),
    worktree: listOf(fields.worktree, readChange, SNAPSHOT_CAPS.worktree),
    commits: listOf(fields.commits, readCommit, SNAPSHOT_CAPS.commits),
    artifacts: listOf(fields.artifacts, readArtifact, SNAPSHOT_CAPS.artifacts),
    usage: readUsage(fields.usage),
    spend: readSpendView(fields.spend),
    sources: readSources(fields.sources),
    models: listOf(fields.models, readModel, SNAPSHOT_CAPS.models),
  }
}

// ------------------------------------------------------------------------- //
// A project's list of past sessions, and pruning
// ------------------------------------------------------------------------- //

/** Newest first: by start, then by last activity. */
const newestFirst = (a: SessionEntry, b: SessionEntry): number => b.startedAt - a.startedAt || b.lastAt - a.lastAt || a.id.localeCompare(b.id)

/** A record's line in its project's list; `bytes` is its packed JSON's length. */
export const entryOf = (snapshot: SessionSnapshot, bytes: number): SessionEntry => ({
  id: snapshot.id,
  startedAt: snapshot.startedAt,
  lastAt: snapshot.lastAt,
  title: snapshot.title,
  usd: snapshot.usage.costUsd ?? (snapshot.spend.totalUsd > 0 ? snapshot.spend.totalUsd : undefined),
  prompts: snapshot.prompts.length,
  commands: snapshot.commands.length,
  bytes,
})

const readEntry = (value: unknown): SessionEntry | undefined => {
  const fields = fieldsOf(value)
  const id = idOf(fields.id)
  const startedAt = optNum(fields.startedAt)
  if (id === undefined || startedAt === undefined) {
    return undefined
  }
  return {
    id,
    startedAt,
    lastAt: Math.max(startedAt, num(fields.lastAt)),
    title: str(fields.title, 200),
    usd: optNum(fields.usd),
    prompts: num(fields.prompts),
    commands: num(fields.commands),
    bytes: num(fields.bytes),
  }
}

/** A project's list as the store holds it, validated: each session once (its first line), the newest first. */
export const readEntries = (value: unknown): SessionEntry[] => {
  const byId = new Map<string, SessionEntry>()
  for (const entry of listOf(value, readEntry, MAX_SESSIONS * 4)) {
    if (!byId.has(entry.id)) {
      byId.set(entry.id, entry)
    }
  }
  return [...byId.values()].sort(newestFirst)
}

/**
 * A project's list with `entry` added or replaced, the newest `max` kept (the
 * entry itself always, it is the session saving), and the ids dropped.
 */
export const upsertEntry = (entries: readonly SessionEntry[], entry: SessionEntry, max: number): { kept: SessionEntry[]; dropped: string[] } => {
  const others = entries.filter(one => one.id !== entry.id).sort(newestFirst)
  const room = Math.max(0, max - 1)
  return { kept: [...others.slice(0, room), entry].sort(newestFirst), dropped: others.slice(room).map(one => one.id) }
}

/** One project's list of past sessions, by its project. */
export type ProjectIndex = { project: string; entries: readonly SessionEntry[] }

/**
 * The sessions to drop so every project's records fit `maxChars`: the least
 * recently active first, whatever their project; never `keepId`, the session
 * that is running.
 */
export const planPrune = (indexes: readonly ProjectIndex[], keepId: string, maxChars: number): { project: string; id: string }[] => {
  const all = indexes.flatMap(index => index.entries.map(entry => ({ project: index.project, entry })))
  let total = all.reduce((sum, one) => sum + one.entry.bytes, 0)
  const dropped: { project: string; id: string }[] = []
  for (const one of [...all].sort((a, b) => a.entry.lastAt - b.entry.lastAt || a.entry.id.localeCompare(b.entry.id))) {
    if (total <= maxChars) {
      break
    }
    if (one.entry.id !== keepId) {
      dropped.push({ project: one.project, id: one.entry.id })
      total -= one.entry.bytes
    }
  }
  return dropped
}

/** A record no project's list names, as read at a session's start: its key, the record (undefined when it does not parse) and its size. */
export type Orphan = { key: string; snapshot: SessionSnapshot | undefined; bytes: number }

/** What mending the store at a session's start comes to: every project's list as it should be, the projects whose list changed, and the keys to delete. */
export type HistoryPlan = { lists: Map<string, SessionEntry[]>; changed: Set<string>; deletes: string[] }

/**
 * Mends every project's list at a session's start. A line whose record is
 * gone is dropped; a record no list names (a save that lost a race to another
 * session's, or stopped between its two writes) is listed again under its
 * project, or deleted when it does not parse. Then each project keeps its
 * newest MAX_SESSIONS, and every project's records together HISTORY_CHARS,
 * the least recently active dropped first; never `liveId`, the session
 * starting.
 */
export const planHistory = (lists: ReadonlyMap<string, readonly SessionEntry[]>, keys: readonly string[], orphans: readonly Orphan[], liveId: string): HistoryPlan => {
  const present = new Set(keys)
  const next = new Map<string, SessionEntry[]>()
  const changed = new Set<string>()
  const deletes: string[] = []
  for (const [project, entries] of lists) {
    const kept = entries.filter(entry => present.has(snapshotKey(entry.id)))
    next.set(project, kept)
    if (kept.length !== entries.length) {
      changed.add(project)
    }
  }
  for (const orphan of orphans) {
    const snapshot = orphan.snapshot
    if (snapshot === undefined || snapshot.project === '' || snapshotKey(snapshot.id) !== orphan.key) {
      deletes.push(orphan.key)
      continue
    }
    const entries = (next.get(snapshot.project) ?? []).filter(one => one.id !== snapshot.id)
    next.set(snapshot.project, [...entries, entryOf(snapshot, orphan.bytes)].sort(newestFirst))
    changed.add(snapshot.project)
  }
  const drop = (project: string, id: string): void => {
    next.set(project, (next.get(project) ?? []).filter(one => one.id !== id))
    changed.add(project)
    deletes.push(snapshotKey(id))
  }
  for (const [project, entries] of [...next]) {
    const live = entries.find(one => one.id === liveId)
    const kept = live === undefined ? entries.slice(0, MAX_SESSIONS) : upsertEntry(entries, live, MAX_SESSIONS).kept
    for (const one of entries.filter(entry => !kept.includes(entry))) {
      drop(project, one.id)
    }
  }
  for (const one of planPrune([...next].map(([project, entries]) => ({ project, entries })), liveId, HISTORY_CHARS)) {
    drop(one.project, one.id)
  }
  return { lists: next, changed, deletes }
}

// ------------------------------------------------------------------------- //
// Showing a record: settled, as git saw it, labelled
// ------------------------------------------------------------------------- //

/**
 * A record as a past session is shown: nothing in it runs any more. A call
 * still running when it was last saved shows as stopped (⊘) and a background
 * one as done; an agent still working as stopped; a prompt whose turn never
 * ended as interrupted.
 */
export const settleSnapshot = (snapshot: SessionSnapshot): SessionSnapshot => ({
  ...snapshot,
  commands: snapshot.commands.map(
    (record): CommandRecord =>
      record.status === 'running' || record.status === 'background'
        ? { ...record, status: record.status === 'running' ? 'denied' : 'ok', endedAt: record.endedAt ?? snapshot.lastAt }
        : record,
  ),
  agents: snapshot.agents.map(
    (record): AgentRecord =>
      isLive(record.status) ? { ...record, status: 'killed', endedAt: record.endedAt ?? Math.max(record.startedAt, record.lastActivityAt), phase: undefined } : record,
  ),
  prompts: snapshot.prompts.map(
    (prompt): PromptRecord =>
      prompt.run !== undefined && prompt.run.endedAt === undefined
        ? { ...prompt, run: { ...prompt.run, endedAt: Math.max(prompt.at, snapshot.lastAt), endReason: prompt.run.endReason ?? 'aborted' } }
        : prompt,
  ),
})

/** What the Commits and Files tabs draw for a past session: its commits and what it left uncommitted, as git saw them then. */
export const pastGit = (snapshot: SessionSnapshot): GitView => ({
  isRepo: true,
  root: snapshot.root,
  branch: snapshot.branch,
  head: snapshot.head,
  ahead: 0,
  behind: 0,
  worktree: snapshot.worktree,
  commits: snapshot.commits,
  scope: 'session',
  updatedAt: snapshot.lastAt,
})

/**
 * What an opened call of a past session shows for its output: the output its
 * transcript kept, where one was read; else the first line, all a record keeps.
 */
export const pastOutput = (record: CommandRecord, outputs?: Readonly<Record<string, string>>): string => {
  const kept = outputs?.[record.id]
  if (kept !== undefined) {
    return kept
  }
  return record.outputChars === 0 ? '' : `${record.preview !== '' ? record.preview : '…'}\n\n(A past session keeps only the first line of a call's output.)`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** When a session began, as its label says it: `Oct 14, 4:52 PM`, in local time. */
export const sessionDate = (ms: number): string => {
  const date = new Date(ms)
  const hours = date.getHours()
  const hour12 = hours % 12 === 0 ? 12 : hours % 12
  return `${MONTHS[date.getMonth()] ?? ''} ${date.getDate()}, ${hour12}:${String(date.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`
}

/** A past session as the picker lists it: `Oct 14, 4:52 PM · Fix the flaky test · ≈ $1.23`. */
export const sessionLabel = (entry: SessionEntry): string =>
  [sessionDate(entry.startedAt), oneLine(entry.title === '' ? 'No prompts' : entry.title, 60), ...(entry.usd !== undefined && entry.usd > 0 ? [`≈ ${fmtUsd(entry.usd)}`] : [])].join(' · ')

/** `git cat-file -e <sha>^{commit}`: exits 0 when the repository still has the commit. */
export const commitExistsArgv = (sha: string): string[] => ['git', '-c', 'core.quotePath=false', '--no-pager', 'cat-file', '-e', `${sha}^{commit}`]

/** Whether a text is a commit id git could have made: only those reach a git command line. */
export const isSha = (text: string): boolean => SHA.test(text)
