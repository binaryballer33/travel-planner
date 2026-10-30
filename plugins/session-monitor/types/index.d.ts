// The session-monitor mod's state contract: every value the pane draws from.

export type MonitorTab = 'overview' | 'commands' | 'prompts' | 'compute' | 'files' | 'explorer' | 'commits' | 'sources' | 'resources' | 'agents' | 'ports' | 'cache'

/** What a tool call does to the machine: reads state, writes files, or runs a program. */
export type Access = 'read' | 'write' | 'execute'

/** Cumulative counters. Seconds of CPU, joules, bytes. */
export type Totals = {
  cpuS: number
  energyJ: number
  /** Energy estimated from CPU time the kernel could not attribute (short-lived processes). */
  energyEstJ: number
  netIn: number
  netOut: number
  diskR: number
  diskW: number
  /** Seconds during which bytes were moving over the network. */
  netActiveS: number
}

/** Rates over the last sampler interval. CPU in percent of one core. */
export type Rates = {
  cpuPct: number
  watts: number
  netInBps: number
  netOutBps: number
  diskRBps: number
  diskWBps: number
}

export type GroupKind = 'claude' | 'bash' | 'service' | 'helper' | 'monitor'

/** One process group as the sampler reports it: a top-level child of Claude and its subtree. */
export type GroupSample = Rates & {
  id: string
  kind: GroupKind
  label: string
  pid: number
  procs: number
  startedAt: number
  mem: number
  peakMem: number
  tot: Totals
  cmd?: string
  endedAt?: number
}

export type HistoryPoint = {
  t: number
  netInBps: number
  netOutBps: number
  cpuPct: number
  watts: number
  mem: number
  diskRBps: number
  diskWBps: number
}

/**
 * One step of the whole session's trend: the ticks of a span folded into
 * their means and peaks, and the running totals where the span ended.
 */
export type TrendPoint = {
  /** The span's start, ms since the epoch. */
  t: number
  /** How many ticks it folds. */
  ticks: number
  cpuPct: number
  cpuPeak: number
  watts: number
  mem: number
  memPeak: number
  netInBps: number
  netOutBps: number
  diskRBps: number
  diskWBps: number
  /** The session's totals at the span's last tick: energy (measured and estimated), CPU seconds, bytes. */
  energyJ: number
  cpuS: number
  netIn: number
  netOut: number
}

export type SamplerStatus = 'starting' | 'running' | 'paused' | 'error' | 'unsupported'

/**
 * The whole Mac as the sampler last measured it. A figure it has not
 * measured (yet, or at all: an older sampler) is absent, never 0.
 */
export type SystemMetrics = {
  /** The network over the Mac's Wi-Fi, Ethernet and cellular links: rates over the last second, bytes since the sampler started. */
  netInBps: number
  netOutBps: number
  netIn: number
  netOut: number
  /** CPU in use across every core, in percent of the whole machine (0–100); it takes two readings, a second apart. */
  cpuPct?: number
  /** Memory in use as Activity Monitor's Memory Used counts it (app, wired and compressed), bytes. */
  memUsed?: number
  /** The Mac's RAM, bytes. */
  memTotal?: number
  /** How long a TCP connect to api.anthropic.com took at the latest probe (every 15 s), ms; absent while it fails. */
  latencyMs?: number
}

export type LiveMetrics = {
  status: SamplerStatus
  message?: string
  /** Last tick, ms since the epoch. */
  t: number
  startedAt: number
  session: Totals & Rates & { mem: number }
  peakMem: number
  system: SystemMetrics
  groups: GroupSample[]
  /** Ended helpers and reaped CPU no command claimed. */
  shortLived: Totals
  history: HistoryPoint[]
  /** The whole session, a step per `trendStepMs`; the step doubles as the session grows, so it stays short. */
  trend: TrendPoint[]
  trendStepMs: number
  jPerCpuS: number
}

export type CommandStatus = 'running' | 'ok' | 'error' | 'denied' | 'background'

export type CommandMetrics = Totals &
  Rates & {
    mem: number
    peakMem: number
    procs: number
    /** True once a sampler group was matched to the command. */
    isSampled: boolean
    /** True when any part is estimated (reaped CPU, energy from CPU time). */
    isEstimate: boolean
  }

export type CommandRecord = {
  id: string
  tool: string
  title: string
  description?: string
  startedAt: number
  endedAt?: number
  status: CommandStatus
  access: Access
  exitCode?: number
  agentId?: string
  isBackground: boolean
  /** The latest snapshot of each sampler group matched to this command. */
  groups: GroupSample[]
  /** CPU the Claude process reaped while this command ran, no live process explaining it. */
  reapedCpuS: number
  reapedEnergyJ: number
  metrics: CommandMetrics
  outputChars: number
  outputLines: number
  preview: string
  filePath?: string
  /** The model and effort level whose request made this call. */
  model?: string
  effort?: string
  /** What the call does, in a few plain words. */
  summary: string
  /** Its share of the model request that read its output, once that request finished. */
  spend?: CommandSpend
  /** Where it sits in its loop's flow: what led to it, and what came of its output. */
  flow?: CommandFlow
  /** The prompt whose work made the call (its task id: the turn the prompt started); absent before any prompt. */
  promptId?: string
  /** Who made the call. */
  actor: CommandActor
}

/**
 * A call's place in its loop: the calls whose outputs Claude had read when it
 * made it, when Claude read its own output and what it said, and the calls
 * Claude made next.
 */
export type CommandFlow = {
  after?: FlowLink[]
  /** When the model request that read its output finished. */
  readAt?: number
  /** What Claude wrote in that response, cut short; absent when it only called tools. */
  said?: string
  /** The tools that response asked for, in order. */
  asked?: string[]
  /** That response ended the turn: no further calls. */
  isLast?: boolean
  next?: FlowLink[]
}

/** Another call in the flow, and the bits of the earlier output the later call's input repeats. */
export type FlowLink = { id: string; tool: string; summary: string; uses: string[] }

/** Tokens of one kind and what they cost at list prices. */
export type CostPart = { tokens: number; usd: number }

/**
 * What requests cost, by the kind of token: the prompt's new part (`input`),
 * its part read from the prompt cache, its part written to it (kept 5
 * minutes, or an hour at a higher price), and what the model wrote (`output`).
 */
export type CostBreakdown = { input: CostPart; cacheRead: CostPart; cacheWrite5m: CostPart; cacheWrite1h: CostPart; output: CostPart }

/** A command's share of the model request that read its output, priced at list rates. */
export type CommandSpend = {
  usd: number
  /** Tokens of that request attributed to the command. */
  tokens: number
  /**
   * Of them, the request's prompt (`input`, of that `cached` read from the
   * prompt cache) and what it wrote (`output`); absent from a record kept
   * before they were.
   */
  input?: number
  cached?: number
  output?: number
  /** Its share's cost by the kind of token; absent from a record kept before it was. */
  parts?: CostBreakdown
  /** The whole request's price and tokens, and how many outputs it read. */
  requestUsd: number
  requestTokens: number
  shares: number
  model: string
  /** The 5-hour usage block it fell in (the limit's reset time), when the account reports one. */
  blockKey?: string
}

/** What this session's model requests cost, in total and in the current 5-hour block. */
export type SpendView = {
  totalUsd: number
  totalTokens: number
  requests: number
  block: SpendBlock | null
  /**
   * Percent of the 5-hour limit per dollar of list price, learned from a
   * window that rose at least two steps while a session spent; kept across sessions.
   */
  pctPerUsd?: number
}

/** This session's requests in the current 5-hour usage block. */
export type SpendBlock = {
  /** The block's reset time, as the account reports it. */
  key: string
  usd: number
  tokens: number
  requests: number
  /** The 5-hour limit's percent used at this session's first request in the block, and at its latest. */
  startPct?: number
  lastPct?: number
}

/** A prompt you sent in this session, and where the conversation shows it. */
export type PromptRecord = {
  id: string
  /** The prompt as it reached the model, cut to PROMPT_CHARS. */
  text: string
  /** A few words saying what it asks: the model's, or the first sentence until that comes. */
  summary: string
  isModelSummary: boolean
  at: number
  /** Where it came from: typed (`composer`), the phone or web (`bridge`), the SDK host (`sdk`). */
  origin: string
  /**
   * The task its work is filed under: the turn it started, set when that turn
   * begins; or, for one folded into a running turn, a task of its own, set
   * when that turn took it in.
   */
  taskId?: string
  /** Its message row in the conversation, as the transcript names it: what a jump scrolls to. */
  requestId?: string
  /** What its work came to once its turn began: when it ended, its requests and what the machine spent. */
  run?: PromptRun
  /** When the model was first given it: its own turn began, or a running turn's request carried it. */
  deliveredAt?: number
  /** The running turn it was folded into (typed while that turn ran), when it started no turn of its own. */
  deliveredInto?: string
}

/** How a turn ended: answered, interrupted, refused, or ended by an API error. */
export type TurnEnd = 'answer' | 'aborted' | 'refusal' | 'error'

/** Tokens a prompt's requests reported, by kind. */
export type PromptTokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

/** A prompt's work: its turns (the first, and any continuation), its requests' tokens and price, and the session's counters around it. */
export type PromptRun = {
  turns: number
  /** Wall-clock time its turns ran, summed. */
  workMs: number
  /** When its latest turn ended; absent while one runs. */
  endedAt?: number
  endReason?: TurnEnd
  /** Model requests made for it, sub-agents' included, with their tokens and list price. */
  requests: number
  tokens: PromptTokens
  usd: number
  /** That cost by the kind of token; absent from a run kept before it was. */
  parts?: CostBreakdown
  /** The model that answered its latest request. */
  model?: string
  /** The session's counters when it began, and when its latest turn ended; absent while the sampler was not running. */
  startTotals?: Totals
  endTotals?: Totals
  /**
   * The context its own loop's requests carried (input, cache read and cache
   * write tokens): at the first of them and at the latest, and the context
   * window then; absent before the first.
   */
  contextFirst?: number
  contextLast?: number
  contextWindow?: number
  /** The 5-hour and weekly rate-limit windows as the run saw them. */
  windows?: WindowUse[]
  /** The agents spawned for it: their requests and tool calls count toward it. */
  agents?: string[]
}

/**
 * A rate-limit window over a prompt's run: where it stood when the run began
 * and at the latest reading, and the points used in a window that reset while
 * the run went on.
 */
export type WindowUse = {
  /** `five_hour` or `seven_day`. */
  kind: string
  /** Its percent used when the run began. */
  firstPct: number
  /** Where the current window's count began: `firstPct`, or 0 after a reset. */
  startPct: number
  /** Its percent used at the latest reading. */
  lastPct: number
  /** When it resets, as the latest reading said. */
  resetsAt?: string
  /** Points used in the windows that reset while the run went on. */
  earlierPoints: number
  /** How many times it reset while the run went on. */
  resets: number
}

/** A prompt kept for the project across sessions, in `$.store`. */
export type StoredPrompt = {
  id: string
  text: string
  summary: string
  at: number
  sessionId: string
}

/**
 * The app macOS holds responsible for the monitor's `osascript`, which its
 * Privacy & Security lists name: in the desktop app the engine it runs
 * (“Claude Code”, its own bundle), not Claude itself.
 */
export type FindApp = {
  /** As System Settings lists it. */
  name: string
  /** Its bundle, for the list's + button. */
  path: string
}

/**
 * Whether Find in conversation may press its keys (⌘F, ⌘V, Return) in the
 * desktop app, as macOS last answered: System Events sends keystrokes only for
 * an app allowed under Privacy & Security → Accessibility.
 */
export type FindAccess = {
  isAllowed: boolean
  /** Null when it could not be told. */
  app: FindApp | null
}

/** Something the session published or handed over: an Artifact page, or files sent to you. */
export type ArtifactRecord = {
  /** The page's URL, or `file:<path>` for a sent file. */
  id: string
  kind: 'page' | 'file'
  title: string
  url?: string
  path?: string
  version?: string
  /** How many times it was published or sent. */
  count: number
  firstAt: number
  lastAt: number
  caption?: string
}

/** Who made a tool call: Claude's main loop, a sub-agent (named once known), or a plugin. */
export type CommandActor = { kind: 'claude' | 'agent' | 'plugin'; name: string }

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U'

export type FileChange = {
  path: string
  oldPath?: string
  status: FileStatus
  added: number
  removed: number
  isBinary: boolean
  isUntracked: boolean
  /** When the file on disk last changed, where it was read. */
  mtimeMs?: number
}

export type CommitInfo = {
  sha: string
  short: string
  subject: string
  body: string
  author: string
  email: string
  /** Author date, ms since the epoch. */
  date: number
  parents: string[]
  refs: string
  files: FileChange[]
  isSession: boolean
}

export type CommitScope = 'session' | 'branch' | 'recent'

export type GitView = {
  isRepo: boolean
  root: string
  branch: string
  head: string
  upstream?: string
  ahead: number
  behind: number
  worktree: FileChange[]
  commits: CommitInfo[]
  scope: CommitScope
  baseRef?: string
  updatedAt: number
  error?: string
}

/** A file's net state this session, strongest first: deleted, created, modified, read. */
export type FileActivity = 'created' | 'modified' | 'deleted' | 'read'

export type TouchedFile = {
  path: string
  activity: FileActivity
  reads: number
  edits: number
  firstAt: number
  lastAt: number
  /** When a Claude tool last wrote it. */
  editedAt?: number
  /** The tools that touched it, in order of first use. */
  tools: string[]
}

export type SourceKind = 'fetch' | 'search' | 'result' | 'browser' | 'command' | 'mcp'

/** One web address or search the session used. */
export type SourceRecord = {
  /** The URL, or `search:<query>` for a search. */
  id: string
  kind: SourceKind
  url?: string
  query?: string
  title?: string
  domain: string
  tool: string
  count: number
  firstAt: number
  lastAt: number
  status?: number
  bytes?: number
  durationMs?: number
  isError: boolean
  /** For a search, how many result URLs it returned; for a result, the search's query. */
  resultCount?: number
  via?: string
  // --- sources by task ---
  /** The tasks (TaskLabel ids) that used it, in order of first use; the latest kept when capped. */
  taskIds: string[]
  // --- end sources by task ---
}

// --- sources by task ---
/** What a task is: a prompt the person typed, a sub-agent, or neither (the session itself). */
export type TaskKind = 'prompt' | 'agent' | 'session'

/** One task the session's sources are attributed to. */
export type TaskLabel = {
  /** A main-loop prompt's turn id, a sub-agent's id, or `session`. */
  id: string
  kind: TaskKind
  /** The prompt on one line, or the sub-agent's type and description. */
  label: string
  startedAt: number
  endedAt?: number
  model?: string
}

/** How the Sources tab lists what was used: grouped by website, or by the task that used it. */
export type SourceView = 'site' | 'task'
// --- end sources by task ---

export type DiffMode = 'hunks' | 'full'

export type DiffView = {
  /** `${commitKey}\u0000${path}`, the open file. */
  key: string
  /** A git diff, or the file's current text where git has none (outside the repository, or only read). */
  kind: 'diff' | 'content'
  commitKey: string
  path: string
  oldPath?: string
  mode: DiffMode
  text: string
  header: string[]
  isTruncated: boolean
  hiddenLines: number
  isLoading: boolean
  isBinary: boolean
  error?: string
}

/** One battery reading, with this session's energy so far at that moment. */
export type BatteryReading = {
  t: number
  percent: number
  mah: number
  maxMah: number
  mv: number
  /** Negative while discharging. */
  ma: number
  isCharging: boolean
  isExternal: boolean
  minutesLeft?: number
  /** The session's energy (measured and estimated) when the reading was taken, in joules. */
  sessionJ: number
}

/** The battery before and after one turn of work. */
export type TurnBattery = {
  turnId: string
  prompt: string
  model?: string
  effort?: string
  start: BatteryReading
  end?: BatteryReading
}

/** The battery at one reading, for its chart: the charge, and the whole Mac's draw from it. */
export type BatteryPoint = {
  t: number
  percent: number
  /** The Mac's draw from the battery in watts; 0 on the adapter. */
  watts: number
  isExternal: boolean
}

export type BatteryView = {
  hasBattery: boolean
  /** The first reading of the session: the battery before the work started. */
  start: BatteryReading | null
  latest: BatteryReading | null
  turns: TurnBattery[]
  checkedAt: number
  /** Every reading of the session, oldest first, capped. */
  history: BatteryPoint[]
}

/** The work one model at one effort level did this session. */
/**
 * The session's model and effort as Overview's controls show and set them:
 * the `/config` Model row (its value, its choices, whether a policy locks
 * it), the effort the latest main-loop request used, and the level last set
 * from the slider, shown until a request uses it.
 */
export type SessionSettings = {
  model: string
  modelOptions: string[]
  isModelLocked: boolean
  effort: string
  askedEffort: string
  /** A model and an effort picked on the card and not applied yet; '' for none. */
  draftModel: string
  draftEffort: string
}

export type ModelUse = {
  model: string
  effort: string
  turns: number
  prompts: number
  requests: number
  toolCalls: number
  agentRequests: number
}

/**
 * The few figures every tab's header shows, written at most every few
 * seconds: tabs without live figures redraw only when these change.
 */
export type Pulse = {
  t: number
  status: SamplerStatus
  netIn: number
  netOut: number
  costUsd?: number
  contextPct?: number
  commands: number
  running: number
  failed: number
  files: number
  sources: number
  /** Prompts you sent this session, and commits made this session. */
  prompts?: number
  commits?: number
  /** Files this session changed (git sees them), and the lines added and removed. */
  changed?: number
  plus?: number
  minus?: number
  batteryPct?: number
  isCharging?: boolean
  // --- agents ---
  /** Agents, workflows and background shells this session, and how many are working now. */
  agents?: number
  agentsLive?: number
  // --- end agents ---
}

// --- agents ---
/**
 * What an agent row is: a sub-agent (the Agent tool, a fork), a teammate, a
 * workflow run, one of a workflow's agents, or a background shell command.
 */
export type AgentKind = 'subagent' | 'teammate' | 'workflow' | 'workflow-agent' | 'shell'

/** Where an agent's loop stands: the engine's AgentStatus, the same words. */
export type AgentRunStatus = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'

/** One agent, workflow or background task of the session, with what it has done so far. */
// --- prompt cache ---
/** One model request's prompt as the prompt cache served it: read from it, written to it (kept 5 minutes or an hour), and new. */
export type CacheRequest = { id: string; at: number; model: string; input: number; output: number; read: number; write5m: number; write1h: number }

/** One model's requests summed. */
export type CacheTotals = { model: string; requests: number; input: number; output: number; read: number; write5m: number; write1h: number }

/** Something in a cached prompt: a call's output or input, a prompt, a compaction's summary; its size in characters. */
export type CacheItem = { kind: 'result' | 'input' | 'prompt' | 'summary'; tool: string; title: string; chars: number; at: number }

/** The characters a cached prompt took in since it began, by kind. */
export type CacheKinds = { results: number; inputs: number; prompts: number; replies: number; summaries: number }

/**
 * A loop's prompt cache as its transcript tells it: its newest requests
 * (oldest first), all of them summed by model, how many of them wrote their
 * prompt again (lib/cache.ts isRewrite), when it was compacted, and
 * since the last compaction when its prompt began, how big it was then, and
 * what it took in since.
 */
export type CacheLoop = { requests: CacheRequest[]; totals: CacheTotals[]; rewrites: number; resets: number[]; startedAt: number; startTokens: number; items: CacheItem[]; kinds: CacheKinds }

/** An agent's own prompt cache: what it is, its last request, its requests summed by model. */
export type CacheAgent = { id: string; label: string; type: string; requests: number; last: CacheRequest; totals: CacheTotals[] }

/** The Cache tab's reading of the session's transcripts, and when it was read. */
export type CacheView = { state: 'idle' | 'loading' | 'done' | 'failed'; readAt: number; main: CacheLoop | null; agents: CacheAgent[] }
// --- end prompt cache ---

/**
 * The open agent's calls read from its own transcript (a workflow's: its
 * agents'), those the monitor's list does not hold: older than the calls it
 * keeps, or from before it loaded. `state` says whether the read is under
 * way, done, or failed.
 */
export type AgentHistory = { agentId: string; state: 'loading' | 'done' | 'failed'; calls: CommandRecord[] }

export type AgentRecord = {
  /** The agent's id (its loop's `agentId`), a workflow's Workflow call id, or `shell:<call id>`. */
  id: string
  kind: AgentKind
  /** Its name, else the task's short description, else its type. */
  label: string
  /** The agent type (`Explore`, `general-purpose`), `workflow` or `shell`. */
  type: string
  /** A workflow's description, a shell's command. */
  description?: string
  status: AgentRunStatus
  /** The row it nests under: the agent that spawned it, or its workflow's row. */
  parentId?: string
  /** What SendMessage addresses it by. */
  name?: string
  teammateId?: string
  /** The Agent or Workflow call that started it. */
  toolUseId?: string
  /** A workflow's run id (`wf_…`). */
  runId?: string
  /** A workflow's (or remote agent's) background task id. */
  taskId?: string
  /** A workflow's phases, from its script's `meta`. */
  phases?: string[]
  isBackground: boolean
  /** Seen in `$.agent.list()`: once it leaves the list, the engine has dropped an ended agent. */
  wasListed: boolean
  /** The model and effort of its latest request. */
  model?: string
  effort?: string
  /** Model requests, turns (runs of its loop) and tool calls made inside it. */
  requests: number
  turns: number
  toolCalls: number
  /** Summed over its requests: input (cached or not) and output tokens. */
  tokensIn: number
  tokensOut: number
  /** The latest request's whole size, context and output, as Claude's own panel counts an agent's tokens. */
  contextTokens: number
  /** Time spent inside its turns. */
  activeMs: number
  startedAt: number
  endedAt?: number
  lastActivityAt: number
  /** What it was asked to do: the opening of the prompt that started it, in one line. */
  brief?: string
  /** Each run of its loop (a message can run it again), oldest first. */
  runs?: AgentRun[]
  /** What its requests cost at list prices: in all, and in the 5-hour block named by `blockKey`. */
  usd?: number
  /** That cost by the kind of token; absent from a record kept before it was. */
  parts?: CostBreakdown
  blockUsd?: number
  blockKey?: string
  /** What its loop is doing, as the latest event about it said. */
  phase?: AgentPhase
  /** When its latest model request began. */
  lastRequestAt?: number
  /** The visible text of its latest response, cut short; '' when it only called tools. */
  lastAnswer?: string
  /** Why its latest response stopped (`tool_use`, `end_turn`, …). */
  stopReason?: string
  /** Marked done by the mod: an agent whose end Claude Code never reports went quiet. */
  isEndAssumed?: boolean
}

/**
 * What an agent's loop is doing: waiting on a model request, running a tool,
 * between the two, answered (its turn about to end), or ended.
 */
export type AgentPhase = {
  kind: 'request' | 'tool' | 'between' | 'answered' | 'ended'
  since: number
  /** In a few words: the request's number, the tool call's summary, how it ended. */
  detail: string
}

/** One run of an agent's loop: from its first request to the end of its turn. */
export type AgentRun = {
  startedAt: number
  endedAt?: number
  requests: number
  /** How it ended: `answer`, `aborted`, `refusal` or `error`. */
  reason?: string
}
// --- end agents ---

/** One MCP server's use this session. */
export type ServiceUse = { server: string; calls: number; totalMs: number; errors: number; lastAt: number }

export type RateLimitView = { kind: string; percentUsed: number; resetsAt?: string }

export type UsageView = {
  costUsd?: number
  contextPct?: number
  contextTokens?: number
  contextWindow: number
  rateLimits: RateLimitView[]
  model: string
  turns: number
  sessionStartedAt: number
  updatedAt: number
}

export type CommandScope = 'bash' | 'all'
export type AccessFilter = 'all' | Access
export type FileFilter = 'all' | FileActivity
export type SourceFilter = 'all' | 'fetch' | 'search' | 'browser' | 'command' | 'mcp'
export type StatusFilter = 'all' | 'running' | 'failed'
export type ResourceSort = 'energy' | 'cpu' | 'net' | 'mem'
/** What the Compute tab's charts span: the last two minutes, second by second, or the whole session. */
export type ComputeRange = 'live' | 'session'

export type UiState = {
  tab: MonitorTab
  expandedCommand: string | null
  // --- agents ---
  /** The Agents tab's open row: an agent's, a workflow's or a background shell's id. */
  expandedAgent?: string | null
  // --- end agents ---
  fullOutput: string | null
  commandScope: CommandScope
  statusFilter: StatusFilter
  filterText: string
  listLimit: number
  /** Where the Prompts tab's page of this session's prompts starts, newest first; absent, at the newest. */
  promptsFrom?: number
  /** Where its page of the project's other sessions' prompts starts; absent, at the newest. */
  earlierFrom?: number
  /** Where the open agent's page of its calls starts, newest first; 0 when another opens. */
  agentCallsFrom?: number
  /** The parent agents whose children's cards the Agents tab shows, by id; the others' are folded away. */
  shownAgents?: string[]
  openCommit: string | null
  diffMode: DiffMode
  resourceSort: ResourceSort
  computeRange: ComputeRange
  isAlerting: boolean
  /** Hides the quick-stats strip above the prompt (`/monitor bar off`). */
  isBarHidden: boolean
  /** The Commands tab's prompt groups drawn closed. */
  collapsedGroups: string[]
  /** The Prompts tab's open row. */
  openPrompt: string | null
  /** The Prompts tab's card a click on Overview opened, edged in the accent until the next click. */
  markedPrompt?: string | null
  /** Whether Find in conversation may press keys in the desktop app; absent until macOS was asked. */
  findAccess?: FindAccess
  /** Off: prompts keep their first-sentence summary, no model is asked (`/monitor summaries off`). */
  isSummaryOff: boolean
  accessFilter: AccessFilter
  fileFilter: FileFilter
  sourceFilter: SourceFilter
  // --- sources by task ---
  sourceView: SourceView
  /** The task whose sources are open in the By task view. */
  openTask: string | null
  /** Whether the By task view lists tasks that used no web sources. */
  showEmptyTasks: boolean
  // --- end sources by task ---
  /** Live sampling stopped for this session by `/monitor off`. */
  isPaused: boolean
  // --- ui polish ---
  /** Until when (ms since the epoch) a second press of the compact button compacts; 0 when not armed. */
  compactArmedUntil: number
  // --- ui polish ---
  // --- ports ---
  /** Open rows on the Ports tab: `pt:dev:<port>`, `pt:proc:<pid>`, `pt:lis:<pid>:<port>`. */
  portsOpen: string[]
  /** A Kill or Force kill pressed once, waiting for its confirming press. */
  killArmed: KillArmed | null
  /** The Ports tab's "Other apps" group of listeners is open. */
  portsOtherOpen: boolean
  // --- end ports ---
  // --- session history ---
  /**
   * The past session of this project the picker shows in place of this one
   * (on the Prompts, Agents, Files, Commits and Commands tabs, and Overview's
   * Session and Artifacts cards); null or absent while this session's own
   * figures show. Never kept in the saved preferences.
   */
  viewedSession?: string | null
  // --- end session history ---
}

// --- session history ---

/** The web sources a past session used, counted as Overview's Session card counts them. */
export type SessionSources = { urls: number; domains: number; searches: number }

/** A past session of the project as the store's list names it: what the session picker shows of it. */
export type SessionEntry = {
  id: string
  startedAt: number
  /** Its latest activity: a prompt, a call, an agent, a file or an artifact. */
  lastAt: number
  /** Its first prompt's title; '' when it sent none. */
  title: string
  /** What it cost: the session's own figure, else its requests at list prices; absent when neither is known. */
  usd?: number
  prompts: number
  commands: number
  /** How much of the store its record takes: characters of JSON. */
  bytes: number
  /** `transcript` for a session the monitor kept no record of, read from Claude Code's transcript. */
  source?: 'transcript'
}

/**
 * One session's record, kept in `$.store` so later sessions of the project
 * can show it: what its tabs drew, trimmed and capped (no outputs, no sampler
 * groups, short texts). Read back validated.
 */
export type SessionSnapshot = {
  /** The record's layout: one of another is not read. */
  v: number
  id: string
  /** The project it belongs to: its repository's main working tree (or its folder outside one). */
  project: string
  /** Its git working tree, which its files are shown relative to; '' outside one. */
  root: string
  branch: string
  /** HEAD when it was last saved. */
  head: string
  startedAt: number
  lastAt: number
  /** Its first prompt's title; '' when it sent none. */
  title: string
  prompts: PromptRecord[]
  commands: CommandRecord[]
  agents: AgentRecord[]
  touched: TouchedFile[]
  /** What git saw uncommitted when it was last saved. */
  worktree: FileChange[]
  /** The commits it made, the newest first. */
  commits: CommitInfo[]
  artifacts: ArtifactRecord[]
  usage: UsageView
  spend: SpendView
  sources: SessionSources
  models: ModelUse[]
  /** `transcript` when it was read from Claude Code's transcript alone: the monitor's figures are absent. Never stored. */
  source?: 'transcript'
  /** Each call's output by its id, as the transcript kept it, when one was read. Never stored. */
  outputs?: Record<string, string>
}

/**
 * The project's past sessions for the picker (this one left out), the newest
 * first; and where this session's record begins: the time of a `/clear` or a
 * resume that gave the session a new id, 0 before one.
 */
export type HistoryView = { entries: SessionEntry[]; floor: number }

// --- end session history ---

// --- file tree ---

/** What one entry is, read without following a symbolic link. */
export type TreeEntryKind = 'dir' | 'file' | 'link' | 'other'

/** One entry of a listed folder, as `sampler/tree.py` reads it. */
export type TreeEntry = {
  name: string
  kind: TreeEntryKind
  /** A file's bytes; a folder's, the total of what it holds. */
  size: number
  /** The folder's total was still being added up when its time ran out (or a part could not be read). */
  isPartial: boolean
  /** As `ls -l` prints it: `drwxr-xr-x`. */
  mode: string
  mtimeMs: number
  /** The name starts with a dot. */
  isHidden: boolean
  linkTarget?: string
  /** Why the entry could not be read in full (a folder without read access). */
  error?: string
}

/** One folder's listing. */
export type TreeListing = {
  path: string
  /** Folders first, then the rest; each of the visible and the hidden ones capped. */
  entries: TreeEntry[]
  /** Every entry the folder holds, the hidden ones included. */
  total: number
  hiddenTotal: number
  isTruncated: boolean
  loadedAt: number
}

/** Which list the Files tab shows: the session's file activity, or the working folder as a tree. */
export type FilesMode = 'activity' | 'folder'

/** The Files tab's folder tree. Listings are kept only for the root and the expanded folders. */
export type TreeView = {
  mode: FilesMode
  /** The session's working folder, absolute; '' before the first listing. */
  root: string
  /** Expanded folders, by absolute path (the root is always open). */
  expanded: string[]
  /** Folders whose hidden entries are shown. */
  hiddenOpen: string[]
  listings: Record<string, TreeListing>
  /** Folders being listed now. */
  loading: string[]
  /** Why a folder could not be listed, by path. */
  errors: Record<string, string>
}

// --- end file tree ---

// --- explorer ---

/** The Explorer's open form: a new file or folder in `dir`, or a new name for `path`. */
export type ExplorerForm = { kind: 'file' | 'folder'; dir: string } | { kind: 'rename'; path: string }

/** A file open in the Explorer's editor: its text as loaded or last saved, and its time on disk then. */
export type ExplorerEdit = {
  path: string
  text: string
  mtimeMs: number
  /** It changed on disk since it was loaded: the next Save writes over that change. */
  isStale: boolean
}

/** A button that acts on its second press (Delete, Discard), and when it was first pressed. */
export type ExplorerArmed = { key: string; at: number }

/**
 * The Explorer tab: the project folder as an editor's tree, every entry
 * inline, folders first. `tree` holds the listings (its `mode` and
 * `hiddenOpen` unused); the rest is what is selected, typed and edited.
 */
export type ExplorerView = {
  tree: TreeView
  /** The selected entry, by absolute path; null for none (the root). */
  selected: string | null
  form: ExplorerForm | null
  edit: ExplorerEdit | null
  armed: ExplorerArmed | null
  /** The names git ignores in each listed folder, drawn dim. */
  ignored: Record<string, string[]>
}

// --- end explorer ---

// --- ports ---

/** A process as `ps` reports it: suspended is SIGSTOP'd (stat T). */
export type ProcState = 'running' | 'suspended' | 'zombie'

/** One process of a Claude session's tree. Times in ms since the epoch. */
export type ProcNode = {
  pid: number
  ppid: number
  pgid: number
  uid: number
  /** A short name with anything secret-looking left out; never the raw command line. */
  name: string
  state: ProcState
  cpuPct: number
  memBytes: number
  startedAt: number
  /** TCP ports it listens on. */
  ports: number[]
  /** 0 for a session's Claude process, 1 for its direct children, and so on. */
  depth: number
  /** The Session Monitor's own sampler or helper. */
  isMonitor: boolean
}

/** One Claude Code session on this Mac: its Claude process and everything under it. */
export type ClaudeSession = ProcNode & {
  cwd: string
  /** The session this pane runs in. */
  isThis: boolean
  children: ProcNode[]
}

export type ListenerOwner = 'claude' | 'dev' | 'other'

/** One TCP listener: a process and a port (its addresses joined). */
export type PortListener = {
  port: number
  address: string
  pid: number
  name: string
  uid: number
  owner: ListenerOwner
  startedAt: number
  state: ProcState
  isMonitor: boolean
  /** The Claude session whose tree holds it. */
  sessionPid?: number
}

/** What listens on a dev server's port, summed over its process group. */
export type DevServerLive = {
  port: number
  pids: number[]
  pgid: number
  name: string
  startedAt: number
  cpuPct: number
  memBytes: number
  procs: number
  cwd: string
  /** The group holds no Claude process, so Turn off signals it whole. */
  isGroupSafe: boolean
}

/** A dev server the tab can turn on and off; kept in `$.store` under `devServers`. */
export type DevServerConfig = {
  port: number
  name: string
  cwd: string
  command: string
  url: string
}

export type DevPhase = { port: number; phase: 'starting' | 'stopping'; since: number }

export type DevLog = { port: number; lines: string[] }

export type PortsView = {
  /** When the listing was last read; 0 before the first. */
  updatedAt: number
  uid: number
  home: string
  logDir: string
  sessions: ClaudeSession[]
  listeners: PortListener[]
  devServers: DevServerLive[]
  logs: DevLog[]
  configs: DevServerConfig[]
  phases: DevPhase[]
  error?: string
}

/** Which Kill button was pressed once (`kill:<pid>` or `force:<pid>`), and when. */
export type KillArmed = { key: string; at: number }

// --- end ports ---

declare module 'claude-code' {
  interface PluginState {
    'session-monitor': {
      // --- file tree ---
      tree: Shaped<TreeView>
      // --- end file tree ---
      // --- explorer ---
      explorer: Shaped<ExplorerView>
      // --- end explorer ---
      live: Shaped<LiveMetrics>
      commands: Shaped<CommandRecord[]>
      // --- agents ---
      agents: Shaped<AgentRecord[]>
      agentHistory: Shaped<AgentHistory>
      cache: Shaped<CacheView>
      // --- end agents ---
      output: StateFamily<string>
      ui: Shaped<UiState>
      git: Shaped<GitView>
      touched: Shaped<TouchedFile[]>
      sources: Shaped<SourceRecord[]>
      services: Shaped<ServiceUse[]>
      battery: Shaped<BatteryView>
      models: Shaped<ModelUse[]>
      settings: Shaped<SessionSettings>
      pulse: Shaped<Pulse>
      spend: Shaped<SpendView>
      artifacts: Shaped<ArtifactRecord[]>
      prompts: Shaped<PromptRecord[]>
      projectPrompts: Shaped<StoredPrompt[]>
      diff: Shaped<DiffView | null>
      usage: Shaped<UsageView>
      // --- sources by task ---
      tasks: Shaped<TaskLabel[]>
      // --- end sources by task ---
      // --- ports ---
      ports: Shaped<PortsView>
      // --- end ports ---
      // --- session history ---
      history: Shaped<HistoryView>
      /** The past session the picker shows, its record settled for viewing; null while none is. */
      viewed: Shaped<SessionSnapshot | null>
      // --- end session history ---
    }
  }
}
