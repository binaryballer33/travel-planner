// Session Monitor: live network, CPU, memory and energy per command, clickable
// command output, file activity, the web sources used, and a commit-by-commit
// file and diff browser, in one pane.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface, Timer, ToolCallResult, UiPressArgument } from 'claude-code'

import type {
  BatteryReading,
  AgentHistory,
  BatteryView,
  CacheAgent,
  CacheLoop,
  CacheView,
  CommandRecord,
  CommitScope,
  DiffMode,
  DiffView,
  FileChange,
  FindAccess,
  FindApp,
  GitView,
  LiveMetrics,
  ModelUse,
  SessionSettings,
  MonitorTab,
  Pulse,
  ServiceUse,
  SourceRecord,
  SpendView,
  ArtifactRecord,
  PromptRecord,
  RateLimitView,
  StoredPrompt,
  Totals,
  TurnEnd,
  UiState,
  UsageView,
} from '../types'
import {
  alertsOf,
  applyTickToCommands,
  applyTickToLive,
  clipOutput,
  emptyLive,
  finishRecord,
  mapRecord,
  MAX_COMMANDS,
  startRecord,
  type Outcome,
} from './lib/commands'
import { addBatteryPoint, attribute, parseIoreg } from './lib/battery'
import { extractArtifacts, mergeArtifacts } from './lib/artifacts'
import { linkCalls, markRead, usesOf } from './lib/flow'
import {
  addAgent,
  addPrompt,
  addRequest,
  agentPromptsOf,
  beginTurn,
  carriedPrompts,
  cleanSummary,
  closeOpenRuns,
  deliveredTaskId,
  deliverPrompts,
  endFolded,
  endTurn,
  extendRun,
  isAtWork,
  isUserOrigin,
  isWaiting,
  ACCESSIBILITY_SETTINGS,
  allowedKeysText,
  allowKeysText,
  ENGINE_APP,
  findAccessProbe,
  findFallbackText,
  findKeystrokes,
  findRefusal,
  readFindAccess,
  type FindRefusal,
  jumpPlan,
  linkRequest,
  linkTask,
  markDelivered,
  mergeStored,
  needsModelSummary,
  newRun,
  normalize,
  noteOpenWindows,
  noteWindows,
  PROMPT_CHARS,
  quickSummary,
  readStored,
  refileAgentCalls,
  setSummary,
  spawnOwner,
  storedOf,
  storeKey,
  SUMMARY_SYSTEM,
  summaryPrompt,
  type TurnEnded,
} from './lib/prompts'
import { fileRows, touch, type FileRow, type TouchEvent } from './lib/files'
import { summarizeCall } from './lib/summary'
import { accessWord, fmtBytes, fmtCpuSeconds, fmtDuration, fmtEnergy, fmtRate, fmtUsd, fmtWatts, keyOf, oneLine, sanitize, shortModel } from './lib/format'
import { DIFF_BUDGET, gitFingerprint, loadDiff, loadGit, sessionChanges, summarize, truncateDiff, WORKTREE, type GitRun, type MtimeOf } from './lib/git'
import { effortText, recordStep, recordToolCall, type Step } from './lib/models'
// --- agents ---
import type { TurnUsage } from 'claude-code'
import type { AgentRecord } from '../types'
import {
  agentCounts,
  capAgents,
  isLive,
  launchWorkflow,
  listsCall,
  MAX_AGENTS,
  mergeAgentList,
  readAgentResult,
  readWorkflowResult,
  reconcileTasks,
  recordAgentRequest,
  ownersOf,
  recordAgentSpend,
  recordAgentStep,
  recordAgentToolCall,
  recordAgentToolEnd,
  settleOrphans,
  recordAgentTurn,
  recordSpawn,
  settleAgentCall,
  settleWorkflow,
  stopTask,
  textField,
  type SpawnFacts,
  type StepFacts,
  type TaskSnapshot,
  type TurnFacts,
} from './lib/agents'
// --- end agents ---
import { LineBuffer, parseMessage, type SamplerTick } from './lib/sampler'
import { addSpend, EMPTY_SPEND, requestSpend, shareOut } from './lib/spend'
import { byDomain, extractSources, mergeSources, recordService, summarizeSources } from './lib/sources'
import { activeRate, ACCESSES, byAccess, elapsedMs, timeStats } from './lib/stats'
import { agentCallsKey } from './view/agents'
import { MORE_STEP } from './view/commands'
import { rowKey } from './view/files'
// --- file tree ---
import type { FilesMode, TreeView } from '../types'
import {
  baseName,
  collapse,
  collapseAll,
  EMPTY_TREE,
  expand,
  findEntry,
  forRoot,
  isBelow,
  isAbsolutePath,
  isInsideRoot,
  isWanted,
  listedFolders,
  parentOf,
  parseListing,
  readTreePress,
  setLoading,
  toggleHidden,
  toPosixPath,
  TREE_SCRIPT,
  treeArgv,
  withListing,
  type ParsedListing,
  type TreePress,
} from './lib/tree'
// --- end file tree ---
// --- explorer ---
import type { ExplorerForm, ExplorerView } from '../types'
import {
  armStep,
  deleteKey,
  discardKey,
  EMPTY_EXPLORER,
  EXPLORER_ARM_MS,
  explorerFor,
  foldersDown,
  formAnchor,
  fromField,
  ignoreArgv,
  ignoredNames,
  isAtLeast,
  isCaseOnly,
  listingOf,
  movedPath,
  MULTILINE_SINCE,
  newEntryPath,
  readExplorerPress,
  relPath,
  renamedPath,
  targetDir,
  toField,
  TRASH_PATH,
  trashReason,
  uneditableReason,
  withRemoved,
  withRenamed,
  withSelected,
  type ExplorerPress,
} from './lib/explorer'
import { editorFieldKey, formFieldKey } from './view/explorer'
import { chosenApp, isOpenOk, isWindowsPath, openArgv, openLabel, windowsDefaultArgv, windowsOpenArgv, windowsTrashArgv } from './lib/apps'
// --- end explorer ---
import { spaceFor, type Actions, type PaneData, type Ui } from './view/kit'
import type { RowPress, RowProps } from './view/row'
import { closedAll, isLiveTab, pane, pulseKey, QUICK_TABS, quickLabels, statusLine, tabOfKey, TABS } from './view/pane'
import { isOverviewTitleKey, newestFirst, pageFromOf, pageStartKey, promptKey } from './view/prompts'
import { readExpandPress, readFoldPress, readTitlePress, type TitleLinkProps } from './view/title-link'
import type { EffortSliderProps } from './view/effort-slider'
import { readTabPress, type TabBarProps } from './view/tab-bar'
import { isEffortLevel, readEffortPress, type EffortLevel } from './lib/effort'
// --- sources by task ---
import type { AgentInfo } from 'claude-code'
import type { TaskLabel } from '../types'
import { addTask, agentLabel, endTask, promptLabel, relabelTask, reopenTask, taskForTurn, taskIdOf, taskReportLines } from './lib/tasks'
// --- end sources by task ---
// --- ui polish ---
import { COMPACT_ARM_MS } from './view/compact'
// --- ui polish ---
// --- ports ---
import type { PortsView } from '../types'
import {
  applySnapshot,
  ARM_MS,
  armKey,
  actionVerb,
  confirmStep,
  DEFAULT_DEV_SERVERS,
  DEV_SERVERS_KEY,
  devKey,
  devStatus,
  EMPTY_PORTS,
  launchArgs,
  logTail,
  migrateDevServers,
  needsConfirm,
  OTHER_KEY,
  parseLaunch,
  parseResult,
  parseSnapshot,
  parseStop,
  PORTS_POLL_MS,
  portsUi,
  readDevServers,
  signalArgs,
  snapshotArgs,
  START_POLL_MS,
  START_TIMEOUT_MS,
  stopArgs,
  toggled,
  verdict,
  withoutPhase,
  withPhase,
  type PortsSnapshot,
  type ProcAction,
  type ProcTarget,
} from './lib/ports'
// --- end ports ---
// --- session history ---
import type { CommitInfo, HistoryView, SessionEntry, SessionSnapshot, TouchedFile } from '../types'
import { shellRecords } from './lib/agents'
import {
  buildSnapshot,
  commitExistsArgv,
  entryOf,
  fitSnapshot,
  HISTORY_PREFIX,
  historyKey,
  isSha,
  MAX_SESSIONS,
  MISSING_COMMIT,
  pastGit,
  planHistory,
  readEntries,
  readSnapshot,
  settleSnapshot,
  SNAPSHOT_CHARS,
  SNAPSHOT_PREFIX,
  snapshotKey,
  TODAY_NOTE,
  upsertEntry,
  type Orphan,
} from './lib/history'
import { EMPTY_CACHE, hoursOf, NO_CACHE_HOURS, parseCache, readHours, type CacheHours } from './lib/cache'
import { AGENT_ID, commandsOfAgent, joinTranscript, mergeEntries, parseAgents, parseSession, parseSummaries, TRANSCRIPTS_SCRIPT, type TranscriptSession, type TranscriptSummary } from './lib/transcripts'
import { MAX_PROMPTS } from './lib/prompts'
import { PAST_TABS, PICKER_TABS, pastData } from './view/sessions'
// --- end session history ---

const PANE = 'session-monitor'
/** The slash command that opens the pane, and its shorter alias. */
export const COMMAND_NAME = 'session-monitor'
export const COMMAND_ALIAS = 'monitor'
const TITLE = 'Session Monitor'
const TAB_IDS: readonly MonitorTab[] = TABS.map(tab => tab.id)
/** The layout of every stored value; a reload that changes it starts them afresh. */
const SHAPE = 'v9'
const GIT_POLL_MS = 4_000
const USAGE_POLL_MS = 5_000
/** The header summary every tab shows; tabs without live figures redraw at most this often. */
const PULSE_MS = 10_000
/** A battery reading is one ~10 ms `ioreg` call. */
const BATTERY_POLL_MS = 60_000
const MAX_TURN_BATTERY = 20
/** Live figures reach the pane every second tick: fewer redraws, fewer missed clicks. */
const LIVE_WRITE_TICKS = 2
/** A second press of the same control this soon after the first is the same press. */
const BOUNCE_MS = 600
const NON_BASH_OUTPUT_CHARS = 4_000
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
/** Real interpreters first: /usr/bin/python3 is a shim that may ask to install developer tools. */
const PYTHONS = [
  '/Library/Developer/CommandLineTools/usr/bin/python3',
  '/Applications/Xcode.app/Contents/Developer/usr/bin/python3',
  '/opt/homebrew/bin/python3',
  '/usr/local/bin/python3',
]

export const DEFAULT_UI: UiState = {
  tab: 'overview',
  expandedCommand: null,
  fullOutput: null,
  commandScope: 'all',
  statusFilter: 'all',
  filterText: '',
  listLimit: 40,
  openCommit: null,
  diffMode: 'hunks',
  resourceSort: 'energy',
  computeRange: 'live',
  isAlerting: true,
  isBarHidden: false,
  collapsedGroups: [],
  openPrompt: null,
  isSummaryOff: false,
  accessFilter: 'all',
  fileFilter: 'all',
  sourceFilter: 'all',
  // --- sources by task ---
  sourceView: 'site',
  openTask: null,
  showEmptyTasks: false,
  // --- end sources by task ---
  isPaused: false,
  // --- ui polish ---
  compactArmedUntil: 0,
  // --- ui polish ---
  // --- ports ---
  portsOpen: [],
  killArmed: null,
  portsOtherOpen: false,
  // --- end ports ---
}

const EMPTY_GIT: GitView = {
  isRepo: false,
  root: '',
  branch: '',
  head: '',
  ahead: 0,
  behind: 0,
  worktree: [],
  commits: [],
  scope: 'session',
  updatedAt: 0,
}

const EMPTY_BATTERY: BatteryView = { hasBattery: false, start: null, latest: null, turns: [], checkedAt: 0, history: [] }

const EMPTY_PULSE: Pulse = { t: 0, status: 'starting', netIn: 0, netOut: 0, commands: 0, running: 0, failed: 0, files: 0, sources: 0 }

const EMPTY_USAGE: UsageView = {
  contextWindow: 0,
  rateLimits: [],
  model: '',
  turns: 0,
  sessionStartedAt: 0,
  updatedAt: 0,
}

const live = atom({ plugin: 'session-monitor', key: 'live' } as const, emptyLive(0), { shape: SHAPE })
const commands = atom({ plugin: 'session-monitor', key: 'commands' } as const, [], { shape: SHAPE })
const ui = atom({ plugin: 'session-monitor', key: 'ui' } as const, DEFAULT_UI, { shape: SHAPE })
const git = atom({ plugin: 'session-monitor', key: 'git' } as const, EMPTY_GIT, { shape: SHAPE })
const touched = atom({ plugin: 'session-monitor', key: 'touched' } as const, [], { shape: SHAPE })
const sources = atom({ plugin: 'session-monitor', key: 'sources' } as const, [], { shape: SHAPE })
const services = atom({ plugin: 'session-monitor', key: 'services' } as const, [], { shape: SHAPE })
const diff = atom({ plugin: 'session-monitor', key: 'diff' } as const, null, { shape: SHAPE })
const usage = atom({ plugin: 'session-monitor', key: 'usage' } as const, EMPTY_USAGE, { shape: SHAPE })
// --- file tree ---
const folderTree = atom({ plugin: 'session-monitor', key: 'tree' } as const, EMPTY_TREE, { shape: SHAPE })
// --- end file tree ---
// --- explorer ---
const explorer = atom({ plugin: 'session-monitor', key: 'explorer' } as const, EMPTY_EXPLORER, { shape: SHAPE })
// --- end explorer ---
const battery = atom({ plugin: 'session-monitor', key: 'battery' } as const, EMPTY_BATTERY, { shape: SHAPE })
const models = atom({ plugin: 'session-monitor', key: 'models' } as const, [], { shape: SHAPE })
const EMPTY_SETTINGS: SessionSettings = { model: '', modelOptions: [], isModelLocked: false, effort: '', askedEffort: '', draftModel: '', draftEffort: '' }
const settings = atom({ plugin: 'session-monitor', key: 'settings' } as const, EMPTY_SETTINGS, { shape: SHAPE })
const pulse = atom({ plugin: 'session-monitor', key: 'pulse' } as const, EMPTY_PULSE, { shape: SHAPE })
const spend = atom({ plugin: 'session-monitor', key: 'spend' } as const, EMPTY_SPEND, { shape: SHAPE })
const artifacts = atom({ plugin: 'session-monitor', key: 'artifacts' } as const, [], { shape: SHAPE })
const prompts = atom({ plugin: 'session-monitor', key: 'prompts' } as const, [], { shape: SHAPE })
const projectPrompts = atom({ plugin: 'session-monitor', key: 'projectPrompts' } as const, [], { shape: SHAPE })
// --- ports ---
const ports = atom({ plugin: 'session-monitor', key: 'ports' } as const, EMPTY_PORTS, { shape: SHAPE })
// --- end ports ---
const output = { plugin: 'session-monitor', key: 'output' } as const
// --- sources by task ---
const tasks = atom({ plugin: 'session-monitor', key: 'tasks' } as const, [], { shape: SHAPE })
// --- end sources by task ---

const PREFS_KEY = 'prefs'
/**
 * The width the pane asks for at an open, in columns: about 400 px of the
 * desktop app's text. Only the terminal's dock honours it, and there a width
 * the person dragged wins and is kept by the engine; the desktop app sizes
 * its side panel itself, from the person's last drag of a plugin pane (kept
 * as that pane's share of the window), whatever a plugin asks.
 */
export const DEFAULT_COLUMNS = 57
/** What earlier versions kept of the width the pane was drawn at: dropped at the session's start. */
const OLD_WIDTH_KEYS = ['paneColumns', 'paneColumnsDefault'] as const

/** A surface module's failures on one surface since this load: how many, and until when it is left out. */
export type ModuleFault = { faults: number; until: number }

/** How long a module that failed is left out at first; each failure after the wait doubles it, up to FAULT_WAIT_MAX_MS. */
export const FAULT_WAIT_MS = 30_000
export const FAULT_WAIT_MAX_MS = 16 * 60_000

/**
 * The surface modules that failed (`ui.fault`), by surface and path: each is
 * left out of that surface's drawings for a while, the plain elements in its
 * place (plain tab buttons, a title button, a button per effort level, a
 * plain list row), then tried again. The engine draws the site again once the
 * fault hook has answered, so the next drawing already leaves it out.
 */
const faultedModules = new Map<string, ModuleFault>()

/** A module's place in faultedModules: its surface, and its path under the plugin's folder (`hooks/view/tab-bar.tsx`). */
export const faultKey = (surface: string, module: string): string => `${surface}\u0000${module.replace(/^\.\//, 'hooks/')}`

/**
 * A module's record after it failed again at `now`. The desktop app tears a
 * whole frame down at once and reports each instance in it, so a report
 * while the module is already left out changes nothing; a failure after the
 * wait leaves it out twice as long.
 */
export const noteFault = (last: ModuleFault | undefined, now: number): ModuleFault => {
  if (last !== undefined && now < last.until) {
    return last
  }
  const faults = (last?.faults ?? 0) + 1
  return { faults, until: now + Math.min(FAULT_WAIT_MAX_MS, FAULT_WAIT_MS * 2 ** (faults - 1)) }
}

/** Whether a surface module, as a `Client`'s `module` names it (`./view/tab-bar.tsx`), is drawn on a surface at `now`. */
export const isModuleUsable = (surface: string, module: string, faulted: ReadonlyMap<string, ModuleFault>, now: number): boolean => {
  const fault = faulted.get(faultKey(surface, module))
  return fault === undefined || now >= fault.until
}

/**
 * What the fault hook does with a module's failure on a surface at `now`:
 * records it in `faulted` and answers how long until that surface is drawn
 * again with the module back; undefined when it was already left out (another
 * instance of a frame torn down at once), nothing then to record or redraw.
 */
export const heardFault = (faulted: Map<string, ModuleFault>, fault: { surface: string; module: string }, now: number): number | undefined => {
  const key = faultKey(fault.surface, fault.module)
  const last = faulted.get(key)
  const next = noteFault(last, now)
  if (next === last) {
    return undefined
  }
  faulted.set(key, next)
  return next.until - now
}

/** The pane's surface regions where a surface draws a `Client`, by the module each one runs. */
export type Regions = { row: boolean; effortSlider: boolean; titleLink: boolean; tabBar: boolean }

/**
 * Which regions a drawing on `surface` at `now` draws as `Client`s, where the
 * surface draws one: each while its module is not left out there after a
 * fault (the plain elements in its place), the tab bar in the desktop app only.
 */
export const usableRegions = (surface: RenderSurface, faulted: ReadonlyMap<string, ModuleFault>, now: number): Regions => {
  const usable = (module: string): boolean => isModuleUsable(surface, module, faulted, now)
  return {
    row: usable('./view/row.tsx'),
    effortSlider: usable('./view/effort-slider.tsx'),
    titleLink: usable('./view/title-link.tsx'),
    tabBar: surface === 'desktop' && usable('./view/tab-bar.tsx'),
  }
}

/** Opens the pane once a surface that draws is attached (the desktop attaches after the session starts); gives up after a minute. */
const openWhenDrawn = async ($: EngineInterface): Promise<void> => {
  for (let tries = 0; tries < 60; tries += 1) {
    if ((await $.session.surfaces()).length > 0) {
      await $.ui.open(paneArgs())
      return
    }
    await $.clock.sleep(1_000)
  }
}

/** What the pane opens with: its id, its title and the width it asks for. */
const paneArgs = (): { id: string; title: string; columns: number } => ({ id: PANE, title: TITLE, columns: DEFAULT_COLUMNS })
/** The 5-hour window's percent per dollar, learned in some session's window. */
const RATE_KEY = 'windowPctPerUsd'
/** Where the store keeps how much of each loop's cache writes is kept an hour (lib/cache.ts CacheHours). */
const CACHE_HOURS_KEY = 'cacheHours'
/** As the transcripts last showed it; the live prices of cache writes follow it. */
let cacheHours: CacheHours = NO_CACHE_HOURS

/** How much of a request's cache writes was kept an hour: by its loop's kind, as learned. */
const hourShareFor = (agentId: string | undefined): number => (agentId === undefined ? cacheHours.main : cacheHours.agents)

/** Takes what a reading of the transcripts shows of how long each loop's cache is kept, and keeps it for the sessions to come. */
const learnCacheHours = async ($: EngineInterface, main: CacheLoop, agentCaches: readonly CacheAgent[]): Promise<void> => {
  const learned = hoursOf(main, agentCaches, cacheHours)
  if (learned.main !== cacheHours.main || learned.agents !== cacheHours.agents) {
    cacheHours = learned
    await $.store.set(CACHE_HOURS_KEY, learned)
  }
}
type Prefs = Pick<UiState, 'commandScope' | 'diffMode' | 'resourceSort' | 'computeRange' | 'isAlerting' | 'isBarHidden' | 'isSummaryOff'>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readPrefs = (value: unknown): Partial<Prefs> => {
  if (!isRecord(value)) {
    return {}
  }
  const prefs: Partial<Prefs> = {}
  if (value.commandScope === 'bash' || value.commandScope === 'all') {
    prefs.commandScope = value.commandScope
  }
  if (value.diffMode === 'hunks' || value.diffMode === 'full') {
    prefs.diffMode = value.diffMode
  }
  if (value.resourceSort === 'energy' || value.resourceSort === 'cpu' || value.resourceSort === 'net' || value.resourceSort === 'mem') {
    prefs.resourceSort = value.resourceSort
  }
  if (value.computeRange === 'live' || value.computeRange === 'session') {
    prefs.computeRange = value.computeRange
  }
  if (typeof value.isAlerting === 'boolean') {
    prefs.isAlerting = value.isAlerting
  }
  if (typeof value.isBarHidden === 'boolean') {
    prefs.isBarHidden = value.isBarHidden
  }
  if (typeof value.isSummaryOff === 'boolean') {
    prefs.isSummaryOff = value.isSummaryOff
  }
  return prefs
}

/** Changes preferences in the pane's state and keeps them for later sessions. */
const savePrefsTo = async ($: EngineInterface, change: Partial<Prefs>): Promise<UiState> => {
  const saved = await update($, ui, (current): UiState => ({ ...current, ...change }))
  const prefs: Prefs = {
    commandScope: saved.commandScope,
    diffMode: saved.diffMode,
    resourceSort: saved.resourceSort,
    computeRange: saved.computeRange,
    isAlerting: saved.isAlerting,
    isBarHidden: saved.isBarHidden,
    isSummaryOff: saved.isSummaryOff,
  }
  await $.store.set(PREFS_KEY, prefs)
  return saved
}

/** A quick-stats button above the prompt: the pane opens on its tab. */
const openTab = async ($: EngineInterface, tab: MonitorTab): Promise<void> => {
  if (await isBounce($, `qs:${tab}`)) {
    return
  }
  await update($, ui, (current): UiState => ({ ...current, tab }))
  await $.ui.open({ ...paneArgs(), focus: true })
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Runs work nobody waits for (a refresh, a press's follow-up). A failure there
 * is dropped: it is most often the session or the module ending under it.
 */
const detach = (work: Promise<unknown>): void => {
  work.catch(() => undefined)
}

// Module state: rebuilt on every reload; everything drawn lives in $.state.
let isGitBusy = false
let isGitPending = false
let lastFingerprint = ''
let gitTimer: { cancel: () => void } | undefined
let samplerAttempts = 0
let tickCount = 0
let isSamplerWanted = true
let isSamplerRunning = false
/** The live figures between writes to the pane (every LIVE_WRITE_TICKS ticks). */
let liveBuffer: LiveMetrics | undefined
let lastUsage = ''
let lastPulse = ''
/** The model and effort of each loop's latest request ('' is the main loop). */
const lastStep = new Map<string, { model: string; effort: string }>()
/** Whether each turn began with something the person typed. */
const turnPrompts = new Map<string, boolean>()
/**
 * The calls each loop ('' is the main loop) started since its latest request:
 * the loop's next request reads their outputs, so its price is theirs to share.
 */
const pendingCalls = new Map<string, string[]>()
/** The prompt each sub-agent serves (by its task id): its calls and requests are that prompt's work. */
const agentPrompt = new Map<string, string>()
/** The prompt the agents an Agent or Workflow call started serve, by the call's id: a workflow's later agents serve it too. */
const callPrompt = new Map<string, string>()
/** Texts last submitted by something other than you (a task notification, a peer): their turns are no prompt of yours. */
const notYours = new Set<string>()
/** Your prompts submitted while idle, by text, with where they came from: the turn each starts records it. */
const pendingPrompts = new Map<string, string>()
/**
 * Your prompts submitted during a turn, by text, with where they came from:
 * recorded then, waiting. The running turn takes one in (a `queued_command`
 * the engine injects), or it starts a turn of its own.
 */
const earlyPrompts = new Map<string, string>()
/** The main loop's running turn, between its turn.start and its turn.complete. */
let mainTurn: string | undefined
/** Conversation rows already seen, and those seen but not yet matched to a prompt (a drawing cannot write state). */
const linkedRows = new Set<string>()
const pendingRows = new Map<string, string>()
/** The project's store key and this session's id, read once. */
let projectKey = ''
let sessionId = ''
/** The Mac's RAM in bytes (`sysctl hw.memsize`), read once; 0 until then. */
let memTotal = 0

/** The calls whose outputs each loop's latest finished request read: the next calls in that loop came of them. */
const lastRead = new Map<string, string[]>()
const lastPress = new Map<string, number>()
const alerted = new Set<string>()
let isAlertSeeded = false
// --- sources by task ---
/** The task the main loop's tool calls belong to: the latest prompt's (a continuation keeps it). */
let promptTask: string | undefined
/** Each running main-loop turn's task, for its turn.complete. */
const turnTasks = new Map<string, string>()
/** Sub-agents whose task is already recorded (or being recorded). */
const knownAgents = new Set<string>()
// --- end sources by task ---

const runner =
  ($: EngineInterface): GitRun =>
  async argv => {
    try {
      return await $.process.run(argv, { timeoutMs: 20_000 })
    } catch (error) {
      return { exitCode: 127, stdout: '', stderr: errorText(error) }
    }
  }

/** Whether the session works in a Windows folder (`C:\...`): its own tell, since the engine names no platform. */
const onWindows = async ($: EngineInterface): Promise<boolean> => {
  try {
    return isWindowsPath(await $.session.cwd())
  } catch {
    return false
  }
}

const mtimeOf =
  ($: EngineInterface): MtimeOf =>
  async path => {
    try {
      return (await $.fs.stat(path)).mtimeMs
    } catch {
      return undefined
    }
  }

const toast = async ($: EngineInterface, text: string): Promise<void> => {
  if ((await read($, ui)).isAlerting) {
    $.ui.toast(text, { timeoutMs: 6_000 })
  }
}

/**
 * True when the same control was pressed less than BOUNCE_MS ago. A double
 * click on a row then opens it once instead of opening and closing it.
 */
const isBounce = async ($: EngineInterface, key: string): Promise<boolean> => {
  const now = await $.clock.now()
  const last = lastPress.get(key)
  if (last !== undefined && now - last < BOUNCE_MS) {
    return true
  }
  lastPress.set(key, now)
  return false
}

// ------------------------------------------------------------------------- //
// Git, diffs and file contents
// ------------------------------------------------------------------------- //

const refreshGit = async ($: EngineInterface, isForced: boolean): Promise<void> => {
  if (isGitBusy) {
    isGitPending = isGitPending || isForced
    return
  }
  isGitBusy = true
  try {
    const run = runner($)
    const fingerprint = await gitFingerprint(run)
    const current = await read($, git)
    if (!isForced && fingerprint === lastFingerprint && current.updatedAt > 0) {
      return
    }
    lastFingerprint = fingerprint
    const startedAt = (await read($, usage)).sessionStartedAt || (await $.session.usage()).startedAt
    const view = await loadGit(run, current.scope, startedAt, await $.clock.now(), mtimeOf($))
    await update($, git, () => view)
    scheduleSave($) // --- session history --- a commit, or the work left uncommitted
  } catch (error) {
    await update($, git, view => ({ ...view, error: errorText(error) }))
  } finally {
    isGitBusy = false
    if (isGitPending) {
      isGitPending = false
      detach(refreshGit($, true))
    }
  }
}

const scheduleGit = ($: EngineInterface, delayMs: number): void => {
  gitTimer?.cancel()
  gitTimer = $.clock.after(delayMs, () => {
    gitTimer = undefined
    detach(refreshGit($, false))
  })
}

const pollGit = async ($: EngineInterface): Promise<void> => {
  // Skip while paused, and while a command runs: its own end schedules a
  // refresh, and git's processes would blur the CPU attributed to it.
  const list = await read($, commands)
  if (!isSamplerWanted || list.some(record => record.tool === 'Bash' && record.status === 'running')) {
    return
  }
  await refreshGit($, false)
}

/** How a diff opens: the commit it is of, when it is not in git's view (a past session's), and a line said above it. */
type DiffOptions = { commit?: CommitInfo; note?: string }

const openDiff = async ($: EngineInterface, commitKey: string, file: FileChange, mode: DiffMode, options: DiffOptions = {}): Promise<void> => {
  const key = `${commitKey}\u0000${file.path}`
  const view = await read($, git)
  const commit = options.commit ?? view.commits.find(one => one.sha === commitKey)
  const loading: DiffView = {
    key,
    kind: 'diff',
    commitKey,
    path: file.path,
    oldPath: file.oldPath,
    mode,
    text: '',
    header: [],
    isTruncated: false,
    hiddenLines: 0,
    isLoading: true,
    isBinary: file.isBinary,
  }
  await update($, diff, () => loading)
  const loaded = await loadDiff(runner($), {
    commitKey,
    parent: commit?.parents[0],
    path: file.path,
    oldPath: file.oldPath,
    isUntracked: file.isUntracked,
    hasHead: view.head !== '',
    mode,
  })
  await update($, diff, current =>
    current?.key === key && current.mode === mode
      ? {
          ...current,
          text: loaded.text,
          header: options.note === undefined ? loaded.header : [options.note, ...loaded.header],
          isTruncated: loaded.isTruncated,
          hiddenLines: loaded.hiddenLines,
          isBinary: loaded.isBinary || file.isBinary,
          isLoading: false,
          error: loaded.error,
        }
      : current,
  )
}

/** How a file's text opens: under another row's key (a past session's), and a line said above it. */
type ContentOptions = { key?: string; note?: string }

/** A file git has no diff for (outside the repository, or only read): its current text. */
const openContent = async ($: EngineInterface, path: string, options: ContentOptions = {}): Promise<void> => {
  const key = options.key ?? `FILE\u0000${path}`
  const loading: DiffView = {
    key,
    kind: 'content',
    commitKey: 'FILE',
    path,
    mode: 'hunks',
    text: '',
    header: options.note === undefined ? [] : [options.note],
    isTruncated: false,
    hiddenLines: 0,
    isLoading: true,
    isBinary: false,
  }
  await update($, diff, () => loading)
  let text = ''
  let error: string | undefined
  try {
    text = await $.fs.read(path)
  } catch (caught) {
    error = (await $.fs.exists(path)) ? errorText(caught) : 'The file no longer exists.'
  }
  const isBinary = text.includes('\u0000')
  const shown = truncateDiff(isBinary ? '' : sanitize(text), DIFF_BUDGET)
  await update($, diff, current =>
    current?.key === key
      ? { ...current, text: shown.text, isTruncated: shown.isTruncated, hiddenLines: shown.hiddenLines, isBinary, isLoading: false, error }
      : current,
  )
}

/** Opens or closes a file's panel; a press while it loads never closes it. */
const toggleFile = async ($: EngineInterface, key: string, open: () => Promise<void>): Promise<void> => {
  if (await isBounce($, key)) {
    return
  }
  const current = await read($, diff)
  if (current?.key === key) {
    if (!current.isLoading) {
      await update($, diff, () => null)
    }
    return
  }
  await open()
}

// ------------------------------------------------------------------------- //
// Opening rows: one path for a row's click and its title button
// ------------------------------------------------------------------------- //

/**
 * Opens or closes a call: in place where the Agents tab's open row lists it,
 * else in the Commands tab, which then shows every tool for a call not Bash.
 */
const toggleCommandRow = async ($: EngineInterface, id: string): Promise<void> => {
  if (await isBounce($, `cmd:${id}`)) {
    return
  }
  // --- session history ---
  // A past session's call opens in its record; one of this session's pressed while a past one is shown (Overview's live cards) shows this session again.
  const past = await viewedOf($)
  const isPastCall = past !== null && past.commands.some(record => record.id === id)
  const [list, agentList]: [readonly CommandRecord[], readonly AgentRecord[]] =
    past !== null && isPastCall ? [past.commands, past.agents] : await Promise.all([read($, commands), read($, agents)])
  // --- end session history ---
  const held = await read($, agentHistory)
  const isBash = [...list, ...held.calls].find(record => record.id === id)?.tool === 'Bash'
  await update($, ui, (current): UiState => {
    const isInPlace = current.tab === 'agents' && listsCall(current.expandedAgent, id, agentList, list, held)
    return {
      ...current,
      tab: isInPlace ? 'agents' : 'commands',
      expandedCommand: current.expandedCommand === id ? null : id,
      fullOutput: null,
      commandScope: isBash || isInPlace ? current.commandScope : 'all',
      ...(past !== null && !isPastCall ? { viewedSession: null, promptsFrom: 0 } : {}), // --- session history ---
    }
  })
}

const toggleCommitRow = async ($: EngineInterface, key: string): Promise<void> => {
  if (await isBounce($, `commit:${key}`)) {
    return
  }
  await update($, ui, (current): UiState => ({ ...current, openCommit: current.openCommit === key ? null : key }))
  await update($, diff, () => null)
}

const openCommitFile = async ($: EngineInterface, commitKey: string, file: FileChange): Promise<void> => {
  const past = await pastShown($) // --- session history ---
  await toggleFile($, `${commitKey}\u0000${file.path}`, async () => {
    const mode = (await read($, ui)).diffMode
    await (past !== null ? openPastDiff($, past, commitKey, file, mode) : openDiff($, commitKey, file, mode))
  })
}

const openFileRowOf = async ($: EngineInterface, row: FileRow): Promise<void> => {
  const change = row.change
  const isPast = (await pastShown($)) !== null // --- session history ---
  await toggleFile($, rowKey(row), async () =>
    isPast ? openPastFile($, row) : change !== undefined ? openDiff($, WORKTREE, change, (await read($, ui)).diffMode) : openContent($, row.path),
  )
}

const KINDS: readonly RowPress['kind'][] = ['cmd', 'commit', 'file', 'touched', 'task', 'group']

// --- sources by task ---
/** A click on a task's row in the Sources tab's By task view: open or close its sources. */
const toggleTaskRow = async ($: EngineInterface, id: string): Promise<void> => {
  if (await isBounce($, `task:${id}`)) {
    return
  }
  await update($, ui, (current): UiState => ({ ...current, openTask: current.openTask === id ? null : id }))
}
// --- end sources by task ---

/** What a row posted, when it is a row's press. */
const readPress = (data: unknown): RowPress | undefined => {
  if (!isRecord(data) || typeof data.id !== 'string' || typeof data.path !== 'string') {
    return undefined
  }
  const kind = KINDS.find(one => one === data.kind)
  return kind === undefined ? undefined : { kind, id: data.id, path: data.path }
}

/** A click anywhere on a row: open or close what it shows. */
const pressRow = async ($: EngineInterface, press: RowPress): Promise<void> => {
  // --- sources by task ---
  if (press.kind === 'task') {
    await toggleTaskRow($, press.id)
    return
  }
  // --- end sources by task ---
  if (press.kind === 'group') {
    await toggleGroup($, press.id)
    return
  }
  if (press.kind === 'cmd') {
    await toggleCommandRow($, press.id)
  } else if (press.kind === 'commit') {
    await toggleCommitRow($, press.id)
  } else if (press.kind === 'file') {
    const past = await pastShown($) // --- session history --- a past session's commits and files are its record's
    const view = past !== null ? pastGit(past) : await read($, git)
    const files = press.id === WORKTREE ? view.worktree : (view.commits.find(commit => commit.sha === press.id)?.files ?? [])
    const file = files.find(one => one.path === press.path)
    if (file !== undefined) {
      await openCommitFile($, press.id, file)
    }
  } else {
    const past = await pastShown($) // --- session history ---
    const list = past !== null ? past.touched : await read($, touched)
    const view = past !== null ? pastGit(past) : await read($, git)
    const row = fileRows(list, view.worktree, view.root, view.updatedAt).find(one => one.path === press.path)
    if (row !== undefined) {
      await openFileRowOf($, row)
    }
  }
}

// ------------------------------------------------------------------------- //
// Prompts: what you sent, its summary, its row in the conversation
// ------------------------------------------------------------------------- //

/** Keeps a prompt in the project's history, under its repository's main working tree. */
const storePrompt = async ($: EngineInterface, record: PromptRecord): Promise<void> => {
  if (projectKey === '') {
    return
  }
  const saved = mergeStored(readStored(await $.store.get(projectKey)), storedOf(record, sessionId))
  await $.store.set(projectKey, saved)
  await update($, projectPrompts, (): StoredPrompt[] => saved)
}

/** Asks a small model for a few words naming what the prompt asks; the first sentence stands until then, or if it fails. */
const summarizePrompt = async ($: EngineInterface, id: string, text: string): Promise<void> => {
  if ((await read($, ui)).isSummaryOff || !needsModelSummary(text)) {
    return
  }
  const reply = await $.model.complete({ model: 'haiku', system: SUMMARY_SYSTEM, prompt: summaryPrompt(text), maxTokens: 40, timeoutMs: 20_000 })
  const summary = reply.isAnswered ? cleanSummary(reply.text) : undefined
  if (summary === undefined) {
    return
  }
  const list = await update($, prompts, (current): PromptRecord[] => setSummary(current, id, summary))
  const record = list.find(one => one.id === id)
  if (record !== undefined) {
    await storePrompt($, record)
  }
}

/** The session's counters now, for a prompt's run; undefined while the sampler is not running. */
const sessionTotals = async ($: EngineInterface): Promise<Totals | undefined> => {
  const metrics = liveBuffer ?? (await read($, live))
  if (metrics.status !== 'running') {
    return undefined
  }
  const s = metrics.session
  return { cpuS: s.cpuS, energyJ: s.energyJ, energyEstJ: s.energyEstJ, netIn: s.netIn, netOut: s.netOut, diskR: s.diskR, diskW: s.diskW, netActiveS: s.netActiveS }
}

/**
 * Prompt bookkeeping runs one piece at a time, in the order its events came:
 * a prompt typed during a turn is recorded before the turn takes it in, and
 * a turn's end lands after its requests.
 */
let promptChain: Promise<void> = Promise.resolve()

const queuePrompts = (work: () => Promise<void>): void => {
  promptChain = promptChain.then(work).catch(() => undefined)
}

/** What `$.session.usage()` says now that a prompt's run keeps: the rate-limit windows, and the context window. */
type UsageNow = { readings: RateLimitView[]; contextWindow?: number }

const usageNow = async ($: EngineInterface): Promise<UsageNow> => {
  try {
    const figures = await $.session.usage()
    return {
      readings: figures.rateLimits.map(limit => ({ kind: limit.kind, percentUsed: limit.percentUsed, resetsAt: limit.resetsAt })),
      contextWindow: figures.context.window > 0 ? figures.context.window : undefined,
    }
  } catch {
    return { readings: [] }
  }
}

/**
 * A prompt of yours was sent: recorded. One that begins a turn (`taskId`
 * set) starts its run there, the rate-limit windows read; one typed during a
 * turn waits for that turn to take it in, or for a turn of its own.
 */
const recordPrompt = async ($: EngineInterface, text: string, origin: string, taskId: string | undefined): Promise<void> => {
  const [now, totals, figures] = await Promise.all([
    $.clock.now(),
    taskId === undefined ? Promise.resolve(undefined) : sessionTotals($),
    taskId === undefined ? Promise.resolve(undefined) : usageNow($),
  ])
  const kept = text.slice(0, PROMPT_CHARS)
  const readings = figures?.readings ?? []
  const record: PromptRecord = {
    id: `${now.toString(36)}-${(taskId ?? 'p').slice(-8)}`,
    text: kept,
    summary: quickSummary(kept),
    isModelSummary: false,
    at: now,
    origin,
    taskId,
    ...(taskId !== undefined ? { deliveredAt: now, run: { ...newRun(totals), ...(readings.length > 0 ? { windows: noteWindows(undefined, readings, now) } : {}) } } : {}),
  }
  await update($, prompts, (list): PromptRecord[] => addPrompt(taskId === undefined ? list : closeOpenRuns(list, taskId, now), record))
  await storePrompt($, record)
  detach(summarizePrompt($, record.id, kept))
  // The strip above the prompt counts it now, not at the next pulse.
  detach(refreshPulse($))
  scheduleSave($) // --- session history ---
}

/**
 * Reads the project's history, the session's id, the prompt in progress when
 * the module (re)loaded, and which prompt each agent serves.
 */
const loadPrompts = async ($: EngineInterface): Promise<void> => {
  const [repo, root, id] = await Promise.all([$.session.repo(), $.session.root(), $.session.id()])
  sessionId = id
  projectKey = storeKey(repo?.root ?? root)
  const saved = readStored(await $.store.get(projectKey))
  await update($, projectPrompts, (): StoredPrompt[] => saved)
  if (promptTask === undefined) {
    const latest = [...(await read($, tasks))].filter(task => task.kind === 'prompt').sort((a, b) => b.startedAt - a.startedAt)[0]
    promptTask = latest?.id
  }
  for (const [agentId, taskId] of agentPromptsOf(await read($, prompts))) {
    if (!agentPrompt.has(agentId)) {
      agentPrompt.set(agentId, taskId)
    }
  }
}

/**
 * The conversation rows seen drawing your prompts, matched to them: each
 * prompt learns where to scroll to. Run outside a drawing, which cannot write.
 */
const applyPromptRows = async ($: EngineInterface): Promise<void> => {
  if (pendingRows.size === 0) {
    return
  }
  const rows = [...pendingRows]
  pendingRows.clear()
  await update($, prompts, (list): PromptRecord[] => rows.reduce((linked, [requestId, text]) => linkRequest(linked, text, requestId), list))
}

/** A click on a Commands group's header: open or close it. */
const toggleGroup = async ($: EngineInterface, id: string): Promise<void> => {
  if (await isBounce($, `group:${id}`)) {
    return
  }
  await update($, ui, (current): UiState => ({
    ...current,
    collapsedGroups: current.collapsedGroups.includes(id) ? current.collapsedGroups.filter(one => one !== id) : [...current.collapsedGroups, id].slice(-200),
  }))
}

/**
 * Scrolls the conversation to a prompt: its own row, else the first tool call
 * its work made; says why when it cannot. A Button's press awaits it: the app
 * moves its conversation only while answering the person's own press (a
 * click on a Client region is that region's code, not theirs), so the scroll
 * comes first, from what the drawing knew and the rows seen since.
 */
const jumpToPrompt = async ($: EngineInterface, id: string, press: UiPressArgument, known: readonly PromptRecord[], calls: readonly CommandRecord[]): Promise<void> => {
  const plan = jumpPlan(known, [...pendingRows], calls, id)
  if (plan === undefined) {
    $.ui.toast('That prompt is from another session: only this session’s conversation can be scrolled to.', { timeoutMs: 5_000 })
    return
  }
  let reason = 'its message is not drawn in the conversation (before a compaction, or not yet seen)'
  for (const requestId of plan.targets) {
    try {
      const moved = await $.ui.scroll({ to: { requestId }, block: 'start' })
      if (moved.deny === undefined) {
        detach(applyPromptRows($))
        return
      }
      reason = moved.deny
    } catch (error) {
      reason = errorText(error)
    }
  }
  detach(applyPromptRows($))
  if (press.surface !== 'terminal') {
    // The desktop app draws its own conversation, which the engine cannot scroll ("transcript not scrollable here"),
    // and none of its links reaches one message of a local session (their `msg` is a Code project's); its Find can.
    const copied = await $.ui.copy({ text: plan.snippet, surface: press.surface })
    if (!copied.isCopied) {
      $.ui.toast(`Could not copy the prompt's opening: ${copied.reason}`, { timeoutMs: 8_000 })
      return
    }
    if (await onWindows($)) {
      $.ui.toast('Copied the prompt’s opening: press Ctrl+F, then Ctrl+V, to find it in the conversation.', { timeoutMs: 8_000 })
      return
    }
    // Press ⌘F, ⌘V and Return for the person, where macOS lets the app it holds responsible do so (findAccessProbe).
    const pressed = await runner($)(findKeystrokes())
    const said = pressed.stdout.trim()
    if (pressed.exitCode === 0 && said === 'pressed') {
      await noteFindAllowed($)
      return
    }
    const refusal = said === 'not-front' ? undefined : findRefusal(pressed.stderr)
    const app = refusal === undefined ? null : await refusedApp($, refusal)
    $.ui.toast(findFallbackText(plan.snippet, refusal, app?.name ?? ENGINE_APP), { timeoutMs: 10_000 })
    return
  }
  $.ui.toast(`Could not scroll to “${oneLine(plan.summary, 60)}”: ${reason}.`, { timeoutMs: 6_000 })
}

/** Keeps what macOS answered about Find's keys, for the Prompts tab's offer to allow them: written only when it changed. */
const setFindAccess = async ($: EngineInterface, access: FindAccess): Promise<void> => {
  const current = (await read($, ui)).findAccess
  if (current !== undefined && current.isAllowed === access.isAllowed && current.app?.name === access.app?.name && current.app?.path === access.app?.path) {
    return
  }
  await update($, ui, (state): UiState => ({ ...state, findAccess: access }))
}

/**
 * Asks macOS whether Find may press its keys, and for which app
 * (findAccessProbe), and keeps the answer; asking also has macOS list that app
 * under Accessibility. Undefined when the probe answered nothing usable.
 */
const probeFindAccess = async ($: EngineInterface, isAsking: boolean): Promise<FindAccess | undefined> => {
  if (await onWindows($)) {
    return undefined // only macOS asks before an app presses keys
  }
  const result = await runner($)(findAccessProbe(isAsking))
  const access = result.exitCode === 0 ? readFindAccess(result.stdout) : undefined
  if (access !== undefined) {
    await setFindAccess($, access)
  }
  return access
}

/** At a load with a desktop already drawing, asks macOS once whether Find may press its keys there; a desktop that attaches later asks then. */
const probeOnDesktop = async ($: EngineInterface): Promise<void> => {
  if ((await $.session.surfaces()).includes('desktop')) {
    await probeFindAccess($, false)
  }
}

/** A Find pressed its keys: macOS allows them, whatever it answered before. */
const noteFindAllowed = async ($: EngineInterface): Promise<void> => {
  const current = (await read($, ui)).findAccess
  await setFindAccess($, { isAllowed: true, app: current?.app ?? null })
}

/**
 * System Events refused a Find's keys: the app macOS holds responsible, for
 * the toast to name (asked of macOS when not known yet). Refused for want of
 * Accessibility, the Prompts tab offers to allow it from then on.
 */
const refusedApp = async ($: EngineInterface, refusal: FindRefusal): Promise<FindApp | null> => {
  const known = (await read($, ui)).findAccess?.app ?? null
  const app = known ?? (await probeFindAccess($, false))?.app ?? null
  if (refusal === 'accessibility') {
    await setFindAccess($, { isAllowed: false, app })
  }
  return app
}

/** How often Allow asks macOS again whether the switch is on, and how many times: every 2 s for 3 minutes. */
const ALLOW_WATCH_MS = 2_000
const ALLOW_WATCH_TICKS = 90
/** The asking Allow started, while it goes on. */
let allowWatch: Timer | undefined

/**
 * Allow (the Prompts tab's offer, on the desktop): macOS is asked to list the
 * app it holds responsible for Find's keys under Accessibility (it may show
 * its own prompt), System Settings opens at that list, the app's path is
 * copied for the list's + button, and the monitor asks again every few
 * seconds until the switch is on, which a toast then says.
 */
const allowFindKeys = async ($: EngineInterface, press: UiPressArgument): Promise<void> => {
  const asked = await probeFindAccess($, true)
  if (asked?.isAllowed === true) {
    $.ui.toast(allowedKeysText(asked.app), { timeoutMs: 6_000 })
    return
  }
  const app = asked?.app ?? (await read($, ui)).findAccess?.app ?? null
  const opened = await runner($)(['open', ACCESSIBILITY_SETTINGS])
  if (opened.exitCode === 0) {
    const isCopied = app !== null && (await $.ui.copy({ text: app.path, surface: press.surface })).isCopied
    $.ui.toast(allowKeysText(app, isCopied), { timeoutMs: 15_000 })
  } else {
    const why = oneLine(opened.stderr.trim() || `exit code ${opened.exitCode}`, 120)
    $.ui.toast(`Could not open System Settings (${why}): open Privacy & Security → Accessibility there and switch on “${app?.name ?? ENGINE_APP}”.`, { timeoutMs: 12_000 })
  }
  watchFindAccess($)
}

/** Asks macOS every ALLOW_WATCH_MS whether Find may press keys, until it may (a toast says so) or ALLOW_WATCH_TICKS asks went by. */
const watchFindAccess = ($: EngineInterface): void => {
  allowWatch?.cancel()
  let left = ALLOW_WATCH_TICKS
  let isAsking = false
  let watch: Timer | undefined
  const stop = (): void => {
    watch?.cancel()
    if (allowWatch === watch) {
      allowWatch = undefined
    }
  }
  watch = $.clock.every(ALLOW_WATCH_MS, () => {
    if (isAsking) {
      return
    }
    left -= 1
    if (left < 0) {
      stop()
      return
    }
    isAsking = true
    detach(
      probeFindAccess($, false)
        .then(access => {
          if (access?.isAllowed === true) {
            stop()
            $.ui.toast(allowedKeysText(access.app), { timeoutMs: 6_000 })
          }
        })
        .finally(() => {
          isAsking = false
        }),
    )
  })
  allowWatch = watch
}

/** The Mac's RAM, for memory's share of it: `sysctl -n hw.memsize`, once. */
const readMemTotal = async ($: EngineInterface): Promise<void> => {
  const result = await runner($)(['sysctl', '-n', 'hw.memsize'])
  const bytes = Number(result.stdout.trim())
  if (result.exitCode === 0 && Number.isFinite(bytes) && bytes > 0) {
    memTotal = bytes
  }
}

/**
 * A prompt typed during a turn began a turn of its own: linked to its task,
 * its run started. One no longer waiting (the module reloaded, or a prompt of
 * the same words was taken in meanwhile) is recorded afresh.
 */
const startEarlyPrompt = async ($: EngineInterface, text: string, origin: string, taskId: string): Promise<void> => {
  if (!isWaiting(await read($, prompts), text)) {
    earlyPrompts.delete(normalize(text))
    await recordPrompt($, text, origin, taskId)
    return
  }
  const [now, totals, figures] = await Promise.all([$.clock.now(), sessionTotals($), usageNow($)])
  const list = await update($, prompts, (current): PromptRecord[] =>
    markDelivered(beginTurn(closeOpenRuns(linkTask(current, text, taskId), taskId, now), taskId, totals, figures.readings, now), taskId, now),
  )
  forgetEarly(list, text)
}

/** Words no prompt of which still waits start no turn of their own any more. */
const forgetEarly = (list: readonly PromptRecord[], text: string): void => {
  if (!isWaiting(list, text)) {
    earlyPrompts.delete(normalize(text))
  }
}

/** A turn without typed text carries on the latest prompt: its run goes on. */
const continuePrompt = async ($: EngineInterface, taskId: string): Promise<void> => {
  const [now, totals, figures] = await Promise.all([$.clock.now(), sessionTotals($), usageNow($)])
  await update($, prompts, (list): PromptRecord[] => beginTurn(list, taskId, totals, figures.readings, now))
}

/**
 * A request made for a prompt (its own loop's, or an agent's spawned for it):
 * its tokens and price, and the rate-limit windows read again. One of its own
 * loop's (`isOwn`) also says how much context it carried, and in what window.
 */
const recordPromptRequest = async ($: EngineInterface, taskId: string | undefined, tokens: TurnUsage, isOwn: boolean): Promise<void> => {
  if (taskId === undefined) {
    return
  }
  // The main loop's own request, or an agent's spawned for the prompt: its writes priced by its loop's kind.
  const price = requestSpend(tokens, tokens.model, isOwn ? cacheHours.main : cacheHours.agents)
  const [now, figures] = await Promise.all([$.clock.now(), usageNow($)])
  await update($, prompts, (list): PromptRecord[] =>
    noteOpenWindows(
      addRequest(list, taskId, tokens, price?.usd, tokens.model, isOwn ? { contextWindow: figures.contextWindow } : undefined, price?.parts),
      one => one.taskId === taskId,
      figures.readings,
      now,
    ),
  )
}

/**
 * A main-loop turn ended: its prompt's run, and the runs of the prompts
 * folded into it, record when and how, and the session's counters and
 * rate-limit windows then.
 */
const endPromptTurn = async ($: EngineInterface, turnId: string, taskId: string | undefined, durationMs: number, reason: TurnEnd): Promise<void> => {
  const [now, totals, figures] = await Promise.all([$.clock.now(), sessionTotals($), usageNow($)])
  const end: TurnEnded = { at: now, durationMs, reason, totals, readings: figures.readings }
  await update($, prompts, (list): PromptRecord[] => endFolded(taskId === undefined ? list : endTurn(list, taskId, end), turnId, end))
}

/** Prompts the running turn `into` took in: each gets a task of its own and starts its run. */
const foldPrompts = async ($: EngineInterface, folded: readonly PromptRecord[], into: string | undefined): Promise<void> => {
  if (folded.length === 0) {
    return
  }
  const [now, totals, figures] = await Promise.all([$.clock.now(), sessionTotals($), usageNow($)])
  const ids = new Set(folded.map(one => one.id))
  const list = await update($, prompts, (current): PromptRecord[] => deliverPrompts(current, ids, { into, at: now, totals, readings: figures.readings }))
  for (const one of folded) {
    // No turn of its own will start for it now (unless another of its words still waits).
    forgetEarly(list, one.text)
  }
}

/**
 * A request of the running turn carried a text the engine injected for the
 * model: the prompts typed during the turn that it carries were folded in.
 */
const takeInPrompts = async ($: EngineInterface, carrier: string, into: string | undefined): Promise<void> => {
  await foldPrompts($, carriedPrompts(await read($, prompts), carrier), into)
}

/** What an `agent.spawn` says of the prompt the agent may serve, kept as it fired. */
type SpawnFor = { agentId: string; toolUseId: string; words: string; parentAgentId?: string; turnTask: string | undefined; turn: string | undefined }

/**
 * The prompt a spawned agent serves: its parent agent's, else the one its
 * call's earlier agents serve (a workflow's), else the one its words quote
 * best or the one the model was given last (spawnOwner); one still waiting
 * that it quotes was folded into the turn after all. Its calls and requests
 * count toward that prompt from here, and a call it already made moves there.
 */
const attributeSpawn = async ($: EngineInterface, spawn: SpawnFor): Promise<void> => {
  const parentTask = spawn.parentAgentId !== undefined ? agentPrompt.get(spawn.parentAgentId) : undefined
  let taskId = parentTask ?? (spawn.toolUseId !== '' ? callPrompt.get(spawn.toolUseId) : undefined)
  if (taskId === undefined) {
    const owner = spawnOwner(await read($, prompts), spawn.turnTask, spawn.words)
    if (owner !== undefined && owner.taskId === undefined) {
      await foldPrompts($, [owner], spawn.turn)
    }
    taskId = owner === undefined ? spawn.turnTask : (owner.taskId ?? deliveredTaskId(owner.id))
  }
  if (taskId === undefined) {
    return
  }
  const served = taskId
  agentPrompt.set(spawn.agentId, served)
  if (spawn.toolUseId !== '') {
    callPrompt.set(spawn.toolUseId, served)
  }
  await update($, prompts, (list): PromptRecord[] => addAgent(list, served, spawn.agentId))
  if ((await read($, commands)).some(call => call.agentId === spawn.agentId && call.promptId !== served)) {
    await update($, commands, list => refileAgentCalls(list, spawn.agentId, served))
  }
}

/** An agent's run ended: the prompt it serves, when its turn is over already, reads the session's counters and windows again. */
const endAgentRun = async ($: EngineInterface, agentId: string): Promise<void> => {
  const taskId = agentPrompt.get(agentId)
  if (taskId === undefined) {
    return
  }
  const [now, totals, figures] = await Promise.all([$.clock.now(), sessionTotals($), usageNow($)])
  await update($, prompts, (list): PromptRecord[] => extendRun(list, taskId, { at: now, totals, readings: figures.readings }))
}

/** A rate-limit window moved: the prompts at work (their turn running, or an agent of theirs) read it. */
const notePromptWindows = async ($: EngineInterface, readings: readonly RateLimitView[]): Promise<void> => {
  const [now, agentList, list] = await Promise.all([$.clock.now(), read($, agents), read($, prompts)])
  if (readings.length === 0 || !list.some(one => isAtWork(one, agentList))) {
    return
  }
  await update($, prompts, (current): PromptRecord[] => noteOpenWindows(current, one => isAtWork(one, agentList), readings, now))
}

/** The Commands tab showing one prompt's work: its group open, the others closed. */
const showPromptCommands = async ($: EngineInterface, taskId: string): Promise<void> => {
  // --- session history --- a past session's prompt opens among its own calls
  const past = await viewedOf($)
  const calls = past !== null && past.prompts.some(one => one.taskId === taskId) ? past.commands : await read($, commands)
  // --- end session history ---
  const ids = [...new Set(calls.map(call => call.promptId ?? ''))]
  await update($, ui, (current): UiState => ({ ...current, tab: 'commands', collapsedGroups: ids.filter(one => one !== taskId) }))
}

/**
 * How long a reveal waits before each try at scrolling to a prompt's card:
 * the card is drawn only once the Prompts tab is, a redraw after the tab is
 * switched, so the first try waits a beat and a later one longer.
 */
export const REVEAL_WAITS_MS: readonly number[] = [50, 100, 200, 400]

/**
 * A click on one of Overview's prompts: the Prompts tab, that prompt's card
 * edged in the accent until the next click, and the pane scrolled to the
 * card. A scroll of the plugin's own pane needs no press of the person's, so
 * it waits for the redraw that draws the card.
 */
const revealPrompt = async ($: EngineInterface, id: string): Promise<void> => {
  if (await isBounce($, `reveal:${keyOf(id)}`)) {
    return
  }
  // Its card opens on the Prompts tab, on its page, expanded, edged until the next click, and is scrolled into view.
  const index = newestFirst(await read($, prompts)).findIndex(one => one.id === id)
  const promptsFrom = index < 0 ? 0 : pageFromOf(index)
  await update($, ui, (current): UiState => ({ ...current, tab: 'prompts', markedPrompt: id, openPrompt: id, promptsFrom }))
  detach(scrollToPromptCard($, id))
}

/** Scrolls the pane to an element once it is drawn, quietly: a page's first card after Older or Newer. Its tries spent, it says why in the debug log alone. */
const scrollToKey = async ($: EngineInterface, key: string): Promise<void> => {
  let reason = 'it was not drawn'
  for (const waitMs of REVEAL_WAITS_MS) {
    await $.clock.sleep(waitMs)
    try {
      const moved = await $.ui.scroll({ to: { key }, in: PANE, block: 'start' })
      if (moved.deny === undefined) {
        return
      }
      reason = moved.deny
    } catch (error) {
      // The pane closed, or the card is not drawn yet: try again, then leave it.
      reason = errorText(error)
    }
  }
  $.ui.log(`Could not scroll the pane to ${key}: ${reason}.`, { to: 'debug' })
}

/** Scrolls the pane to a prompt's card once it is drawn; says why when it cannot. Stops once the person has moved on. */
const scrollToPromptCard = async ($: EngineInterface, id: string): Promise<void> => {
  let reason = 'its card was not drawn'
  for (const waitMs of REVEAL_WAITS_MS) {
    await $.clock.sleep(waitMs)
    const state = await read($, ui)
    if (state.tab !== 'prompts' || state.markedPrompt !== id) {
      return
    }
    try {
      const moved = await $.ui.scroll({ to: { key: promptKey(id) }, in: PANE, block: 'center' })
      if (moved.deny === undefined) {
        return
      }
      reason = moved.deny
    } catch (error) {
      reason = errorText(error)
    }
  }
  const summary = (await read($, prompts)).find(one => one.id === id)?.summary ?? 'the prompt'
  $.ui.toast(`Could not scroll to “${oneLine(summary, 60)}” on the Prompts tab: ${reason}.`, { timeoutMs: 6_000 })
}

/** The next click in the pane: the card a reveal marked loses its mark. */
const unmarkPrompt = async ($: EngineInterface): Promise<void> => {
  if (typeof (await read($, ui)).markedPrompt === 'string') {
    await update($, ui, (current): UiState => ({ ...current, markedPrompt: null }))
  }
}

// --- ui polish ---
// ------------------------------------------------------------------------- //
// Compacting the session from the pane
// ------------------------------------------------------------------------- //

let isCompacting = false
let compactTimer: { cancel: () => void } | undefined

/** Compacts the conversation as /compact does, and says how it went. */
const compactSession = async ($: EngineInterface): Promise<void> => {
  if (isCompacting) {
    $.ui.toast('Already compacting the session…', { timeoutMs: 3_000 })
    return
  }
  isCompacting = true
  let skip: string | undefined
  try {
    $.ui.toast('Compacting the session…', { timeoutMs: 6_000 })
    skip = (await $.session.compact({})).skip
  } catch {
    // It rejects while a turn runs.
    $.ui.toast("Can't compact while Claude is working — try again when it's idle", { timeoutMs: 6_000 })
    return
  } finally {
    isCompacting = false
  }
  if (skip !== undefined) {
    $.ui.toast(`Not compacted: a hook vetoed it (${oneLine(skip, 200)})`, { timeoutMs: 6_000 })
    return
  }
  $.ui.toast('Session compacted', { timeoutMs: 4_000 })
  await refreshUsage($)
  await refreshPulse($)
}

/**
 * A press of the compact button. Compacting is drastic, so a first press
 * only arms it (its label asks for another) for COMPACT_ARM_MS; a second
 * press within that compacts. A double click is one press (isBounce).
 */
const pressCompact = async ($: EngineInterface): Promise<void> => {
  if (await isBounce($, 'compact')) {
    return
  }
  const now = await $.clock.now()
  const isArmed = now < (await read($, ui)).compactArmedUntil
  compactTimer?.cancel()
  compactTimer = undefined
  if (isArmed) {
    await update($, ui, (current): UiState => ({ ...current, compactArmedUntil: 0 }))
    await compactSession($)
    return
  }
  const until = now + COMPACT_ARM_MS
  await update($, ui, (current): UiState => ({ ...current, compactArmedUntil: until }))
  // Puts the label back when the window closes, on tabs that are not redrawn meanwhile.
  compactTimer = $.clock.after(COMPACT_ARM_MS, () => {
    compactTimer = undefined
    detach(update($, ui, (current): UiState => (current.compactArmedUntil === until ? { ...current, compactArmedUntil: 0 } : current)))
  })
}
// --- ui polish ---

// ------------------------------------------------------------------------- //
// Usage, status line, alerts
// ------------------------------------------------------------------------- //

const refreshUsage = async ($: EngineInterface): Promise<void> => {
  const [figures, model, turns, now] = await Promise.all([$.session.usage(), $.session.model(), $.session.turns(), $.clock.now()])
  const view: UsageView = {
    costUsd: figures.cost?.usd,
    contextPct: figures.context.percent,
    contextTokens: figures.context.tokens,
    contextWindow: figures.context.window,
    rateLimits: figures.rateLimits.map(limit => ({ kind: limit.kind, percentUsed: limit.percentUsed, resetsAt: limit.resetsAt })),
    model,
    turns,
    sessionStartedAt: figures.startedAt,
    updatedAt: now,
  }
  // Written only when a figure changed, so the pane is not drawn again for nothing.
  const fingerprint = JSON.stringify({ ...view, updatedAt: 0 })
  if (fingerprint !== lastUsage) {
    lastUsage = fingerprint
    await update($, usage, () => view)
  }
}

/**
 * Prices a finished model request and shares it over the calls whose outputs
 * it read, by each one's size; the session's and the 5-hour block's totals
 * take the whole request.
 */
const recordSpend = async ($: EngineInterface, ids: readonly string[], tokens: TurnUsage, agentId: string | undefined): Promise<void> => {
  const request = requestSpend(tokens, tokens.model, hourShareFor(agentId))
  if (request === undefined) {
    return
  }
  const figures = await $.session.usage()
  const window = figures.rateLimits.find(limit => limit.kind === 'five_hour')
  const before = (await read($, spend)).pctPerUsd
  const after = await update($, spend, (view): SpendView => addSpend(view, request, window?.resetsAt, window?.percentUsed))
  if (after.pctPerUsd !== undefined && after.pctPerUsd !== before) {
    // The next session starts with the rate, before its own window moves.
    await $.store.set(RATE_KEY, after.pctPerUsd)
  }
  if (agentId !== undefined) {
    queueAgents(async () => {
      await writeAgents($, list => recordAgentSpend(list, agentId, request.usd, window?.resetsAt, request.parts))
    })
  }
  if (ids.length === 0) {
    return
  }
  await update($, commands, list => {
    const consumed = ids.map(id => {
      const record = list.find(one => one.id === id)
      return { id, weight: record === undefined ? 0 : record.outputChars + record.title.length }
    })
    const shares = shareOut(request, consumed, window?.resetsAt)
    return list.map(record => {
      const share = shares.get(record.id)
      return share === undefined ? record : { ...record, spend: share }
    })
  })
}

/** A request read these calls' outputs: when, what Claude said, and what it asked for next. */
const recordRead = async ($: EngineInterface, ids: readonly string[], said: string, asked: readonly string[]): Promise<void> => {
  const at = await $.clock.now()
  const read = new Set(ids)
  await update($, commands, list => markRead(list, read, { at, said, asked }))
}

/** A call came of reading earlier outputs: each learns of the other, with the bits of each output the call repeats. */
const linkFlow = async ($: EngineInterface, laterId: string, earlierIds: readonly string[], laterInput: string): Promise<void> => {
  const list = await read($, commands)
  const earlier: { id: string; uses: string[] }[] = []
  for (const id of earlierIds) {
    const record = list.find(one => one.id === id)
    if (record === undefined) {
      continue
    }
    const text = (await $.state.get({ ...output, id })).value ?? ''
    earlier.push({ id, uses: usesOf(text, laterInput, record.title) })
  }
  await update($, commands, current => linkCalls(current, laterId, earlier))
}

const checkAlerts = async ($: EngineInterface, list: readonly CommandRecord[], now: number): Promise<void> => {
  if (!isAlertSeeded) {
    // After a reload, never repeat what the last load already said.
    isAlertSeeded = true
    for (const record of list) {
      for (const kind of ['net', 'slow', 'failed']) {
        alerted.add(`${record.id}:${kind}`)
      }
    }
    return
  }
  for (const record of list) {
    for (const alert of alertsOf(record, now)) {
      const key = `${record.id}:${alert.kind}`
      if (!alerted.has(key)) {
        alerted.add(key)
        await toast($, alert.text)
      }
    }
  }
}

/**
 * The status line under the prompt: the whole Mac's CPU, memory, network and
 * latency (statusLine). None while paused, or where nothing can be measured.
 */
const refreshStatus = async ($: EngineInterface): Promise<void> => {
  const current = liveBuffer ?? (await read($, live))
  $.ui.status(isSamplerWanted && current.status !== 'unsupported' ? statusLine(current) : undefined)
}

// --- agents ---
// ------------------------------------------------------------------------- //
// Agents: sub-agents, teammates, workflows, and what each has done
// ------------------------------------------------------------------------- //

const agents = atom({ plugin: 'session-monitor', key: 'agents' } as const, [], { shape: SHAPE })
const NO_HISTORY: AgentHistory = { agentId: '', state: 'done', calls: [] }
/** The open agent's calls read from its own transcript: one agent's at a time. */
const agentHistory = atom({ plugin: 'session-monitor', key: 'agentHistory' } as const, NO_HISTORY, { shape: SHAPE })

// --- prompt cache ---
/** The session's prompt cache as its transcripts tell it, for the Cache tab. */
const cacheView = atom({ plugin: 'session-monitor', key: 'cache' } as const, EMPTY_CACHE, { shape: SHAPE })
/** How often the Cache tab reads the transcripts while it is open. */
const CACHE_POLL_MS = 30_000
/** When the transcripts were last read for it; a read sooner after is skipped. */
let cacheReadAt = -Infinity

/** Reads the session's prompt cache from its transcripts (sampler/transcripts.py `cache`), no oftener than CACHE_POLL_MS unless `isForced`. */
const loadCache = async ($: EngineInterface, isForced = false): Promise<void> => {
  const now = await $.clock.now()
  if (!isForced && now - cacheReadAt < CACHE_POLL_MS) {
    return
  }
  cacheReadAt = now
  const [sessionId, project] = await Promise.all([$.session.id(), projectOf($)])
  await update($, cacheView, (current): CacheView => (current.main === null ? { ...current, state: 'loading' } : current))
  const answer = project === '' ? undefined : parseCache(await runTranscripts($, ['cache', project, sessionId]))
  await update($, cacheView, (current): CacheView => (answer === undefined ? { ...current, state: 'failed', readAt: now } : { state: 'done', readAt: now, main: answer.main, agents: answer.agents }))
  if (answer !== undefined) {
    await learnCacheHours($, answer.main, answer.agents)
  }
}

/** Whether this session has read its transcripts for how long its cache is kept. */
let isHoursRead = false

/**
 * Once a session's first turn ends, its transcript shows how long its cache
 * is kept: read it (in the background, once) so the live cost of cache
 * writes is priced right from then on.
 */
const readCacheHours = async ($: EngineInterface): Promise<void> => {
  if (isHoursRead) {
    return
  }
  isHoursRead = true
  const [sessionId, project] = await Promise.all([$.session.id(), projectOf($)])
  const answer = project === '' ? undefined : parseCache(await runTranscripts($, ['cache', project, sessionId]))
  if (answer !== undefined) {
    await learnCacheHours($, answer.main, answer.agents)
  }
}
// --- end prompt cache ---
/** How often the engine's agent list is read while an agent works or the Agents tab is open. */
const AGENT_POLL_MS = 3_000
/** Agent bookkeeping runs one piece at a time, in the order its events came. */
let agentChain: Promise<void> = Promise.resolve()
let isAgentSyncQueued = false

const queueAgents = (work: () => Promise<void>): void => {
  agentChain = agentChain.then(work).catch(() => undefined)
}

/** Folds the agents and writes them when that changed something; says whether it did. */
const writeAgents = async ($: EngineInterface, fold: (list: readonly AgentRecord[], now: number) => AgentRecord[]): Promise<boolean> => {
  const now = await $.clock.now()
  const current = await read($, agents)
  const folded = capAgents(fold(current, now), MAX_AGENTS)
  if (JSON.stringify(folded) === JSON.stringify(current)) {
    return false
  }
  await update($, agents, () => folded)
  return true
}

/** Merges the engine's agent list: names, types, parents and status. */
const syncAgents = async ($: EngineInterface): Promise<void> => {
  const infos = await $.agent.list()
  if (await writeAgents($, (list, now) => mergeAgentList(list, infos, now))) {
    await refreshPulse($)
  }
}

/** One list read at a time waits in line. */
const queueSync = ($: EngineInterface): void => {
  if (isAgentSyncQueued) {
    return
  }
  isAgentSyncQueued = true
  queueAgents(async () => {
    isAgentSyncQueued = false
    await syncAgents($)
  })
}

/** Reads the agent list while an agent works or the Agents tab is open; not while paused. */
const pollAgents = async ($: EngineInterface): Promise<void> => {
  if (!isSamplerWanted) {
    return
  }
  const [list, state] = await Promise.all([read($, agents), read($, ui)])
  if (list.some(record => isLive(record.status))) {
    // An agent whose end is never reported is marked done once it goes quiet.
    queueAgents(async () => {
      if (await writeAgents($, (current, now) => settleOrphans(current, now))) {
        await refreshPulse($)
      }
    })
  }
  if (state.tab === 'agents' || list.some(record => isLive(record.status))) {
    queueSync($)
  }
}

/** A model request inside an agent's loop; an agent seen for the first time is looked up. */
const agentStepped = async ($: EngineInterface, agentId: string, step: StepFacts): Promise<void> => {
  const wasLive = (await read($, agents)).some(record => record.id === agentId && isLive(record.status))
  await writeAgents($, (list, now) => recordAgentStep(list, agentId, step, now))
  if (!wasLive) {
    await refreshPulse($)
    queueSync($)
  }
}

const agentTurnEnded = async ($: EngineInterface, agentId: string, turn: TurnFacts): Promise<void> => {
  if (await writeAgents($, (list, now) => recordAgentTurn(list, agentId, turn, now))) {
    await refreshPulse($)
  }
}

type AgentCallFacts = { toolUseId: string; tool: string; input: Readonly<Record<string, unknown>>; agentId?: string }

/** A tool call began: one more inside its agent, and a Workflow call's run gets its row. */
const agentCallStarted = async ($: EngineInterface, call: AgentCallFacts): Promise<void> => {
  const isWorkflow = call.tool === 'Workflow'
  const agentId = call.agentId
  if (agentId === undefined && !isWorkflow) {
    return
  }
  await writeAgents($, (list, now) => {
    const counted = agentId === undefined ? [...list] : recordAgentToolCall(list, agentId, now, summarizeCall(call.tool, call.input))
    if (!isWorkflow) {
      return counted
    }
    const launch = {
      toolUseId: call.toolUseId,
      parentId: agentId,
      name: textField(call.input, 'name'),
      script: textField(call.input, 'script'),
      scriptPath: textField(call.input, 'scriptPath'),
    }
    return launchWorkflow(counted, launch, now)
  })
  if (isWorkflow) {
    await refreshPulse($)
  }
}

/** An Agent, Workflow or TaskStop call answered: what it started, finished or stopped. */
const agentCallEnded = async ($: EngineInterface, call: AgentCallFacts, result: ToolCallResult): Promise<void> => {
  const isError = result.deny !== undefined || result.isError === true
  const value: unknown = result.deny === undefined ? result.result : undefined
  const inside = call.agentId
  if (inside !== undefined) {
    const status = result.deny !== undefined ? 'denied' : isError ? 'error' : 'ok'
    await writeAgents($, (list, now) => recordAgentToolEnd(list, inside, call.tool, status, now))
  }
  if (call.tool === 'Workflow') {
    await writeAgents($, (list, now) => settleWorkflow(list, call.toolUseId, readWorkflowResult(value, isError), now))
  } else if (call.tool === 'Agent' || call.tool === 'Task') {
    const facts = {
      toolUseId: call.toolUseId,
      description: textField(call.input, 'description'),
      subagentType: textField(call.input, 'subagent_type'),
      parentId: call.agentId,
      isError,
    }
    await writeAgents($, (list, now) => settleAgentCall(list, facts, readAgentResult(value), now))
    queueSync($)
  } else if (call.tool === 'TaskStop' && !isError) {
    const taskId = textField(call.input, 'task_id') ?? textField(call.input, 'shell_id') ?? textField(value, 'task_id')
    if (taskId === undefined) {
      return
    }
    await writeAgents($, (list, now) => stopTask(list, taskId, now))
  } else {
    return
  }
  await refreshPulse($)
}

const agentSpawned = async ($: EngineInterface, spawn: SpawnFacts): Promise<void> => {
  if (await writeAgents($, (list, now) => recordSpawn(list, spawn, now))) {
    await refreshPulse($)
  }
}

/** The background tasks still in flight when the main loop stopped. */
const agentTasksSettled = async ($: EngineInterface, tasks: readonly TaskSnapshot[]): Promise<void> => {
  if (await writeAgents($, (list, now) => reconcileTasks(list, tasks, now))) {
    await refreshPulse($)
  }
}

/** The parents whose children's cards are shown, with `id` shown or not. */
const withShown = (shown: readonly string[] | undefined, id: string, isShown: boolean): string[] => {
  const rest = (shown ?? []).filter(one => one !== id)
  return isShown ? [...rest, id].slice(-200) : rest
}

/** A click on an Agents row: open or close its details; a parent's opening shows its children's cards too, and its closing folds them away. */
const toggleAgentRow = async ($: EngineInterface, id: string): Promise<void> => {
  if (await isBounce($, `agent:${id}`)) {
    return
  }
  // --- session history ---
  // One of this session's agents pressed while a past session is shown (Overview's live card): this session again.
  const past = await viewedOf($)
  const isLiveAgent = past !== null && !past.agents.some(one => one.id === id) && !shellRecords(past.commands).some(one => one.id === id)
  // --- end session history ---
  const [agentList, commandList] = past !== null && !isLiveAgent ? [past.agents, past.commands] : await Promise.all([read($, agents), read($, commands)])
  const isParent = [...agentList, ...shellRecords(commandList)].some(one => one.parentId === id && one.id !== id)
  const after = await update($, ui, (current): UiState => {
    const isOpening = current.expandedAgent !== id
    return {
      ...current,
      tab: 'agents',
      expandedAgent: isOpening ? id : null,
      agentCallsFrom: 0,
      ...(isParent ? { shownAgents: withShown(current.shownAgents, id, isOpening) } : {}),
      ...(isLiveAgent ? { viewedSession: null, promptsFrom: 0 } : {}), // --- session history ---
    }
  })
  if (after.expandedAgent === id) {
    detach(loadAgentHistory($, id))
  }
}

/**
 * An agent's card opened: its calls read from its own transcript (a
 * workflow's, its agents'), those the monitor's list does not hold kept for
 * the card, their outputs with them. The agents are the session's shown: a
 * past session's while one is.
 */
const loadAgentHistory = async ($: EngineInterface, id: string): Promise<void> => {
  const past = await viewedOf($)
  const [agentList, held, sessionId, project] = await Promise.all([
    past !== null ? past.agents : read($, agents),
    past !== null ? past.commands : read($, commands),
    past !== null ? past.id : $.session.id(),
    projectOf($),
  ])
  const record = agentList.find(one => one.id === id)
  const owners = record === undefined ? [] : ownersOf(record, agentList).filter(owner => AGENT_ID.test(owner))
  if (owners.length === 0 || project === '') {
    await update($, agentHistory, (): AgentHistory => ({ ...NO_HISTORY, agentId: id }))
    return
  }
  await update($, agentHistory, (): AgentHistory => ({ agentId: id, state: 'loading', calls: [] }))
  const found = parseAgents(await runTranscripts($, ['agents', project, sessionId, ...owners]))
  const ids = new Set(held.map(call => call.id))
  const calls = (found ?? []).flatMap(commandsOfAgent).filter(call => !ids.has(call.id))
  for (const agent of found ?? []) {
    for (const call of agent.calls) {
      if (!ids.has(call.id) && call.output !== '') {
        // Cleaned as a live call's output is: a control character in a Code's source makes the engine refuse the whole pane.
        await $.state.set({ ...output, id: call.id }, clipOutput(call.output))
      }
    }
  }
  // Only while this agent's card is still the one waiting for it.
  await update($, agentHistory, (current): AgentHistory => (current.agentId === id ? { agentId: id, state: found === undefined ? 'failed' : 'done', calls } : current))
}

/** The agent id an Agents row posted (view/row.tsx), when the message is one. */
const readAgentPress = (data: unknown): string | undefined =>
  isRecord(data) && data.kind === 'agent' && typeof data.id === 'string' ? data.id : undefined
// --- end agents ---

// ------------------------------------------------------------------------- //
// Battery and the header summary
// ------------------------------------------------------------------------- //

const sessionEnergy = async ($: EngineInterface): Promise<number> => {
  const metrics = liveBuffer ?? (await read($, live))
  return metrics.session.energyJ + metrics.session.energyEstJ
}

const readBattery = async ($: EngineInterface): Promise<BatteryReading | null> => {
  if (await onWindows($)) {
    return null // the battery's registers are read from macOS's ioreg
  }
  const result = await runner($)(['ioreg', '-r', '-c', 'AppleSmartBattery'])
  if (result.exitCode !== 0) {
    return null
  }
  return parseIoreg(result.stdout, await $.clock.now(), await sessionEnergy($))
}

/** The latest reading; the session's first one is kept as the battery before the work. */
const refreshBattery = async ($: EngineInterface): Promise<void> => {
  const reading = await readBattery($)
  const now = await $.clock.now()
  await update($, battery, (current): BatteryView =>
    reading === null
      ? { ...current, hasBattery: false, checkedAt: now }
      : { ...current, hasBattery: true, start: current.start ?? reading, latest: reading, checkedAt: now, history: addBatteryPoint(current.history, reading) },
  )
}

const beginTurnBattery = async ($: EngineInterface, turnId: string, prompt: string): Promise<void> => {
  const reading = await readBattery($)
  if (reading === null) {
    return
  }
  const step = lastStep.get('')
  await update($, battery, (current): BatteryView => ({
    ...current,
    hasBattery: true,
    start: current.start ?? reading,
    latest: reading,
    checkedAt: reading.t,
    history: addBatteryPoint(current.history, reading),
    turns: [
      ...current.turns.filter(turn => turn.turnId !== turnId),
      { turnId, prompt: oneLine(prompt, 200), model: step?.model, effort: step?.effort, start: reading },
    ].slice(-MAX_TURN_BATTERY),
  }))
}

const endTurnBattery = async ($: EngineInterface, turnId: string): Promise<void> => {
  const reading = await readBattery($)
  if (reading === null) {
    return
  }
  await update($, battery, (current): BatteryView => ({
    ...current,
    latest: reading,
    checkedAt: reading.t,
    history: addBatteryPoint(current.history, reading),
    turns: current.turns.map(turn => (turn.turnId === turnId ? { ...turn, end: reading } : turn)),
  }))
}

/** Writes the header summary when one of its figures changed. */
const refreshPulse = async ($: EngineInterface): Promise<void> => {
  const [metrics, figures, list, view, files, found, power, now] = await Promise.all([
    read($, live),
    read($, usage),
    read($, commands),
    read($, git),
    read($, touched),
    read($, sources),
    read($, battery),
    $.clock.now(),
  ])
  const current = liveBuffer ?? metrics
  const changes = sessionChanges(view.commits, view.worktree)
  const changeTotals = summarize(changes)
  // --- agents ---
  const agentFigures = agentCounts(await read($, agents), list, now)
  // --- end agents ---
  const value: Pulse = {
    t: now,
    status: isSamplerWanted ? current.status : 'paused',
    netIn: current.session.netIn,
    netOut: current.session.netOut,
    costUsd: figures.costUsd,
    contextPct: figures.contextPct,
    commands: list.length,
    running: list.filter(record => record.status === 'running' || record.status === 'background').length,
    failed: list.filter(record => record.status === 'error').length,
    files: fileRows(files, view.worktree, view.root, view.updatedAt).length,
    sources: summarizeSources(found).urls,
    prompts: (await read($, prompts)).length,
    commits: view.commits.filter(commit => commit.isSession).length,
    changed: changes.length,
    plus: changeTotals.plus,
    minus: changeTotals.minus,
    batteryPct: power.latest?.percent,
    isCharging: power.latest === null ? undefined : power.latest.isCharging || power.latest.isExternal,
    ...agentFigures, // --- agents ---
  }
  const fingerprint = pulseKey(value)
  if (fingerprint !== lastPulse) {
    lastPulse = fingerprint
    await update($, pulse, () => value)
  }
}

// --- file tree ---
// ------------------------------------------------------------------------- //
// The Files tab's folder tree: `sampler/tree.py` lists one folder at a time
// ------------------------------------------------------------------------- //

/** After a tool call that may change files, the tree lists its open folders again this much later. */
const TREE_REFRESH_MS = 2_000
/** Folders being listed now: a second request for one while it runs is dropped. */
const treeBusy = new Set<string>()
let treeTimer: { cancel: () => void } | undefined

/** The session's working folder, the tree's root; the repository's root when the session cannot say. */
const treeRootOf = async ($: EngineInterface): Promise<string> => {
  try {
    const cwd = toPosixPath(await $.session.cwd())
    if (isAbsolutePath(cwd)) {
      return cwd
    }
  } catch {
    // Falls back below.
  }
  return (await read($, git)).root
}

/** Lists one folder of the tree with `sampler/tree.py` and keeps what came back (or why nothing did). */
const listTreeFolder = async ($: EngineInterface, dir: string): Promise<void> => {
  const view = await read($, folderTree)
  if (!isInsideRoot(view.root, dir) || !isWanted(view, dir) || treeBusy.has(dir)) {
    return
  }
  treeBusy.add(dir)
  let parsed: ParsedListing
  try {
    await update($, folderTree, current => setLoading(current, dir, true))
    const argv = treeArgv(await pythonPath($), `${$.plugin.root}/${TREE_SCRIPT}`, view.root, dir)
    const result = await runner($)(argv)
    parsed =
      result.exitCode === 0
        ? parseListing(result.stdout, dir, await $.clock.now())
        : { isOk: false, error: oneLine(result.stderr.trim() || `the lister exited with code ${result.exitCode}`, 300) }
  } catch (error) {
    parsed = { isOk: false, error: oneLine(errorText(error), 300) }
  } finally {
    treeBusy.delete(dir)
  }
  await update($, folderTree, current => (current.root === view.root ? withListing(current, dir, parsed) : setLoading(current, dir, false)))
}

/** Shows the folder tree, listing the working folder when it is not listed yet (or the session moved). */
const showTree = async ($: EngineInterface): Promise<void> => {
  const root = await treeRootOf($)
  const view = await update($, folderTree, (current): typeof current => ({ ...forRoot(current, root), mode: 'folder' }))
  if (root !== '' && view.listings[root] === undefined) {
    await listTreeFolder($, root)
  }
}

const setFilesMode = async ($: EngineInterface, mode: FilesMode): Promise<void> => {
  if (mode === 'folder') {
    await showTree($)
  } else {
    await update($, folderTree, (current): typeof current => ({ ...current, mode }))
  }
}

/** Lists the root and every open folder again, parents first; an open folder that is gone closes. */
const refreshTree = async ($: EngineInterface): Promise<void> => {
  const root = await treeRootOf($)
  const view = await update($, folderTree, current => forRoot(current, root))
  for (const dir of listedFolders(view)) {
    await listTreeFolder($, dir)
  }
  await update($, folderTree, current =>
    Object.entries(current.errors).reduce(
      (out, [dir, error]) => (dir !== out.root && /no such file/i.test(error) ? collapse(out, dir) : out),
      current,
    ),
  )
}

/** After a tool call that may have changed files: the tree, while on screen, lists its folders again. */
const scheduleTree = ($: EngineInterface): void => {
  treeTimer?.cancel()
  treeTimer = $.clock.after(TREE_REFRESH_MS, () => {
    treeTimer = undefined
    detach((async () => {
      const [state, view] = await Promise.all([read($, ui), read($, folderTree)])
      if (isSamplerWanted && state.tab === 'files' && view.mode === 'folder' && view.root !== '') {
        await refreshTree($)
      }
      // --- explorer ---
      if (isSamplerWanted) {
        await refreshExplorerIfShown($)
      }
      // --- end explorer ---
    })())
  })
}

/**
 * Why an entry's text is not read: anything but a regular file, or a link to
 * one (reading a named pipe or a device would wait for ever). Undefined to read it.
 */
const unreadableReason = async ($: EngineInterface, view: TreeView, path: string): Promise<string | undefined> => {
  const entry = findEntry(view, path)
  const name = oneLine(baseName(path), 80)
  if (entry === undefined) {
    return `${name} is no longer listed; press Refresh.`
  }
  if (entry.kind === 'file') {
    return undefined
  }
  if (entry.kind === 'link') {
    const target = await $.fs.stat(path).catch(() => undefined)
    if (target?.kind === 'file') {
      return undefined
    }
    const leads = target === undefined ? 'nothing (a broken link)' : target.kind === 'dir' ? 'a folder' : 'no regular file'
    return `${name} ↪ ${oneLine(entry.linkTarget ?? '?', 80)} leads to ${leads}.`
  }
  return `${name} is not a regular file (${entry.mode}): nothing to show as text.`
}

/** A tree row's press: a folder opens or closes, a file shows or hides its text, a hidden group opens or closes. */
const pressTreeRow = async ($: EngineInterface, press: TreePress): Promise<void> => {
  const view = await read($, folderTree)
  // The root is no row of its own: only its hidden group is pressed by its path.
  if (!isInsideRoot(view.root, press.path) || (press.path === view.root && press.kind !== 'hidden')) {
    return
  }
  if (press.kind === 'entry') {
    const key = `FILE\u0000${press.path}`
    const reason = (await read($, diff))?.key === key ? undefined : await unreadableReason($, view, press.path)
    if (reason !== undefined) {
      if (!(await isBounce($, key))) {
        $.ui.toast(reason, { timeoutMs: 5_000 })
      }
      return
    }
    await toggleFile($, key, async () => openContent($, press.path))
    return
  }
  if (await isBounce($, `${press.kind}:${press.path}`)) {
    return
  }
  if (press.kind === 'hidden') {
    await update($, folderTree, current => toggleHidden(current, press.path))
  } else if (view.expanded.includes(press.path)) {
    await update($, folderTree, current => collapse(current, press.path))
  } else {
    await update($, folderTree, current => expand(current, press.path))
    await listTreeFolder($, press.path)
  }
}

/** `open <path>` (its app; Finder for a folder), or `open -R <path>` (Finder, the entry selected). */
const openTreePath = async ($: EngineInterface, path: string, isReveal: boolean): Promise<void> => {
  await openPathIn($, (await read($, folderTree)).root, path, isReveal)
}

/**
 * `open` for a path inside `root` only (the Files tab's tree and the Explorer
 * each pass their own): code and text files in Cursor, web pages in Chrome,
 * the rest in the app macOS picks (lib/apps.ts), a folder in Finder; with
 * `isReveal`, Finder with it selected. Where the chosen app cannot open it
 * (not installed), the app macOS picks does instead.
 */
const openPathIn = async ($: EngineInterface, root: string, path: string, isReveal: boolean): Promise<void> => {
  if (!isInsideRoot(root, path)) {
    $.ui.toast('Only entries inside the working folder open from here.', { timeoutMs: 4_000 })
    return
  }
  const isFolder = !isReveal && (await $.fs.stat(path).catch(() => undefined))?.kind === 'dir'
  const isWindows = isWindowsPath(path)
  const argv = isWindows ? windowsOpenArgv(path, isReveal, isFolder) : openArgv(path, isReveal, isFolder)
  let result = await runner($)(argv)
  const chosen = chosenApp(argv)
  if (!isOpenOk(argv, result.exitCode) && chosen !== undefined) {
    const fallbackArgv = isWindows ? windowsDefaultArgv(path) : ['open', path]
    const fallback = await runner($)(fallbackArgv)
    if (isOpenOk(fallbackArgv, fallback.exitCode)) {
      const reason = oneLine(result.stderr.trim() || `exit code ${result.exitCode}`, 120)
      $.ui.toast(`${chosen} could not open ${oneLine(baseName(path), 80)} (${reason}): opened it in its default app.`, { timeoutMs: 6_000 })
      return
    }
    result = fallback
  }
  if (!isOpenOk(argv, result.exitCode)) {
    const reason = oneLine(result.stderr.trim() || `exit code ${result.exitCode}`, 160)
    $.ui.toast(`Could not ${isReveal ? 'reveal' : 'open'} ${oneLine(baseName(path), 80)}: ${reason}`, { timeoutMs: 6_000 })
  }
}

// --- end file tree ---

// --- explorer ---
// ------------------------------------------------------------------------- //
// The Explorer tab: the project folder as an editor's tree, listed with
// `$.fs.list` a folder at a time (git says what it ignores), and the entries
// made, renamed, edited and moved to the Trash from it. Every change stays
// inside the project folder: by its spelling, and where it lands once links
// are followed.
// ------------------------------------------------------------------------- //

/** Folders being listed now: a second request for one while it runs is dropped. */
const explorerBusy = new Set<string>()
let isExplorerStarting = false
/** What is typed in the form and the editor, kept outside the state so a keystroke does not redraw the pane. */
let explorerFormText = ''
let explorerEditText: { path: string; text: string } | undefined
/** The engine draws fields of several lines, so files are edited in the pane (lib/explorer.ts MULTILINE_SINCE); read at the session's start. */
let canEditInPane = false

const explorerToast = ($: EngineInterface, text: string, timeoutMs = 5_000): void => {
  $.ui.toast(text, { timeoutMs })
}

/** The names among `names` that git ignores in folder `dir`; none outside a repository, or when git cannot say. */
const ignoredIn = async ($: EngineInterface, dir: string, names: readonly string[]): Promise<string[]> => {
  if (names.length === 0) {
    return []
  }
  try {
    const result = await $.process.run(ignoreArgv(dir), { stdin: names.join('\u0000'), timeoutMs: 10_000 })
    return result.exitCode === 0 ? ignoredNames(result.stdout, names) : []
  } catch {
    return []
  }
}

/** Lists one folder of the Explorer and keeps what came back (or why nothing did), with what git ignores in it. */
const listExplorerFolder = async ($: EngineInterface, dir: string): Promise<void> => {
  const view = await read($, explorer)
  const root = view.tree.root
  if (!isInsideRoot(root, dir) || !isWanted(view.tree, dir) || explorerBusy.has(dir)) {
    return
  }
  explorerBusy.add(dir)
  let parsed: ParsedListing
  let ignored: string[] = []
  try {
    await update($, explorer, current => ({ ...current, tree: setLoading(current.tree, dir, true) }))
    const listing = listingOf(dir, await $.fs.list(dir), await $.clock.now())
    ignored = await ignoredIn($, dir, listing.entries.map(entry => entry.name))
    parsed = { isOk: true, listing }
  } catch (error) {
    parsed = { isOk: false, error: oneLine(errorText(error), 300) }
  } finally {
    explorerBusy.delete(dir)
  }
  await update($, explorer, (current): ExplorerView => {
    if (current.tree.root !== root) {
      return { ...current, tree: setLoading(current.tree, dir, false) }
    }
    const tree = withListing(current.tree, dir, parsed)
    const isKept = parsed.isOk && tree.listings[dir] !== undefined
    return { ...current, tree, ignored: isKept ? { ...current.ignored, [dir]: ignored } : current.ignored }
  })
}

/** The Explorer for the session's folder: its root listed when it is not yet, or the session moved. */
const showExplorer = async ($: EngineInterface): Promise<void> => {
  if (isExplorerStarting) {
    return
  }
  isExplorerStarting = true
  try {
    const root = await treeRootOf($)
    const view = await update($, explorer, current => explorerFor(current, root))
    if (root !== '' && view.tree.listings[root] === undefined) {
      await listExplorerFolder($, root)
    }
  } finally {
    isExplorerStarting = false
  }
}

/** Lists the root and every open folder again, parents first: a folder gone since closes, a selection gone since clears. */
const refreshExplorer = async ($: EngineInterface): Promise<void> => {
  const root = await treeRootOf($)
  const view = await update($, explorer, current => explorerFor(current, root))
  for (const dir of listedFolders(view.tree)) {
    await listExplorerFolder($, dir)
  }
  await update($, explorer, (current): ExplorerView => {
    const gone = Object.entries(current.tree.errors).filter(([dir, error]) => dir !== current.tree.root && /no such file|ENOENT/i.test(error))
    const tree = gone.reduce((out, [dir]) => collapse(out, dir), current.tree)
    const selected = current.selected
    const isSelectionGone = selected !== null && tree.listings[parentOf(selected)] !== undefined && findEntry(tree, selected) === undefined
    return { ...current, tree, selected: isSelectionGone ? null : selected }
  })
}

/**
 * Whether `path`, or the nearest folder above it that exists, lands inside
 * the project folder once links are followed: a link out of it is refused.
 * Where the file system cannot resolve a path, its spelling (checked by the
 * caller) stands.
 */
const landsInside = async ($: EngineInterface, root: string, path: string): Promise<boolean> => {
  let at = path
  while (at !== root && isInsideRoot(root, at) && !(await $.fs.exists(at))) {
    at = parentOf(at)
  }
  if (!isInsideRoot(root, at)) {
    return false
  }
  const real = async (one: string): Promise<string | undefined> => (await $.fs.stat(one, { resolve: true }).catch(() => undefined))?.realPath
  const [realRoot, realAt] = await Promise.all([real(root), real(at)])
  if (realRoot === undefined || realAt === undefined) {
    return true
  }
  return realAt === realRoot || realAt.startsWith(`${realRoot === '/' ? '' : realRoot}/`)
}

/** Why a file's text is not shown: anything but a regular file, or a link to one (a named pipe would wait for ever). */
const explorerUnreadable = async ($: EngineInterface, view: ExplorerView, path: string): Promise<string | undefined> => {
  const entry = findEntry(view.tree, path)
  const name = oneLine(baseName(path), 80)
  if (entry === undefined) {
    return `${name} is no longer listed: press Refresh.`
  }
  if (entry.kind === 'file') {
    return undefined
  }
  if (entry.kind === 'link') {
    const target = await $.fs.stat(path).catch(() => undefined)
    if (target?.kind === 'file') {
      return undefined
    }
    return `${name} is a link to ${target === undefined ? 'nothing (it is broken)' : target.kind === 'dir' ? 'a folder' : 'no regular file'}: nothing to show as text.`
  }
  return `${name} is not a regular file: nothing to show as text.`
}

/** Moves the focus ring onto a field the next drawing brings, where the surface has one; a click focuses it otherwise. */
const focusField = async ($: EngineInterface, key: string): Promise<void> => {
  try {
    await $.ui.focus({ requestId: PANE, key })
  } catch {
    // No ring to move here: the field takes the focus from a click.
  }
}

/** Whether the editor holds typing not saved yet. */
const isEditDirty = (edit: ExplorerView['edit']): boolean =>
  edit !== null && explorerEditText !== undefined && explorerEditText.path === edit.path && explorerEditText.text !== toField(edit.text)

/** An open preview of `path`, or of anything below it, closes: its key names a path that is gone. */
const closePreviewOf = async ($: EngineInterface, path: string): Promise<void> => {
  await update($, diff, current => (current !== null && current.kind === 'content' && (current.path === path || isBelow(path, current.path)) ? null : current))
}

/** A row's press: a folder opens or closes, a file shows its text; either is selected. A selected file's second press hides it. */
const pressExplorerRow = async ($: EngineInterface, press: ExplorerPress): Promise<void> => {
  const view = await read($, explorer)
  const root = view.tree.root
  if (press.path === root || !isInsideRoot(root, press.path) || (await isBounce($, `xp:${press.kind}:${press.path}`))) {
    return
  }
  if (press.kind === 'xdir') {
    const isOpen = view.tree.expanded.includes(press.path)
    await update($, explorer, (current): ExplorerView => {
      const selected = withSelected(current, press.path)
      return { ...selected, tree: isOpen ? collapse(selected.tree, press.path) : expand(selected.tree, press.path) }
    })
    if (!isOpen) {
      await listExplorerFolder($, press.path)
    }
    return
  }
  const key = `FILE\u0000${press.path}`
  if (view.selected === press.path) {
    await update($, explorer, current => withSelected(current, null))
    await update($, diff, current => (current?.key === key && !current.isLoading ? null : current))
    return
  }
  await update($, explorer, current => withSelected(current, press.path))
  if (view.edit?.path === press.path) {
    return
  }
  const reason = await explorerUnreadable($, view, press.path)
  if (reason !== undefined) {
    explorerToast($, reason)
    return
  }
  await openContent($, press.path)
}

/** Opens a form: a new file or folder (its folder opened to take it), or a new name for an entry; the field takes the focus. */
const openExplorerForm = async ($: EngineInterface, form: ExplorerForm): Promise<void> => {
  const view = await read($, explorer)
  const root = view.tree.root
  const anchor = formAnchor(form)
  if (!isInsideRoot(root, anchor) || (form.kind === 'rename' && anchor === root)) {
    return
  }
  const isNewlyOpen = form.kind !== 'rename' && anchor !== root && !view.tree.expanded.includes(anchor)
  explorerFormText = form.kind === 'rename' ? baseName(form.path) : ''
  await update($, explorer, (current): ExplorerView => ({
    ...current,
    tree: isNewlyOpen ? expand(current.tree, anchor) : current.tree,
    form,
    armed: null,
  }))
  if (isNewlyOpen) {
    await listExplorerFolder($, anchor)
  }
  detach(focusField($, formFieldKey(form)))
}

/** New file or New folder: in `dir`, else where the selection says (lib/explorer.ts targetDir). */
const newExplorerEntry = async ($: EngineInterface, kind: 'file' | 'folder', dir?: string): Promise<void> => {
  if (await isBounce($, `xp:new:${kind}:${dir ?? ''}`)) {
    return
  }
  const view = await read($, explorer)
  if (view.tree.root === '') {
    return
  }
  await openExplorerForm($, { kind, dir: dir ?? targetDir(view) })
}

/** Makes the form's new file (opened in the editor, as an editor does) or folder, and the folders on its way. */
const createExplorerEntry = async ($: EngineInterface, view: ExplorerView, form: Extract<ExplorerForm, { kind: 'file' | 'folder' }>, typed: string): Promise<void> => {
  const root = view.tree.root
  const checked = newEntryPath(root, form.dir, typed)
  if (!checked.isOk) {
    explorerToast($, checked.reason)
    return
  }
  const path = checked.path
  const name = oneLine(relPath(root, path), 160)
  if (await $.fs.exists(path)) {
    explorerToast($, `${name} already exists.`)
    return
  }
  if (!(await landsInside($, root, path))) {
    explorerToast($, `${name} would land outside the project folder (through a link): nothing was made.`)
    return
  }
  try {
    if (form.kind === 'folder') {
      const made = await runner($)(['mkdir', '-p', path])
      if (made.exitCode !== 0) {
        throw new Error(made.stderr.trim() || `mkdir exited with code ${made.exitCode}`)
      }
    } else {
      await $.fs.write(path, '')
    }
  } catch (error) {
    explorerToast($, `Could not make ${name}: ${oneLine(errorText(error), 200)}`, 6_000)
    return
  }
  explorerFormText = ''
  const folders = foldersDown(form.dir, path)
  await update($, explorer, (current): ExplorerView => ({
    ...current,
    tree: folders.reduce((tree, dir) => (dir === root ? tree : expand(tree, dir)), current.tree),
    form: null,
    armed: null,
    selected: path,
  }))
  for (const dir of folders) {
    await listExplorerFolder($, dir)
  }
  scheduleGit($, 400)
  explorerToast($, `Made ${name}.`, 2_500)
  if (form.kind === 'file' && canEditInPane) {
    await startExplorerEdit($, path)
  }
}

/** Renames an entry within its folder; never over another entry. Open folders, the selection and the editor follow it. */
const renameExplorerEntry = async ($: EngineInterface, view: ExplorerView, from: string, typed: string): Promise<void> => {
  const root = view.tree.root
  const checked = renamedPath(root, from, typed)
  if (!checked.isOk) {
    if (checked.reason === '') {
      await update($, explorer, current => ({ ...current, form: null }))
    } else {
      explorerToast($, checked.reason)
    }
    return
  }
  const to = checked.path
  const isCase = isCaseOnly(from, to)
  if (!isCase && (await $.fs.exists(to))) {
    explorerToast($, `${oneLine(baseName(to), 120)} already exists in ${oneLine(relPath(root, parentOf(to)), 160)}.`)
    return
  }
  if (!(await landsInside($, root, parentOf(from)))) {
    explorerToast($, `${oneLine(baseName(from), 120)} lies outside the project folder (through a link): nothing was renamed.`)
    return
  }
  // `mv -n` never writes over an entry, but on a case-only rename it does nothing at all: the new name is the old file.
  const moved = await runner($)(isCase ? ['mv', from, to] : ['mv', '-n', from, to])
  const isMoved = moved.exitCode === 0 && (await $.fs.exists(to)) && (isCase || !(await $.fs.exists(from)))
  if (!isMoved) {
    const reason = moved.exitCode === 0 ? 'nothing was renamed' : oneLine(moved.stderr.trim() || `mv exited with code ${moved.exitCode}`, 200)
    explorerToast($, `Could not rename ${oneLine(baseName(from), 120)}: ${reason}`, 6_000)
    return
  }
  explorerFormText = ''
  if (explorerEditText !== undefined) {
    explorerEditText = { ...explorerEditText, path: movedPath(explorerEditText.path, from, to) }
  }
  await update($, explorer, current => withRenamed(current, from, to))
  await closePreviewOf($, from)
  await refreshExplorer($)
  scheduleGit($, 400)
  explorerToast($, `Renamed ${oneLine(baseName(from), 120)} to ${oneLine(baseName(to), 120)}.`, 2_500)
}

/** The form's Enter or button: creates or renames with what was typed. */
const submitExplorerForm = async ($: EngineInterface, typed?: string): Promise<void> => {
  if (await isBounce($, 'xp:submit')) {
    return
  }
  const view = await read($, explorer)
  const form = view.form
  if (form === null) {
    return
  }
  const text = typed ?? explorerFormText
  explorerFormText = text
  if (form.kind === 'rename') {
    await renameExplorerEntry($, view, form.path, text)
  } else {
    await createExplorerEntry($, view, form, text)
  }
}

const disarmExplorer = async ($: EngineInterface, key: string, at: number): Promise<void> => {
  await update($, explorer, current => (current.armed !== null && current.armed.key === key && current.armed.at === at ? { ...current, armed: null } : current))
}

/** A two-press button's press: arms it (disarmed again after EXPLORER_ARM_MS) and says whether this press acts. */
const confirmExplorer = async ($: EngineInterface, key: string): Promise<boolean> => {
  const [view, now] = await Promise.all([read($, explorer), $.clock.now()])
  const step = armStep(view.armed, key, now)
  await update($, explorer, current => ({ ...current, armed: step.armed }))
  if (!step.isConfirmed) {
    $.clock.after(EXPLORER_ARM_MS, () => {
      detach(disarmExplorer($, key, now))
    })
  }
  return step.isConfirmed
}

/** Moves an entry to the Finder's Trash: Apple's `trash`, else the Finder itself. */
const trashEntry = async ($: EngineInterface, path: string): Promise<{ isOk: true } | { isOk: false; reason: string }> => {
  if (isWindowsPath(path)) {
    const recycled = await runner($)(windowsTrashArgv(path))
    return recycled.exitCode === 0 ? { isOk: true } : { isOk: false, reason: oneLine(recycled.stderr.trim() || `exit code ${recycled.exitCode}`, 200) }
  }
  const argv = (await $.fs.exists(TRASH_PATH))
    ? [TRASH_PATH, path]
    : ['osascript', '-e', 'on run argv', '-e', 'set target to POSIX file (item 1 of argv)', '-e', 'tell application "Finder" to delete target', '-e', 'end run', path]
  const result = await runner($)(argv)
  return result.exitCode === 0 ? { isOk: true } : { isOk: false, reason: oneLine(trashReason(result.stderr, result.exitCode), 200) }
}

/** Delete: the first press arms it; a second within EXPLORER_ARM_MS moves the entry to the Trash. */
const deleteExplorerEntry = async ($: EngineInterface, path: string): Promise<void> => {
  if (await isBounce($, `xp:delete:${path}`)) {
    return
  }
  const root = (await read($, explorer)).tree.root
  if (path === root || !isInsideRoot(root, path) || !(await confirmExplorer($, deleteKey(path)))) {
    return
  }
  const name = oneLine(relPath(root, path), 160)
  if (!(await landsInside($, root, parentOf(path)))) {
    explorerToast($, `${name} lies outside the project folder (through a link): nothing was deleted.`)
    return
  }
  const trashed = await trashEntry($, path)
  if (!trashed.isOk) {
    explorerToast($, `Could not delete ${name}: ${trashed.reason}`, 6_000)
    return
  }
  if (explorerEditText !== undefined && (explorerEditText.path === path || isBelow(path, explorerEditText.path))) {
    explorerEditText = undefined
  }
  await update($, explorer, current => withRemoved(current, path))
  await closePreviewOf($, path)
  await listExplorerFolder($, parentOf(path))
  scheduleGit($, 400)
  explorerToast($, `Moved ${name} to the Trash.`, 4_000)
}

/** Opens a file's text in the editor: a regular text file inside the project folder, small enough for a field. */
const startExplorerEdit = async ($: EngineInterface, path: string): Promise<void> => {
  const view = await read($, explorer)
  const root = view.tree.root
  const name = oneLine(baseName(path), 120)
  if (path === root || !isInsideRoot(root, path)) {
    return
  }
  if (!canEditInPane) {
    explorerToast($, `Editing here needs Claude Code 2.1.308 or later: ${openLabel(path)} edits ${name}.`)
    return
  }
  if (view.edit !== null && view.edit.path !== path && isEditDirty(view.edit)) {
    explorerToast($, `${oneLine(baseName(view.edit.path), 120)} has unsaved changes: save or close it first.`)
    return
  }
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat === undefined) {
    explorerToast($, `${name} no longer exists.`)
    return
  }
  if (stat.kind !== 'file') {
    explorerToast($, `${name} is not a file: nothing to edit.`)
    return
  }
  if (!(await landsInside($, root, path))) {
    explorerToast($, `${name} leads outside the project folder: ${openLabel(path)} edits it.`)
    return
  }
  let text: string
  try {
    const sized = uneditableReason(name, stat.size)
    if (sized !== undefined) {
      explorerToast($, sized, 6_000)
      return
    }
    text = await $.fs.read(path)
  } catch (error) {
    explorerToast($, `Could not read ${name}: ${oneLine(errorText(error), 200)}`, 6_000)
    return
  }
  const reason = uneditableReason(name, stat.size, text)
  if (reason !== undefined) {
    explorerToast($, reason, 6_000)
    return
  }
  explorerEditText = undefined
  await update($, explorer, (current): ExplorerView => ({ ...current, edit: { path, text, mtimeMs: stat.mtimeMs, isStale: false }, selected: path, form: null, armed: null }))
  // The editor shows the text now, in place of the preview.
  await update($, diff, current => (current?.key === `FILE\u0000${path}` ? null : current))
  detach(focusField($, editorFieldKey(path)))
}

/** Writes the editor's text. A file changed on disk since it was loaded is written over only on a second Save. */
const saveExplorerEdit = async ($: EngineInterface, typed?: string): Promise<void> => {
  if (typed !== undefined) {
    const edit = (await read($, explorer)).edit
    if (edit !== null) {
      explorerEditText = { path: edit.path, text: typed }
    }
  }
  if (await isBounce($, 'xp:save')) {
    return
  }
  const edit = (await read($, explorer)).edit
  if (edit === null) {
    return
  }
  const name = oneLine(baseName(edit.path), 120)
  const field = explorerEditText?.path === edit.path ? explorerEditText.text : toField(edit.text)
  const text = fromField(field, edit.text)
  const before = await $.fs.stat(edit.path).catch(() => undefined)
  if ((before === undefined || before.mtimeMs !== edit.mtimeMs) && !edit.isStale) {
    await update($, explorer, current => (current.edit?.path === edit.path ? { ...current, edit: { ...current.edit, isStale: true } } : current))
    explorerToast($, before === undefined ? `${name} was deleted since you opened it: Save over it writes it again.` : `${name} changed on disk since you opened it: Save over it writes your text over that change.`, 6_000)
    return
  }
  try {
    await $.fs.write(edit.path, text)
  } catch (error) {
    explorerToast($, `Could not save ${name}: ${oneLine(errorText(error), 200)}`, 6_000)
    return
  }
  const after = await $.fs.stat(edit.path).catch(() => undefined)
  explorerEditText = { path: edit.path, text: field }
  await update($, explorer, (current): ExplorerView =>
    current.edit?.path === edit.path ? { ...current, edit: { path: edit.path, text, mtimeMs: after?.mtimeMs ?? edit.mtimeMs, isStale: false }, armed: null } : current,
  )
  explorerToast($, `Saved ${name}.`, 2_500)
  await listExplorerFolder($, parentOf(edit.path))
  scheduleGit($, 400)
}

/** Closes the editor; with unsaved changes, on a second press. Where the file is selected its text shows again. */
const closeExplorerEdit = async ($: EngineInterface): Promise<void> => {
  if (await isBounce($, 'xp:closeedit')) {
    return
  }
  const view = await read($, explorer)
  const edit = view.edit
  if (edit === null || (isEditDirty(edit) && !(await confirmExplorer($, discardKey(edit.path))))) {
    return
  }
  explorerEditText = undefined
  await update($, explorer, current => ({ ...current, edit: null, armed: null }))
  if (view.selected === edit.path) {
    await openContent($, edit.path)
  }
}

/** After a tool call that may have changed files: the Explorer, while on screen, lists its folders again. */
const refreshExplorerIfShown = async ($: EngineInterface): Promise<void> => {
  const [state, view] = await Promise.all([read($, ui), read($, explorer)])
  if (state.tab === 'explorer' && view.tree.root !== '') {
    await refreshExplorer($)
  }
}
// --- end explorer ---

/** Finder with a file the session sent you selected: only a path the Artifacts list holds. */
const revealArtifact = async ($: EngineInterface, id: string): Promise<void> => {
  const past = await viewedOf($) // --- session history --- a past session's sent files too
  const path = [...(past?.artifacts ?? []), ...(await read($, artifacts))].find(one => one.id === id && one.kind === 'file')?.path
  if (path === undefined || !(await $.fs.exists(path))) {
    $.ui.toast('That file is no longer there.', { timeoutMs: 4_000 })
    return
  }
  const revealArgv = isWindowsPath(path) ? windowsOpenArgv(path, true, false) : ['open', '-R', path]
  const result = await runner($)(revealArgv)
  if (!isOpenOk(revealArgv, result.exitCode)) {
    $.ui.toast(`Could not reveal ${oneLine(baseName(path), 80)}: ${oneLine(result.stderr.trim() || `exit code ${result.exitCode}`, 160)}`, { timeoutMs: 6_000 })
  }
}

// ------------------------------------------------------------------------- //
// The sampler
// ------------------------------------------------------------------------- //

const onTick = async ($: EngineInterface, tick: SamplerTick): Promise<void> => {
  tickCount += 1
  const isWriteTick = tickCount % LIVE_WRITE_TICKS === 0 || tickCount === 1
  const list = await read($, commands)
  const result = applyTickToCommands(list, tick)
  // Running commands' rates refresh on write ticks; an end, reaped CPU or a
  // new match lands at once, since the next tick would not repeat it.
  const isUrgent = tick.ended.length > 0 || tick.reaped.cpuS > 0
  if (result.changed && (isWriteTick || isUrgent)) {
    await update($, commands, current => applyTickToCommands(current, tick).commands)
  }
  liveBuffer = applyTickToLive(liveBuffer ?? (await read($, live)), tick, result.unclaimed)
  if (isWriteTick) {
    const snapshot = liveBuffer
    await update($, live, () => snapshot)
    await refreshStatus($)
  }
  await checkAlerts($, result.changed ? result.commands : list, tick.t)
}

// --- file tree ---
/** The Python the sampler and the folder lister run under: the first of PYTHONS there, else `python3`. */
const pythonPath = async ($: EngineInterface): Promise<string> => {
  for (const candidate of PYTHONS) {
    if (await $.fs.exists(candidate)) {
      return candidate
    }
  }
  // Windows has `python` (or the `py` launcher), not `python3`.
  return (await onWindows($)) ? 'python' : 'python3'
}
// --- end file tree ---

const runSampler = async ($: EngineInterface): Promise<void> => {
  if (isSamplerRunning || !isSamplerWanted) {
    return
  }
  isSamplerRunning = true
  const python = await pythonPath($)
  const script = `${$.plugin.root}/sampler/sampler.py`
  const buffer = new LineBuffer()
  let stderr = ''
  let isUnsupported = false
  try {
    for await (const chunk of $.process.spawn({ argv: [python, '-I', script] })) {
      if (!isSamplerWanted) {
        break
      }
      if (chunk.stream === 'stderr') {
        stderr = `${stderr}${chunk.text}`.slice(-2_000)
        continue
      }
      for (const line of buffer.push(chunk.text)) {
        const message = parseMessage(line)
        if (message === undefined) {
          continue
        }
        if (message.type === 'hello') {
          samplerAttempts = 0
          liveBuffer = undefined
          await update($, live, (current): LiveMetrics => ({
            ...current,
            status: 'starting',
            message: undefined,
            startedAt: current.startedAt > 0 ? current.startedAt : message.t,
          }))
        } else if (message.type === 'error') {
          isUnsupported = message.message.includes('macOS')
          stderr = message.message
        } else {
          await onTick($, message)
        }
      }
    }
  } catch (error) {
    stderr = stderr || errorText(error)
  } finally {
    isSamplerRunning = false
  }
  liveBuffer = undefined
  if (!isSamplerWanted) {
    await update($, live, (current): LiveMetrics => ({ ...current, status: 'paused', message: 'Live metrics are paused. Run /monitor on to resume.' }))
    $.ui.status(undefined)
    return
  }
  samplerAttempts += 1
  const willRetry = !isUnsupported && samplerAttempts < 5
  await update($, live, (current): LiveMetrics => ({
    ...current,
    status: isUnsupported ? 'unsupported' : 'error',
    message: `${isUnsupported ? 'Live metrics need macOS or Windows' : 'The metrics sampler stopped'}: ${oneLine(stderr || 'no output', 240)}${willRetry ? ' (restarting…)' : ''}`,
  }))
  // Its last figures are no longer live: dashes until it is back.
  await refreshStatus($)
  if (willRetry) {
    $.clock.after(3_000 * samplerAttempts, () => {
      detach(runSampler($))
    })
  }
}

/** `/monitor off`: stop sampling and polling in this session, close the pane and the status line. */
const pause = async ($: EngineInterface): Promise<void> => {
  isSamplerWanted = false
  await update($, ui, (current): UiState => ({ ...current, isPaused: true }))
  $.ui.status(undefined)
  await $.ui.close({ id: PANE })
}

/** `/monitor on`: sample again and open the pane. */
const resume = async ($: EngineInterface): Promise<void> => {
  isSamplerWanted = true
  samplerAttempts = 0
  await update($, ui, (current): UiState => ({ ...current, isPaused: false }))
  detach(runSampler($))
  detach(refreshGit($, true))
}

// ------------------------------------------------------------------------- //
// Tool calls
// ------------------------------------------------------------------------- //

const recordTouch = async ($: EngineInterface, path: string, event: TouchEvent, tool: string, now: number): Promise<void> => {
  await update($, touched, list => touch(list, path, event, tool, now))
}

const markDeletions = async ($: EngineInterface, now: number): Promise<void> => {
  const list = await read($, touched)
  for (const file of list.slice(-80)) {
    if (file.activity !== 'deleted' && !(await $.fs.exists(file.path))) {
      await recordTouch($, file.path, 'deleted', 'Bash', now)
    }
  }
}

type Started = { id: string; tool: string; input: Readonly<Record<string, unknown>>; startedAt: number; filePath?: string; didExist: boolean }

// --- sources by task ---
// ------------------------------------------------------------------------- //
// Tasks: the prompt or sub-agent each source is attributed to
// ------------------------------------------------------------------------- //

/** A main-loop turn began: its prompt's task opens, or the last prompt's reopens for a continuation. */
const openPromptTask = async ($: EngineInterface, taskId: string, text: string): Promise<void> => {
  const now = await $.clock.now()
  await update($, tasks, (list): TaskLabel[] =>
    list.some(one => one.id === taskId) ? reopenTask(list, taskId) : addTask(list, { id: taskId, kind: 'prompt', label: promptLabel(text), startedAt: now }),
  )
}

/** A turn ended: its task (a prompt's or a sub-agent's) is done. */
const closeTask = async ($: EngineInterface, taskId: string, model: string | undefined): Promise<void> => {
  const now = await $.clock.now()
  await update($, tasks, (list): TaskLabel[] => endTask(list, taskId, now, model))
}

const stringField = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

/** A sub-agent's call, the first seen: its task, labelled from the agent list where it can be. */
const ensureAgentTask = async ($: EngineInterface, agentId: string, startedAt: number): Promise<void> => {
  if (knownAgents.has(agentId)) {
    return
  }
  knownAgents.add(agentId)
  if ((await read($, tasks)).some(one => one.id === agentId)) {
    return
  }
  let info: AgentInfo | undefined
  try {
    info = (await $.agent.list()).find(one => one.id === agentId)
  } catch {
    info = undefined
  }
  const label = agentLabel(agentId, info?.description, info?.type)
  await update($, tasks, (list): TaskLabel[] => addTask(list, { id: agentId, kind: 'agent', label, startedAt }))
}

/** An Agent call names the sub-agent it ran: its task takes the call's own description and type. */
const labelAgentTask = async ($: EngineInterface, call: Started, result: ToolCallResult): Promise<void> => {
  const record = result.result
  if (!isRecord(record) || typeof record.agentId !== 'string') {
    return
  }
  const agentId = record.agentId
  const label = agentLabel(agentId, stringField(call.input.description), stringField(call.input.subagent_type) ?? stringField(record.agentType))
  knownAgents.add(agentId)
  await update($, tasks, (list): TaskLabel[] =>
    relabelTask(addTask(list, { id: agentId, kind: 'agent', label, startedAt: call.startedAt }), agentId, label),
  )
}

/** After a call: the sub-agent it ran in, and the one an Agent call started, each get their task. */
const noteTasks = async ($: EngineInterface, call: Started, result: ToolCallResult, agentId: string | undefined): Promise<void> => {
  if (agentId !== undefined) {
    await ensureAgentTask($, agentId, call.startedAt)
  }
  if (call.tool === 'Agent' && result.deny === undefined) {
    await labelAgentTask($, call, result)
  }
}
// --- end sources by task ---

const finish = async ($: EngineInterface, call: Started, result: ToolCallResult): Promise<void> => {
  const { id, tool } = call
  const end = await $.clock.now()
  const outcome: Outcome =
    result.deny !== undefined
      ? { isDenied: true, isError: false, isReadOnly: false, text: result.deny }
      : { isDenied: false, isError: result.isError === true, isReadOnly: result.isReadOnly === true, text: result.text ?? '' }
  const clipped = clipOutput(outcome.text)
  await $.state.set({ ...output, id }, tool === 'Bash' ? clipped : clipped.slice(0, NON_BASH_OUTPUT_CHARS))
  let finished: CommandRecord | undefined
  await update($, commands, list =>
    mapRecord(list, id, record => {
      finished = finishRecord(record, outcome, end)
      return finished
    }),
  )
  const isApplied = !outcome.isDenied && !outcome.isError
  const structured: unknown = result.deny === undefined ? result.result : undefined
  // --- sources by task ---
  const agentId = finished?.agentId
  const taskId = taskIdOf(agentId, promptTask)
  // --- end sources by task ---
  const found: SourceRecord[] = outcome.isDenied
    ? []
    : extractSources({ tool, input: call.input, result: structured, text: outcome.text, isError: outcome.isError, now: end, durationMs: end - call.startedAt, taskId })
  if (found.length > 0) {
    await update($, sources, list => mergeSources(list, found))
  }
  const made = isApplied ? extractArtifacts(tool, call.input, structured, outcome.text, end) : []
  if (made.length > 0) {
    await update($, artifacts, list => mergeArtifacts(list, made))
  }
  // --- sources by task ---
  await noteTasks($, call, result, agentId)
  // --- end sources by task ---
  if (tool.startsWith('mcp__') && !outcome.isDenied) {
    await update($, services, (list): ServiceUse[] => recordService(list, tool, end - call.startedAt, outcome.isError, end))
  }
  if (call.filePath !== undefined && isApplied) {
    if (tool === 'Read') {
      await recordTouch($, call.filePath, 'read', tool, end)
    } else if (FILE_TOOLS.has(tool)) {
      await recordTouch($, call.filePath, tool === 'Write' && !call.didExist ? 'created' : 'modified', tool, end)
    }
  }
  if (tool === 'Bash') {
    await markDeletions($, end)
  }
  if (tool === 'Bash' || FILE_TOOLS.has(tool)) {
    scheduleGit($, 400)
  }
  // --- file tree ---
  if (tool === 'Bash' || FILE_TOOLS.has(tool)) {
    scheduleTree($)
  }
  // --- end file tree ---
  if (tool === 'Bash' && finished?.status === 'error' && !alerted.has(`${id}:failed`)) {
    alerted.add(`${id}:failed`)
    await toast($, `✗ ${finished.exitCode !== undefined ? `exit ${finished.exitCode}` : 'failed'}: ${oneLine(finished.title, 70)}`)
  }
  // The quick-stats strip counts it now, not at the next pulse.
  detach(refreshPulse($))
  scheduleSave($) // --- session history ---
}

// --- ports ---
// ------------------------------------------------------------------------- //
// Ports: dev servers, the Claude sessions' processes, TCP listeners. Read only
// while the Ports tab is open, or while a dev server is starting.
// ------------------------------------------------------------------------- //

/** Each dev server this load started, by port: the process group its launcher made. */
const launched = new Map<number, number>()
let portsFlight: Promise<PortsSnapshot | undefined> | undefined
let lastPortsPoll = 0
let lastPortsPrint = ''

/** Runs sampler/procs.py: its one JSON line, or one saying why it could not run. */
const runProcs = async ($: EngineInterface, args: readonly string[], timeoutMs: number): Promise<string> => {
  const argv = [await pythonPath($), '-I', `${$.plugin.root}/sampler/procs.py`, ...args]
  try {
    const result = await $.process.run(argv, { timeoutMs })
    return result.stdout.trim() !== ''
      ? result.stdout
      : JSON.stringify({ ok: false, message: oneLine(result.stderr || `the helper exited with ${result.exitCode}`, 240) })
  } catch (error) {
    return JSON.stringify({ ok: false, message: errorText(error) })
  }
}

/** The answer to something the person pressed: shown even with alerts off. */
const notify = ($: EngineInterface, text: string): void => {
  $.ui.toast(oneLine(text, 300), { timeoutMs: 8_000 })
}

/** The `/config` Model row read into Overview's controls: its value, its choices and whether a policy locks it. */
const loadModelRow = async ($: EngineInterface): Promise<void> => {
  try {
    const row = (await $.config.list()).find(one => one.key === 'model')
    if (row === undefined) {
      return
    }
    const value = typeof row.value === 'string' ? row.value : ''
    await update($, settings, (current): SessionSettings => ({ ...current, model: value, modelOptions: [...(row.options ?? [])], isModelLocked: row.isLocked }))
  } catch {
    // Without the row the controls say the list is not known.
  }
}

/** A model or effort picked on the card: kept as a draft until Apply. */
const pickSetting = async ($: EngineInterface, change: Partial<Pick<SessionSettings, 'draftModel' | 'draftEffort'>>): Promise<void> => {
  await update($, settings, (current): SessionSettings => ({ ...current, ...change }))
}

/** Apply pressed: the picked model through `/model`, then the picked effort through `/effort`; the drafts cleared. */
const applySettings = async ($: EngineInterface): Promise<void> => {
  const current = await read($, settings)
  await update($, settings, (now): SessionSettings => ({ ...now, draftModel: '', draftEffort: '' }))
  if (current.draftModel !== '' && current.draftModel !== current.model) {
    try {
      await $.command.run({ command: 'model', args: current.draftModel })
      await update($, settings, (now): SessionSettings => ({ ...now, model: current.draftModel }))
    } catch (error) {
      notify($, `The model was not changed: ${errorText(error)}`)
    }
    await loadModelRow($)
  }
  if (isEffortLevel(current.draftEffort)) {
    await setEffort($, current.draftEffort)
  }
}

/** The effort set on Overview's slider: `/effort <level>`, run once the session is idle; shown as set until a request uses it. */
const setEffort = async ($: EngineInterface, level: EffortLevel): Promise<void> => {
  await update($, settings, (current): SessionSettings => ({ ...current, askedEffort: level }))
  try {
    await $.command.run({ command: 'effort', args: level })
  } catch (error) {
    await update($, settings, (current): SessionSettings => ({ ...current, askedEffort: '' }))
    notify($, `The effort was not changed: ${errorText(error)}`)
  }
}

const loadPorts = async ($: EngineInterface): Promise<PortsSnapshot | undefined> => {
  const [view, state] = await Promise.all([read($, ports), read($, ui)])
  const open = portsUi(state).open
  const tails = view.configs
    .map(config => config.port)
    .filter(port => open.includes(devKey(port)) || view.phases.some(phase => phase.port === port))
  const parsed = parseSnapshot(await runProcs($, snapshotArgs(view.configs, tails, [...launched.values()]), 15_000))
  if ('error' in parsed) {
    const error = parsed.error
    await update($, ports, (current): PortsView => ({ ...current, error }))
    return undefined
  }
  const now = await $.clock.now()
  // Written when something changed, so an idle listing is not drawn again.
  const print = JSON.stringify(parsed)
  if (print !== lastPortsPrint || view.error !== undefined || view.updatedAt === 0) {
    lastPortsPrint = print
    await update($, ports, current => applySnapshot(current, parsed, now))
  }
  return parsed
}

/** One listing at a time: a caller while one is under way gets that one. */
const refreshPorts = ($: EngineInterface): Promise<PortsSnapshot | undefined> => {
  if (portsFlight === undefined) {
    portsFlight = loadPorts($).finally(() => {
      portsFlight = undefined
    })
  }
  return portsFlight
}

/** A listing read after now: waits out one under way, then reads afresh. */
const refreshPortsNow = async ($: EngineInterface): Promise<PortsSnapshot | undefined> => {
  await portsFlight?.catch(() => undefined)
  return refreshPorts($)
}

/** A starting dev server: up, gone, or out of time. */
const checkStarting = async ($: EngineInterface, snapshot: PortsSnapshot | undefined, now: number): Promise<void> => {
  const view = await read($, ports)
  for (const phase of view.phases) {
    if (phase.phase !== 'starting') {
      continue
    }
    const port = phase.port
    const name = view.configs.find(config => config.port === port)?.name ?? `The server on :${port}`
    const pgid = launched.get(port)
    const tail = logTail(snapshot?.logs.find(log => log.port === port)?.lines ?? [], 3)
    const isUp = snapshot?.listeners.some(one => one.port === port) === true
    const isGone = pgid !== undefined && snapshot?.groups.find(one => one.pgid === pgid)?.alive === 0
    const message = isUp
      ? `${name} is up on :${port}`
      : isGone
        ? `${name} exited before listening on :${port}${tail !== '' ? `: ${tail}` : ' (its log is empty)'}`
        : now - phase.since >= START_TIMEOUT_MS
          ? `${name} is not listening on :${port} after ${START_TIMEOUT_MS / 1000} s${tail !== '' ? `: ${tail}` : ''}`
          : undefined
    if (message !== undefined) {
      launched.delete(port)
      await update($, ports, (current): PortsView => ({ ...current, phases: withoutPhase(current.phases, port) }))
      notify($, message)
    }
  }
}

/** Every second: a starting server's check; every PORTS_POLL_MS, the listing while the tab is open. */
const pollPorts = async ($: EngineInterface): Promise<void> => {
  const [view, state, now] = await Promise.all([read($, ports), read($, ui), $.clock.now()])
  const isStarting = view.phases.some(phase => phase.phase === 'starting')
  const isOpen = isSamplerWanted && state.tab === 'ports'
  if (!isStarting && (!isOpen || now - lastPortsPoll < PORTS_POLL_MS - START_POLL_MS / 2)) {
    return
  }
  lastPortsPoll = now
  const snapshot = await refreshPorts($)
  if (isStarting) {
    await checkStarting($, snapshot, now)
  }
}

const startDevServer = async ($: EngineInterface, port: number): Promise<void> => {
  const view = await read($, ports)
  const config = view.configs.find(one => one.port === port)
  if (config === undefined) {
    return
  }
  const pending = view.phases.find(one => one.port === port)
  if (pending !== undefined) {
    notify($, `${config.name} is already ${pending.phase}.`)
    return
  }
  const snapshot = await refreshPortsNow($)
  if (snapshot === undefined) {
    notify($, `Could not read the listening ports, so ${config.name} was not started.`)
    return
  }
  const holder = snapshot.listeners.find(one => one.port === port)
  const heldBy = devStatus(config, await read($, ports)).heldBy
  if (heldBy !== undefined) {
    notify(
      $,
      `:${port} is held by ${heldBy.name} (:${heldBy.port}), most likely its Node debugger, so ${config.name} was not started. ` +
        `Turn ${heldBy.name} off and on again here (this tab starts it without the debugger), then turn this on.`,
    )
    return
  }
  if (holder !== undefined) {
    notify($, `:${port} is already in use by ${holder.name} (pid ${holder.pid}); ${config.name} was not started.`)
    return
  }
  const now = await $.clock.now()
  await update($, ports, (current): PortsView => ({ ...current, phases: withPhase(current.phases, port, 'starting', now) }))
  const result = parseLaunch(await runProcs($, launchArgs(config), 15_000))
  if (!result.ok) {
    await update($, ports, (current): PortsView => ({ ...current, phases: withoutPhase(current.phases, port) }))
    notify($, `Could not start ${config.name}: ${result.message}`)
    return
  }
  launched.set(port, result.pgid)
}

const stopDevServer = async ($: EngineInterface, port: number): Promise<void> => {
  const view = await read($, ports)
  const config = view.configs.find(one => one.port === port)
  if (config === undefined) {
    return
  }
  const pending = view.phases.find(one => one.port === port)
  if (pending !== undefined) {
    notify($, `${config.name} is already ${pending.phase}.`)
    return
  }
  const now = await $.clock.now()
  await update($, ports, (current): PortsView => ({ ...current, phases: withPhase(current.phases, port, 'stopping', now) }))
  const result = parseStop(await runProcs($, stopArgs(port), 30_000))
  launched.delete(port)
  await update($, ports, (current): PortsView => ({ ...current, phases: withoutPhase(current.phases, port) }))
  await refreshPortsNow($)
  notify($, result.ok ? `Turned off ${config.name}. ${result.message}` : `Could not turn off ${config.name}: ${result.message}`)
}

/** Turns a dev server off and on again, with its current command (the web app's, without its debugger). */
const restartDevServer = async ($: EngineInterface, port: number): Promise<void> => {
  if (await isBounce($, `pt:restart:${port}`)) {
    return
  }
  await stopDevServer($, port)
  await startDevServer($, port)
}

const setDevServer = async ($: EngineInterface, port: number, isOn: boolean): Promise<void> => {
  if (await isBounce($, `pt:toggle:${port}`)) {
    return
  }
  await (isOn ? startDevServer($, port) : stopDevServer($, port))
}

const disarm = async ($: EngineInterface, key: string, at: number): Promise<void> => {
  await update($, ui, (current): UiState => {
    const armed = portsUi(current).armed
    return armed !== null && armed.key === key && armed.at === at ? { ...current, killArmed: null } : current
  })
}

/** Suspend and resume act at once; kill and force kill on a second press within ARM_MS. */
const pressProcAction = async ($: EngineInterface, target: ProcTarget, action: ProcAction): Promise<void> => {
  const key = armKey(action, target.pid)
  if (await isBounce($, key)) {
    return
  }
  const [view, state, now] = await Promise.all([read($, ports), read($, ui), $.clock.now()])
  const judged = verdict(target, view.uid)
  if (!judged.canSignal) {
    notify($, `Can't ${actionVerb(action)} ${target.name} (${target.pid}): ${judged.reason}.`)
    return
  }
  if (needsConfirm(action)) {
    const step = confirmStep(portsUi(state).armed, key, now)
    await update($, ui, (current): UiState => ({ ...current, killArmed: step.armed }))
    if (!step.isConfirmed) {
      $.clock.after(ARM_MS, () => {
        detach(disarm($, key, now))
      })
      return
    }
  }
  notify($, parseResult(await runProcs($, signalArgs(action, target), 15_000)).message)
  await refreshPortsNow($)
}

/** A click on a Ports row: open or close it (a dev server's row loads its log). */
const togglePortsRow = async ($: EngineInterface, key: string): Promise<void> => {
  if (await isBounce($, key)) {
    return
  }
  const state = await update($, ui, (current): UiState => {
    const fields = portsUi(current)
    return key === OTHER_KEY ? { ...current, portsOtherOpen: !fields.isOtherOpen } : { ...current, portsOpen: toggled(fields.open, key) }
  })
  if (key.startsWith('pt:dev:') && portsUi(state).open.includes(key)) {
    await refreshPortsNow($)
  }
}

/** A Ports row's press, posted by its region (view/row.tsx). */
const readPortsPress = (data: unknown): string | undefined =>
  isRecord(data) && data.kind === 'ports' && typeof data.id === 'string' && data.id.startsWith('pt:') ? data.id : undefined

/** The dev servers from `$.store`, written there with the defaults the first time. */
const initPorts = async ($: EngineInterface): Promise<void> => {
  const saved = readDevServers(await $.store.get(DEV_SERVERS_KEY))
  const migrated = saved === undefined ? undefined : migrateDevServers(saved)
  if (saved === undefined || migrated?.changed === true) {
    await $.store.set(DEV_SERVERS_KEY, migrated?.configs ?? DEFAULT_DEV_SERVERS)
  }
  const configs = migrated?.configs ?? [...DEFAULT_DEV_SERVERS]
  await update($, ports, (current): PortsView => ({ ...current, configs, phases: current.phases.filter(phase => phase.phase === 'starting') }))
}
// --- end ports ---

// --- session history ---
// ------------------------------------------------------------------------- //
// Past sessions: this session's record kept in the store for the project's
// later sessions, the project's past sessions for the picker, and the one the
// picker shows in place of this session
// ------------------------------------------------------------------------- //

const EMPTY_HISTORY: HistoryView = { entries: [], floor: 0 }
const history = atom({ plugin: 'session-monitor', key: 'history' } as const, EMPTY_HISTORY, { shape: SHAPE })
const viewed = atom({ plugin: 'session-monitor', key: 'viewed' } as const, null, { shape: SHAPE })

/** While things change, a save waits this long: at most one this often, never one a tick. A turn's end saves at once. */
const SAVE_DELAY_MS = 45_000
let saveTimer: { cancel: () => void } | undefined
/** Saves run one at a time, in the order asked. */
let saveChain: Promise<void> = Promise.resolve()
/** What this session saved last: its id, its record (the next merges into it) and its JSON (an unchanged record is not written again). */
let lastSave: { id: string; snapshot: SessionSnapshot; json: string } | undefined
/** The project the session's records are kept under: its repository's main working tree, else its folder; read once. */
let historyProject = ''
/** The project's sessions Claude Code's transcripts hold, as last listed: the picker lists them beside the records. */
let transcriptSessions: TranscriptSummary[] = []
/** The past session last chosen in the picker (null: this one), so a slow read does not show one chosen before it. */
let viewing: string | null = null
/** How often the transcripts are listed again, for sessions started since (in another window, say). */
const TRANSCRIPTS_POLL_MS = 300_000

const projectOf = async ($: EngineInterface): Promise<string> => {
  if (historyProject === '') {
    const [repo, root] = await Promise.all([$.session.repo(), $.session.root()])
    historyProject = repo?.root ?? root
  }
  return historyProject
}

/** The picker's list: the project's past sessions, its records' and its transcripts', the running one left out; written only when it changed. */
const showEntries = async ($: EngineInterface, entries: readonly SessionEntry[], liveId: string): Promise<void> => {
  const shown = mergeEntries(entries, transcriptSessions, liveId)
  if (JSON.stringify((await read($, history)).entries) !== JSON.stringify(shown)) {
    await update($, history, (view): HistoryView => ({ ...view, entries: shown }))
  }
}

/**
 * Saves the session's record when it changed (built from the pane's values,
 * merged into what it saved last, fitted to SNAPSHOT_CHARS) and lists it in
 * its project's past sessions, the oldest past MAX_SESSIONS pruned.
 */
const saveOnce = async ($: EngineInterface, endingId: string | undefined): Promise<void> => {
  const [id, project] = await Promise.all([endingId ?? $.session.id(), projectOf($)])
  if (project === '') {
    return
  }
  const [promptList, list, agentList, files, view, figures, spent, made, found, workers, metrics, past] = await Promise.all([
    read($, prompts),
    read($, commands),
    read($, agents),
    read($, touched),
    read($, git),
    read($, usage),
    read($, spend),
    read($, artifacts),
    read($, sources),
    read($, models),
    read($, live),
    read($, history),
  ])
  const previous = lastSave?.id === id ? lastSave.snapshot : readSnapshot(await $.store.get(snapshotKey(id)))
  const built = buildSnapshot({
    id,
    project,
    floor: past.floor,
    startedAt: figures.sessionStartedAt > 0 ? figures.sessionStartedAt : metrics.startedAt,
    prompts: promptList,
    commands: list,
    agents: agentList,
    touched: files,
    git: view,
    artifacts: made,
    usage: figures,
    spend: spent,
    sources: found,
    models: workers,
    previous,
  })
  if (built === undefined) {
    return
  }
  const fitted = fitSnapshot(built, SNAPSHOT_CHARS)
  if (lastSave?.id === id && lastSave.json === fitted.json) {
    return
  }
  const stored: unknown = JSON.parse(fitted.json)
  await $.store.set(snapshotKey(id), stored)
  lastSave = { id, snapshot: fitted.snapshot, json: fitted.json }
  const { kept, dropped } = upsertEntry(readEntries(await $.store.get(historyKey(project))), entryOf(fitted.snapshot, fitted.json.length), MAX_SESSIONS)
  await $.store.set(historyKey(project), kept)
  for (const gone of dropped) {
    await $.store.delete(snapshotKey(gone))
  }
  await showEntries($, kept, id)
}

/** Saves now, after any save under way; `endingId` names a session that is ending. A failed save is dropped: the next one tries again. */
const saveSession = ($: EngineInterface, endingId?: string): Promise<void> => {
  const work = saveChain.then(() => saveOnce($, endingId)).catch(() => undefined)
  saveChain = work
  return work
}

/** Something to keep changed: saved within SAVE_DELAY_MS, one timer at a time. */
const scheduleSave = ($: EngineInterface): void => {
  if (saveTimer !== undefined) {
    return
  }
  saveTimer = $.clock.after(SAVE_DELAY_MS, () => {
    saveTimer = undefined
    detach(saveSession($))
  })
}

/** A turn ended: saved at once, the timer's save no longer needed. */
const saveAtTurnEnd = ($: EngineInterface): void => {
  saveTimer?.cancel()
  saveTimer = undefined
  detach(saveSession($))
}

/**
 * At the start: every project's list mended and the records pruned to fit
 * (planHistory), and this project's past sessions given to the picker.
 */
const loadHistory = async ($: EngineInterface): Promise<void> => {
  const [id, project, keys] = await Promise.all([$.session.id(), projectOf($), $.store.keys()])
  const lists = new Map<string, SessionEntry[]>()
  for (const key of keys.filter(one => one.startsWith(HISTORY_PREFIX))) {
    lists.set(key.slice(HISTORY_PREFIX.length), readEntries(await $.store.get(key)))
  }
  const listed = new Set([...lists.values()].flat().map(entry => snapshotKey(entry.id)))
  const orphans: Orphan[] = []
  for (const key of keys.filter(one => one.startsWith(SNAPSHOT_PREFIX) && !listed.has(one))) {
    const value: unknown = await $.store.get(key)
    orphans.push({ key, snapshot: readSnapshot(value), bytes: JSON.stringify(value ?? null).length })
  }
  const plan = planHistory(lists, keys, orphans, id)
  for (const key of plan.deletes) {
    await $.store.delete(key)
  }
  for (const one of plan.changed) {
    const entries = plan.lists.get(one) ?? []
    await (entries.length === 0 ? $.store.delete(historyKey(one)) : $.store.set(historyKey(one), entries))
  }
  await showEntries($, plan.lists.get(project) ?? [], id)
  await listTranscripts($)
}

/** The project's list read again for the picker: after a `/clear` or a resume, the session that ended is a past one. */
const refreshEntries = async ($: EngineInterface): Promise<void> => {
  const [id, project] = await Promise.all([$.session.id(), projectOf($)])
  await showEntries($, readEntries(await $.store.get(historyKey(project))), id)
}

/** Runs sampler/transcripts.py: its answer, or '' when it could not run or its answer was cut. */
const runTranscripts = async ($: EngineInterface, args: readonly string[]): Promise<string> => {
  try {
    const result = await $.process.run([await pythonPath($), '-I', `${$.plugin.root}/${TRANSCRIPTS_SCRIPT}`, ...args], { timeoutMs: 30_000 })
    return result.exitCode === 0 && !result.isStdoutTruncated ? result.stdout : ''
  } catch {
    return ''
  }
}

/** The project's sessions in Claude Code's transcripts, listed again for the picker; a listing that fails keeps the last. */
const listTranscripts = async ($: EngineInterface): Promise<void> => {
  const project = await projectOf($)
  const answer = project === '' ? '' : await runTranscripts($, ['list', project])
  if (answer === '') {
    return
  }
  transcriptSessions = parseSummaries(answer)
  await refreshEntries($)
}

/** One session of the project as its transcript holds it: its prompts and calls, with their outputs. */
const readTranscript = async ($: EngineInterface, project: string, id: string): Promise<TranscriptSession | undefined> => {
  const session = project === '' ? undefined : parseSession(await runTranscripts($, ['read', project, id]))
  return session?.id === id ? session : undefined
}

/** Earlier items put back before the ones a list holds already, each once, oldest first, the newest `max` kept. */
const putBack = <T extends { id: string }>(earlier: readonly T[], now: readonly T[], at: (item: T) => number, max: number): T[] => {
  const held = new Set(now.map(one => one.id))
  return [...earlier.filter(one => !held.has(one.id)), ...now].sort((a, b) => at(a) - at(b)).slice(-max)
}

/**
 * The app reopened this session, or the monitor loaded into it late: its
 * earlier prompts and calls put back from its record and its transcript,
 * settled (nothing from before runs now), each call's output with it, and the
 * record's agents, files, artifacts and models. Only while the pane holds
 * nothing of this session: a reload keeps what it holds.
 */
const restoreSession = async ($: EngineInterface): Promise<void> => {
  const [promptList, list] = await Promise.all([read($, prompts), read($, commands)])
  if (promptList.length > 0 || list.length > 0) {
    return
  }
  const [id, project] = await Promise.all([$.session.id(), projectOf($)])
  const stored = readSnapshot(await $.store.get(snapshotKey(id)))
  const joined = joinTranscript(stored, await readTranscript($, project, id), project)
  if (joined === undefined) {
    return
  }
  const settled = settleSnapshot(joined)
  for (const [callId, text] of Object.entries(joined.outputs ?? {})) {
    // Cleaned as a live call's output is: a control character in a Code's source makes the engine refuse the whole pane.
    await $.state.set({ ...output, id: callId }, clipOutput(text))
  }
  await update($, prompts, (now): PromptRecord[] => putBack(settled.prompts, now, one => one.at, MAX_PROMPTS))
  await update($, commands, (now): CommandRecord[] => putBack(settled.commands, now, one => one.startedAt, MAX_COMMANDS))
  if (stored !== undefined) {
    await update($, agents, (now): AgentRecord[] => (now.length > 0 ? now : settled.agents))
    await update($, touched, (now): TouchedFile[] => (now.length > 0 ? now : settled.touched))
    await update($, artifacts, (now): ArtifactRecord[] => (now.length > 0 ? now : settled.artifacts))
    await update($, models, (now): ModelUse[] => (now.length > 0 ? now : settled.models))
  }
  detach(refreshPulse($))
}

/** A past session whose record and transcript cannot be read: taken off its project's list and the picker. */
const forgetSession = async ($: EngineInterface, id: string): Promise<void> => {
  transcriptSessions = transcriptSessions.filter(one => one.id !== id)
  const [liveId, project] = await Promise.all([$.session.id(), projectOf($)])
  const entries = readEntries(await $.store.get(historyKey(project))).filter(one => one.id !== id)
  await $.store.set(historyKey(project), entries)
  await $.store.delete(snapshotKey(id))
  await showEntries($, entries, liveId)
}

/**
 * Shows a past session of the project in place of this one: its record and
 * its transcript read and joined, settled (nothing in it runs) and kept for
 * the drawing, then chosen. A record shows at once, its transcript's calls and
 * outputs once read. Null shows this session again. An open file closes either way.
 */
const viewSession = async ($: EngineInterface, id: string | null): Promise<void> => {
  viewing = id
  if (id === null) {
    // Each session's Prompts tab opens at its newest page, whatever page the other was on.
    await update($, ui, (current): UiState => ({ ...current, viewedSession: null, promptsFrom: 0 }))
    await update($, viewed, () => null)
    await update($, diff, () => null)
    return
  }
  const project = await projectOf($)
  const stored = readSnapshot(await $.store.get(snapshotKey(id)))
  if (stored !== undefined) {
    await showViewed($, settleSnapshot(stored))
  }
  const snapshot = joinTranscript(stored, await readTranscript($, project, id), project)
  if (viewing !== id) {
    return
  }
  if (snapshot === undefined) {
    $.ui.toast('That session could not be read (its record and transcript are gone), so it was taken off the list.', { timeoutMs: 5_000 })
    await forgetSession($, id)
    return
  }
  if (snapshot !== stored) {
    await showViewed($, settleSnapshot(snapshot))
  }
}

/** A past session's joined record kept for the drawing and chosen; an open file closes. */
const showViewed = async ($: EngineInterface, snapshot: SessionSnapshot): Promise<void> => {
  const isNew = (await read($, ui)).viewedSession !== snapshot.id
  await update($, viewed, () => snapshot)
  if (isNew) {
    await update($, ui, (current): UiState => ({ ...current, viewedSession: snapshot.id, openCommit: null, promptsFrom: 0 }))
    await update($, diff, () => null)
  }
}

/** The past session the picker shows, whatever the tab; null while this session's own figures show. */
const viewedOf = async ($: EngineInterface): Promise<SessionSnapshot | null> => {
  const [state, snapshot] = await Promise.all([read($, ui), read($, viewed)])
  const id = state.viewedSession ?? null
  return id !== null && snapshot !== null && snapshot.id === id ? snapshot : null
}

/** The past session shown on the open tab, where its record stands in for this session's values. */
const pastShown = async ($: EngineInterface): Promise<SessionSnapshot | null> =>
  PAST_TABS.includes((await read($, ui)).tab) ? viewedOf($) : null

/** Whether the repository still has a commit: a past session's may have been rebased or amended away since. */
const hasCommit = async ($: EngineInterface, sha: string): Promise<boolean> => isSha(sha) && (await runner($)(commitExistsArgv(sha))).exitCode === 0

/**
 * A file of a past session's commit, or of what it left uncommitted. A commit
 * git still has shows its diff, and one it lost says so. Uncommitted work
 * shows the file as it is today: its diff where git sees one now, else its text.
 */
const openPastDiff = async ($: EngineInterface, past: SessionSnapshot, commitKey: string, file: FileChange, mode: DiffMode): Promise<void> => {
  const key = `${commitKey}\u0000${file.path}`
  if (commitKey === WORKTREE) {
    const view = await read($, git)
    const now = view.worktree.find(one => one.path === file.path)
    if (now !== undefined) {
      await openDiff($, WORKTREE, now, mode, { note: TODAY_NOTE })
      return
    }
    const root = view.root !== '' ? view.root : past.root
    await openContent($, root === '' ? file.path : `${root}/${file.path}`, { key, note: TODAY_NOTE })
    return
  }
  if (!(await hasCommit($, commitKey))) {
    const missing: DiffView = {
      key,
      kind: 'diff',
      commitKey,
      path: file.path,
      oldPath: file.oldPath,
      mode,
      text: '',
      header: [],
      isTruncated: false,
      hiddenLines: 0,
      isLoading: false,
      isBinary: file.isBinary,
      error: MISSING_COMMIT,
    }
    await update($, diff, () => missing)
    return
  }
  await openDiff($, commitKey, file, mode, { commit: past.commits.find(one => one.sha === commitKey) })
}

/** A past session's file row: the file as it is today, its diff where git sees one now, else its text. */
const openPastFile = async ($: EngineInterface, row: FileRow): Promise<void> => {
  const change = row.change
  if (change === undefined) {
    await openContent($, row.path, { note: TODAY_NOTE })
    return
  }
  const view = await read($, git)
  const now = view.worktree.find(one => one.path === change.path)
  if (now !== undefined) {
    await openDiff($, WORKTREE, now, (await read($, ui)).diffMode, { note: TODAY_NOTE })
    return
  }
  await openContent($, row.path, { key: rowKey(row), note: TODAY_NOTE })
}

/** The diff mode changed while a past session's diff is open: it opens again in that mode. */
const reopenPastDiff = async ($: EngineInterface, past: SessionSnapshot, mode: DiffMode): Promise<void> => {
  const current = await read($, diff)
  if (current === null || current.kind === 'content') {
    return
  }
  const view = pastGit(past)
  const files = current.commitKey === WORKTREE ? view.worktree : (view.commits.find(one => one.sha === current.commitKey)?.files ?? [])
  const file = files.find(one => one.path === current.path)
  if (file !== undefined) {
    await openPastDiff($, past, current.commitKey, file, mode)
  }
}

/** A Find or Jump pressed on a past session's prompt: its conversation is not this one. */
const pastJump = ($: EngineInterface): void => {
  $.ui.toast('That prompt is from a past session: only this session’s conversation can be searched or scrolled to.', { timeoutMs: 5_000 })
}
// --- end session history ---

/** `/session-monitor` (and `/monitor`): its settings, its tabs, and opening the pane. */
const runMonitor = async ($: EngineInterface, e: { args: string }): Promise<{ text: string }> => {
  const arg = e.args.trim().toLowerCase().replace(/\s+/g, ' ')
  if (arg === 'summaries off' || arg === 'summaries on') {
    await savePrefsTo($, { isSummaryOff: arg === 'summaries off' })
    return {
      text:
        arg === 'summaries off'
          ? `Prompts keep their first sentence as their title; no model is asked. Run /${COMMAND_NAME} summaries on to ask again.`
          : 'New prompts get a few-word title from a small model (haiku).',
    }
  }
  if (arg === 'bar off' || arg === 'bar on') {
    await savePrefsTo($, { isBarHidden: arg === 'bar off' })
    return { text: arg === 'bar off' ? `The quick-stats strip above the prompt is hidden. Run /${COMMAND_NAME} bar on to show it.` : 'The quick-stats strip above the prompt is shown.' }
  }
  if (arg === 'off') {
    await pause($)
    return { text: `Session Monitor paused in this session: no sampling, no polling, pane closed. Run /${COMMAND_NAME} on to resume.` }
  }
  if (arg === 'on') {
    await resume($)
  }
  const tab = TAB_IDS.find(one => one === arg)
  if (tab !== undefined) {
    await update($, ui, (current): UiState => ({ ...current, tab }))
  }
  const opened = await $.ui.open({ ...paneArgs(), focus: true })
  const paused = isSamplerWanted ? '' : ` Live metrics are paused; run /${COMMAND_NAME} on to resume.`
  return { text: opened.isPlaced ? `Session Monitor is open.${paused}` : `Session Monitor is waiting for room: ${opened.reason}` }
}

export const register: Register = on => {
  on('tool.call', async ($, e, next) => {
    let call: Started | undefined
    try {
      const now = await $.clock.now()
      const input: Readonly<Record<string, unknown>> = { ...e }
      const step = lastStep.get(e.agentId ?? '') ?? lastStep.get('')
      const started = startRecord(e.tool_use_id, e.tool, input, now, e.agentId, next.origin.plugin)
      const owner = e.agentId !== undefined ? (agentPrompt.get(e.agentId) ?? promptTask) : promptTask
      const stepped = step === undefined ? started : { ...started, model: step.model, effort: step.effort }
      const record = { ...stepped, promptId: owner }
      if (step !== undefined) {
        detach(update($, models, (list): ModelUse[] => recordToolCall(list, step.model, step.effort)))
      }
      const didExist = e.tool === 'Write' && record.filePath !== undefined ? await $.fs.exists(record.filePath) : true
      const evicted: string[] = []
      await update($, commands, list => {
        const updated = [...list.filter(one => one.id !== record.id), record]
        evicted.length = 0
        evicted.push(...updated.slice(0, Math.max(0, updated.length - MAX_COMMANDS)).map(one => one.id))
        return updated.slice(-MAX_COMMANDS)
      })
      for (const gone of evicted) {
        await $.state.set({ ...output, id: gone }, '')
      }
      call = { id: record.id, tool: e.tool, input, startedAt: now, filePath: record.filePath, didExist }
      if (record.actor.kind !== 'plugin') {
        const loopKey = e.agentId ?? ''
        pendingCalls.set(loopKey, [...(pendingCalls.get(loopKey) ?? []), record.id])
        const earlier = lastRead.get(loopKey) ?? []
        if (earlier.length > 0) {
          detach(linkFlow($, record.id, earlier, JSON.stringify(input)))
        }
      }
    } catch {
      // Monitoring never stands in the way of a tool call.
    }
    // --- agents ---
    const agentInput: Readonly<Record<string, unknown>> = { ...e }
    const agentCall: AgentCallFacts = { toolUseId: e.tool_use_id, tool: e.tool, input: agentInput, agentId: e.agentId }
    queueAgents(() => agentCallStarted($, agentCall))
    // --- end agents ---
    const result = await next(e)
    // --- agents ---
    queueAgents(() => agentCallEnded($, agentCall, result))
    // --- end agents ---
    if (call !== undefined) {
      try {
        await finish($, call, result)
      } catch {
        // As above.
      }
    }
    return result
  }).catch(($, e, next) => next(e))

  // ------------------------------------------------------------------------- //
  // Session, commands, turns
  // ------------------------------------------------------------------------- //

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: COMMAND_NAME,
      description: `Open the Session Monitor pane; \`/${COMMAND_NAME} off\` pauses it in this session, \`/${COMMAND_NAME} on\` resumes`,
      argumentHint: '[on|off|bar on|bar off|summaries on|summaries off|overview|commands|prompts|compute|agents|files|explorer|commits|sources|resources|ports|cache]',
    })
    await $.command.register({ name: COMMAND_ALIAS, description: `The same as /${COMMAND_NAME}`, argumentHint: '[on|off|…]' })
    await $.command.register({ name: 'monitor-report', description: 'Summarize this session’s network, time, energy, commands, sources and file changes' })
    for (const key of OLD_WIDTH_KEYS) {
      if ((await $.store.get(key)) !== undefined) {
        await $.store.delete(key)
      }
    }
    cacheHours = readHours(await $.store.get(CACHE_HOURS_KEY))
    const rate = await $.store.get(RATE_KEY)
    if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) {
      await update($, spend, (view): SpendView => (view.pctPerUsd === undefined ? { ...view, pctPerUsd: rate } : view))
    }
    const prefs = readPrefs(await $.store.get(PREFS_KEY))
    const state = await update($, ui, current => ({ ...current, ...prefs }))
    const now = await $.clock.now()
    await update($, live, current => (current.startedAt > 0 ? current : { ...current, startedAt: now }))
    isSamplerWanted = !state.isPaused
    // --- file tree ---
    // A listing a previous load left running never finishes: drawn as not loading.
    await update($, folderTree, current => ({ ...current, loading: [] }))
    // --- end file tree ---
    // --- explorer --- likewise; a press armed before the reload is forgotten
    await update($, explorer, current => ({ ...current, tree: { ...current.tree, loading: [] }, armed: null }))
    detach(
      $.session
        .version()
        .then(running => {
          canEditInPane = isAtLeast(running.base ?? running.version, MULTILINE_SINCE)
        })
        .catch(() => {
          canEditInPane = false
        }),
    )
    // --- end explorer ---
    detach(refreshUsage($).then(() => refreshGit($, true)))
    $.clock.every(GIT_POLL_MS, () => {
      detach(pollGit($))
    })
    $.clock.every(USAGE_POLL_MS, () => {
      if (isSamplerWanted) {
        detach(refreshUsage($))
      }
    })
    $.clock.every(BATTERY_POLL_MS, () => {
      if (isSamplerWanted) {
        detach(refreshBattery($))
      }
    })
    $.clock.every(PULSE_MS, () => {
      detach(refreshPulse($))
    })
    // --- agents ---
    $.clock.every(AGENT_POLL_MS, () => {
      detach(pollAgents($))
      detach(applyPromptRows($))
    })
    // --- end agents ---
    detach(refreshBattery($).then(() => refreshPulse($)))
    // --- ports ---
    detach(initPorts($))
    detach(loadPrompts($))
    // --- session history --- the project's past sessions for the picker; this one's earlier activity after a reopen
    detach(loadHistory($))
    detach(restoreSession($))
    detach(loadModelRow($))
    // --- prompt cache --- read again while the Cache tab is open
    $.clock.every(CACHE_POLL_MS, () => {
      detach(
        (async () => {
          if ((await read($, ui)).tab === 'cache') {
            await loadCache($)
          }
        })(),
      )
    })
    // --- end prompt cache ---
    $.clock.every(TRANSCRIPTS_POLL_MS, () => {
      detach(listTranscripts($))
    })
    // --- end session history ---
    detach(readMemTotal($))
    detach(probeOnDesktop($))
    $.clock.every(START_POLL_MS, () => {
      detach(pollPorts($))
    })
    // --- end ports ---
    if (isSamplerWanted) {
      detach(runSampler($))
      detach(openWhenDrawn($))
    }
    return started
  })

  // Each model request names its model and effort: count it, and remember it
  // for the tool calls it makes. A pass-through: the stream is not touched.
  on('turn.step', async function* ($, e, next) {
    const loopKey = e.agentId ?? ''
    const consumed = pendingCalls.get(loopKey) ?? []
    pendingCalls.set(loopKey, [])
    const requestingAgent = e.agentId
    if (requestingAgent !== undefined) {
      queueAgents(async () => {
        await writeAgents($, (list, now) => recordAgentRequest(list, requestingAgent, now))
      })
    }
    try {
      const effort = effortText(e.effort)
      lastStep.set(e.agentId ?? '', { model: e.model, effort })
      if (e.agentId === undefined) {
        detach(update($, settings, (current): SessionSettings => ({ ...current, effort, askedEffort: current.askedEffort === effort ? '' : current.askedEffort })))
        if (e.index === 0) {
          detach(loadModelRow($))
        }
      }
      const step: Step = {
        model: e.model,
        effort,
        isTurnStart: e.index === 0,
        isPrompt: turnPrompts.get(e.turnId) === true,
        isAgent: e.agentId !== undefined,
      }
      detach(update($, models, (list): ModelUse[] => recordStep(list, step)))
    } catch {
      // Counting never stands in the way of a request.
    }
    const stepped = yield* next(e)
    if (stepped.usage !== null) {
      detach(recordSpend($, consumed, stepped.usage, e.agentId))
      // The main loop's request is its turn's prompt's; an agent's, the prompt it serves, looked up
      // once the bookkeeping before it (its spawn's) has landed.
      const turnOwner = turnTasks.get(e.turnId) ?? promptTask
      const used = stepped.usage
      const requestingLoop = e.agentId
      queuePrompts(() => {
        const owner = requestingLoop === undefined ? turnOwner : (agentPrompt.get(requestingLoop) ?? turnOwner)
        return recordPromptRequest($, owner, used, requestingLoop === undefined)
      })
    }
    // The calls this response asks for come of the outputs it read.
    lastRead.set(loopKey, consumed)
    if (consumed.length > 0) {
      detach(recordRead($, consumed, stepped.answer, stepped.toolUses.map(use => use.name)))
    }
    // --- agents ---
    // After the stream, untouched: a sub-agent's request counts toward it, with its tokens.
    const steppedAgent = e.agentId
    if (steppedAgent !== undefined) {
      const step: StepFacts = {
        model: e.model,
        effort: effortText(e.effort),
        usage: stepped.usage,
        toolNames: stepped.toolUses.map(use => use.name),
        answer: stepped.answer,
        stopReason: stepped.stopReason,
      }
      queueAgents(() => agentStepped($, steppedAgent, step))
    }
    // --- end agents ---
    return stepped
  })

  // Where each submitted text came from: yours (typed, phone, SDK host) or not (a notification, a peer).
  // Noted before it goes on: its turn may begin, or a running turn take it in, before `next` resolves.
  on('prompt.submit', async ($, e, next) => {
    try {
      const text = normalize(e.text)
      if (text !== '' && isUserOrigin(e.origin.kind)) {
        notYours.delete(text)
        if (e.turnId === undefined) {
          pendingPrompts.set(text, e.origin.kind)
        } else {
          // Typed during a turn: recorded now, waiting. The turn takes it in, or it starts a turn of its own.
          const typed = e.text
          const origin = e.origin.kind
          earlyPrompts.set(text, origin)
          queuePrompts(() => recordPrompt($, typed, origin, undefined))
        }
      } else if (text !== '') {
        notYours.add(text)
      }
    } catch {
      // Recording never stands in the way of a prompt.
    }
    return next(e)
  })

  // A prompt typed during a turn that the turn takes in reaches the model as
  // a `queued_command` the engine injects into the main loop's next request:
  // it was folded into that turn, and no turn of its own will start for it.
  on('prompt.attachment', { type: 'queued_command' }, async ($, e, next) => {
    try {
      if (e.agentId === undefined) {
        const carrier = e.text
        const into = mainTurn
        queuePrompts(() => takeInPrompts($, carrier, into))
      }
    } catch {
      // Recording never stands in the way of what the model reads.
    }
    return next(e)
  })

  // The session measured: a rate-limit window moved a point. The prompts at work read it.
  on('session.measure', async ($, e, next) => {
    try {
      if (e.changed.includes('rateLimits')) {
        const readings: RateLimitView[] = e.rateLimits.map(limit => ({ kind: limit.kind, percentUsed: limit.percentUsed, resetsAt: limit.resetsAt }))
        queuePrompts(() => notePromptWindows($, readings))
      }
    } catch {
      // As above.
    }
    return next(e)
  })

  // The desktop app attached: ask macOS once whether Find may press its keys there (the Prompts tab offers to allow them).
  on('session.attach', { surface: 'desktop' }, async ($, e, next) => {
    detach(probeFindAccess($, false))
    return next(e)
  })

  // Your prompts' rows in the conversation: what a click on a prompt scrolls to. Drawn as the engine draws them.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    try {
      if (isUserOrigin(e.props.origin.kind) && e.props.text.trim() !== '' && !linkedRows.has(e.requestId)) {
        linkedRows.add(e.requestId)
        pendingRows.set(e.requestId, e.props.text)
      }
    } catch {
      // Drawing is the engine's; matching rows is best effort.
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    turnPrompts.set(e.turnId, e.text.trim() !== '')
    // A subagent's run raises no turn.start: this is the main loop's.
    mainTurn = e.turnId
    // --- sources by task ---
    promptTask = taskForTurn(e.turnId, e.text, promptTask)
    turnTasks.set(e.turnId, promptTask)
    detach(openPromptTask($, promptTask, e.text))
    // --- end sources by task ---
    detach(applyPromptRows($))
    const typed = normalize(e.text)
    const text = e.text
    const startedTask = promptTask
    if (typed !== '' && !notYours.has(typed)) {
      const early = earlyPrompts.get(typed)
      if (early !== undefined) {
        // Typed during an earlier turn, and not taken in: this turn is its own.
        queuePrompts(() => startEarlyPrompt($, text, early, startedTask))
      } else {
        const origin = pendingPrompts.get(typed) ?? 'composer'
        pendingPrompts.delete(typed)
        queuePrompts(() => recordPrompt($, text, origin, startedTask))
      }
    } else if (typed === '') {
      queuePrompts(() => continuePrompt($, startedTask))
    }
    if (isSamplerWanted) {
      detach(beginTurnBattery($, e.turnId, e.text))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // --- agents ---
    const endedAgent = e.agentId
    if (endedAgent !== undefined) {
      const turn: TurnFacts = { reason: e.reason, durationMs: e.durationMs, usage: e.usage }
      queueAgents(() => agentTurnEnded($, endedAgent, turn))
    }
    // --- end agents ---
    detach(refreshUsage($))
    if (e.agentId === undefined) {
      const turnId = e.turnId
      const endedTask = turnTasks.get(e.turnId) ?? promptTask
      const durationMs = e.durationMs
      const reason = e.reason
      queuePrompts(() => endPromptTurn($, turnId, endedTask, durationMs, reason))
      detach(readCacheHours($))
      // --- session history --- the record saved once the turn's end is recorded
      queuePrompts(async () => saveAtTurnEnd($))
      if (mainTurn === e.turnId) {
        mainTurn = undefined
      }
    } else {
      const agentId = e.agentId
      queuePrompts(() => endAgentRun($, agentId))
    }
    if (e.agentId === undefined && isSamplerWanted) {
      detach(endTurnBattery($, e.turnId))
    }
    turnPrompts.delete(e.turnId)
    // --- sources by task ---
    const doneTask = e.agentId ?? turnTasks.get(e.turnId)
    turnTasks.delete(e.turnId)
    if (doneTask !== undefined) {
      detach(closeTask($, doneTask, e.usage?.model ?? lastStep.get(e.agentId ?? '')?.model))
    }
    // --- end sources by task ---
    return result
  })

  on('command.run', { command: COMMAND_NAME }, ($, e) => runMonitor($, e))
  on('command.run', { command: COMMAND_ALIAS }, ($, e) => runMonitor($, e))

  on('command.run', { command: 'monitor-report' }, async $ => {
    const [metrics, list, view, figures, found, power, workers, now] = await Promise.all([
      read($, live),
      read($, commands),
      read($, git),
      read($, usage),
      read($, sources),
      read($, battery),
      read($, models),
      $.clock.now(),
    ])
    // --- sources by task ---
    const labels = await read($, tasks)
    // --- end sources by task ---
    const [spent, made] = await Promise.all([read($, spend), read($, artifacts)])
    return { text: report(liveBuffer ?? metrics, list, view, figures, found, now, power, workers, labels, spent, made) }
  })

  // The quick-stats strip above the prompt: commands, changed files and
  // sources, each a button that opens its tab. Not while a survey holds the
  // band, the monitor is paused, or `/monitor bar off` hid it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const [summary, state] = await Promise.all([read($, pulse), read($, ui)])
    if (state.isPaused || state.isBarHidden || summary.t === 0) {
      return next(e)
    }
    const { Box, Text, Button } = $.ui.resolve(e)
    const labels = quickLabels(summary)
    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Text dimColor>Session Monitor</Text>
        {QUICK_TABS.map(tab => (
          <Button key={`qs:${tab}`} label={labels[tab]} onPress={() => detach(openTab($, tab))} />
        ))}
      </Box>
    )
  })

  // ------------------------------------------------------------------------- //
  // The pane
  // ------------------------------------------------------------------------- //

  // A row's region posts its press here (view/row.tsx), and an Overview prompt's title its prompt (view/title-link.tsx).
  on('ui.message', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const level = readEffortPress(e.data)
    if (level !== undefined) {
      await pickSetting($, { draftEffort: level })
      return {}
    }
    const expanded = readExpandPress(e.data)
    if (expanded !== undefined) {
      await update($, ui, (current): UiState => ({ ...current, openPrompt: current.openPrompt === expanded ? null : expanded }))
      return {}
    }
    const folded = readFoldPress(e.data)
    if (folded !== undefined) {
      await update($, ui, (current): UiState => ({ ...current, shownAgents: withShown(current.shownAgents, folded, !(current.shownAgents ?? []).includes(folded)) }))
      return {}
    }
    const revealed = readTitlePress(e.data)
    if (revealed !== undefined) {
      await revealPrompt($, revealed)
      return {}
    }
    await unmarkPrompt($)
    // A tab's button in the desktop app's tab bar (view/tab-bar.tsx).
    const tabPressed = readTabPress(e.data)
    const pressedTab = tabPressed === undefined ? undefined : tabOfKey(`tab:${tabPressed}`)
    if (pressedTab !== undefined) {
      await update($, ui, (current): UiState => (current.tab === pressedTab ? current : { ...current, tab: pressedTab }))
      return {}
    }
    // --- file tree ---
    const treePress = readTreePress(e.data)
    if (treePress !== undefined) {
      await pressTreeRow($, treePress)
      return {}
    }
    // --- end file tree ---
    // --- explorer ---
    const explorerPress = readExplorerPress(e.data)
    if (explorerPress !== undefined) {
      await pressExplorerRow($, explorerPress)
      return {}
    }
    // --- end explorer ---
    // --- ports ---
    const portsKey = readPortsPress(e.data)
    if (portsKey !== undefined) {
      await togglePortsRow($, portsKey)
      return {}
    }
    // --- end ports ---
    const press = readPress(e.data)
    if (press !== undefined) {
      await pressRow($, press)
    }
    // --- agents ---
    const agentPress = readAgentPress(e.data)
    if (agentPress !== undefined) {
      await toggleAgentRow($, agentPress)
    }
    // --- end agents ---
    return {}
  })

  // A press of the pane's buttons is a click too: once it has run, the card a reveal marked loses its mark
  // (after, so nothing waits in front of a press that scrolls the conversation). A title's own press marks one.
  // A click on a tab button first lands the pane's focus ring on it (the press reaches the button
  // only once the ring is there), so the person's first click on a tab did nothing visible: the
  // tab is switched as the ring lands, and the press that may follow finds it switched already.
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const tab = e.element === undefined ? undefined : tabOfKey(e.element)
    if (tab !== undefined && e.origin.kind === 'person') {
      await update($, ui, (current): UiState => (current.tab === tab ? current : { ...current, tab }))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.press', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    // A tab button: switched here by its key, before the button's own closure, so the press lands
    // even when a redraw replaced the tree between the click and the closure's run.
    const tab = tabOfKey(e.element)
    if (tab !== undefined) {
      await update($, ui, (current): UiState => (current.tab === tab ? current : { ...current, tab }))
    }
    const pressed = await next(e)
    if (!isOverviewTitleKey(e.element)) {
      await unmarkPrompt($)
    }
    return pressed
  }).catch(($, e, next) => next(e))

  // A region of ours failed on a surface (it threw, never answered, or the desktop app tore it down for
  // flooding): its module is left out there for a while, so the tabs, titles and rows stay reachable.
  on('ui.fault', async ($, e, next) => {
    const wait = heardFault(faultedModules, e, await $.clock.now())
    if (wait !== undefined) {
      // Drawn again once the wait is over, whatever else does or does not redraw the pane meanwhile.
      $.clock.after(wait, () => $.ui.invalidate('ui.render'))
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // A table names every element and draws the ones its surface lacks as
    // nothing, so what a surface draws is decided by the surface, not the table.
    const table = $.ui.resolve(e)
    const hasClient = e.surface === 'terminal' || e.surface === 'desktop'
    const hasFields = e.surface !== 'mobile'
    const Client = hasClient && 'Client' in table ? table.Client : undefined
    const regions = usableRegions(e.surface, faultedModules, await $.clock.now())
    const kit: Ui = {
      Box: table.Box,
      Text: table.Text,
      Button: table.Button,
      Code: table.Code,
      Link: table.Link,
      // --- ui polish ---
      Markdown: e.surface !== 'terminal' ? table.Markdown : undefined,
      // --- ui polish ---
      Select: hasFields && 'Select' in table ? table.Select : undefined,
      Input: hasFields && 'Input' in table ? table.Input : undefined,
      Svg: e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined,
      // Each region only while its module has not failed this load: else the plain elements are drawn.
      Row:
        Client === undefined || !regions.row
          ? undefined
          : (key: string, props: RowProps) => <Client key={key} module="./view/row.tsx" props={props} width="100%" />,
      EffortSlider:
        Client === undefined || !regions.effortSlider
          ? undefined
          : (key: string, props: EffortSliderProps) => <Client key={key} module="./view/effort-slider.tsx" props={props} width="100%" />,
      TitleLink:
        Client === undefined || !regions.titleLink
          ? undefined
          : (key: string, props: TitleLinkProps) => <Client key={key} module="./view/title-link.tsx" props={props} width="100%" />,
      // In the desktop app only: there a plain button's press names a handle each redraw replaces (view/tab-bar.tsx).
      TabBar:
        Client === undefined || !regions.tabBar
          ? undefined
          : (key: string, props: TabBarProps) => <Client key={key} module="./view/tab-bar.tsx" props={props} width="100%" />,
    }
    const state = await read($, ui)
    const now = await $.clock.now()
    // Each tab reads only what it draws: a read subscribes this drawing, so a
    // tab without live figures is not drawn again every second.
    const tab = state.tab
    const wants = {
      live: isLiveTab(tab),
      commands: tab === 'overview' || tab === 'commands' || tab === 'resources' || tab === 'prompts' || tab === 'compute',
      git: tab === 'overview' || tab === 'files' || tab === 'commits',
      touched: tab === 'files',
      sources: tab === 'overview' || tab === 'sources',
      services: tab === 'sources',
      diff: tab === 'files' || tab === 'commits' || tab === 'explorer',
      usage: tab === 'overview' || tab === 'agents' || (tab === 'commands' && state.expandedCommand !== null),
      spend: tab === 'agents' || tab === 'prompts' || (tab === 'commands' && state.expandedCommand !== null),
      artifacts: tab === 'overview',
      battery: tab === 'compute',
      models: tab === 'overview',
      // --- sources by task ---
      tasks: (tab === 'sources' && state.sourceView === 'task') || tab === 'commands',
      prompts: tab === 'commands' || tab === 'prompts' || tab === 'overview' || tab === 'compute',
      projectPrompts: tab === 'prompts',
      // --- end sources by task ---
      // --- ports ---
      ports: tab === 'ports',
      // --- end ports ---
    }
    // --- session history ---
    // The project's past sessions for the picker, and the one it shows. On the tabs a past
    // session's record stands in for this one's, the live values it replaces are not read, so
    // they do not draw the tab again.
    const hasPicker = PICKER_TABS.includes(tab)
    const viewedId = state.viewedSession ?? null
    const [historyView, chosen] = await Promise.all([hasPicker ? read($, history) : EMPTY_HISTORY, hasPicker && viewedId !== null ? read($, viewed) : null])
    const shownPast = chosen !== null && chosen.id === viewedId ? chosen : null
    const isPast = shownPast !== null && PAST_TABS.includes(tab)
    if (isPast) {
      wants.commands = false
      wants.git = false
      wants.touched = false
      wants.usage = false
      wants.spend = false
      wants.tasks = false
      wants.prompts = false
    }
    // --- end session history ---
    const [summary, power, workers, controls] = await Promise.all([
      read($, pulse),
      wants.battery ? read($, battery) : null,
      wants.models ? read($, models) : [],
      wants.models ? read($, settings) : EMPTY_SETTINGS,
    ])
    // --- agents ---
    const agentList = !isPast && (tab === 'agents' || tab === 'commands' || tab === 'overview' || tab === 'prompts') ? await read($, agents) : []
    wants.commands = wants.commands || (tab === 'agents' && !isPast)
    if (agentList.some(record => isLive(record.status))) {
      // Elapsed times tick with the sampler's writes while an agent works.
      await read($, live)
    }
    // --- end agents ---
    const [metrics, list, view, files, found, used, open, figures] = await Promise.all([
      wants.live ? read($, live) : null,
      wants.commands ? read($, commands) : [],
      wants.git ? read($, git) : EMPTY_GIT,
      wants.touched ? read($, touched) : [],
      wants.sources ? read($, sources) : [],
      wants.services ? read($, services) : [],
      wants.diff ? read($, diff) : null,
      wants.usage ? read($, usage) : null,
    ])
    const [spent, made] = await Promise.all([wants.spend ? read($, spend) : null, wants.artifacts ? read($, artifacts) : []])
    const [promptList, projectList] = await Promise.all([wants.prompts ? read($, prompts) : [], wants.projectPrompts ? read($, projectPrompts) : []])
    // --- sources by task ---
    const taskList = wants.tasks ? await read($, tasks) : []
    // --- end sources by task ---
    // --- ports ---
    const portsView = wants.ports ? await read($, ports) : null
    // --- end ports ---
    const openHistory = tab === 'agents' && state.expandedAgent !== null ? await read($, agentHistory) : null
    // --- prompt cache --- read on the Cache tab, and read again from the transcripts once it is stale
    const cached = tab === 'cache' ? await read($, cacheView) : null
    if (tab === 'cache') {
      detach(loadCache($))
    }
    // --- end prompt cache ---
    // The Agents tab opens an agent's calls in place, so it reads the open call's output too.
    const expanded = !isPast && (tab === 'commands' || tab === 'agents') ? state.expandedCommand : null
    const shown = expanded === null ? null : ((await $.state.get({ ...output, id: expanded })).value ?? '')
    // --- file tree ---
    const treeView = tab === 'files' && !isPast ? await read($, folderTree) : null
    // --- end file tree ---
    // --- explorer --- listed on first show, and again where the session moved
    const explorerView = tab === 'explorer' ? await read($, explorer) : null
    if (explorerView !== null) {
      const root = explorerView.tree.root
      const isUnlisted = root === '' || (explorerView.tree.listings[root] === undefined && !explorerView.tree.loading.includes(root) && explorerView.tree.errors[root] === undefined)
      if (isUnlisted) {
        detach(showExplorer($))
      }
    }
    // --- end explorer ---

    const setUi = (change: (current: UiState) => UiState): void => {
      detach(update($, ui, change))
    }
    const savePrefs = (change: Partial<Prefs>): void => {
      detach(savePrefsTo($, change))
    }
    const pressed = (key: string, run: () => void): void => {
      detach((async () => {
        if (!(await isBounce($, key))) {
          run()
        }
      })())
    }
    const actions: Actions = {
      // --- file tree ---
      setFilesMode: mode => detach(setFilesMode($, mode)),
      pressTree: press => detach(pressTreeRow($, press)),
      refreshTree: () => pressed('tree:refresh', () => detach(refreshTree($))),
      collapseTree: () => detach(update($, folderTree, collapseAll)),
      openInApp: path => pressed('tree:open', () => detach(openTreePath($, path, false))),
      revealInFinder: path => pressed('tree:reveal', () => detach(openTreePath($, path, true))),
      revealArtifact: id => pressed(`art:${keyOf(id)}`, () => detach(revealArtifact($, id))),
      // --- end file tree ---
      // --- explorer ---
      pressExplorer: press => detach(pressExplorerRow($, press)),
      explorerNew: (kind, dir) => detach(newExplorerEntry($, kind, dir)),
      explorerRename: path => pressed(`xp:rename:${keyOf(path)}`, () => detach(openExplorerForm($, { kind: 'rename', path }))),
      explorerFormInput: text => {
        explorerFormText = text
      },
      explorerSubmit: text => detach(submitExplorerForm($, text)),
      explorerCancel: () => {
        explorerFormText = ''
        detach(update($, explorer, current => ({ ...current, form: null })))
      },
      explorerDelete: path => detach(deleteExplorerEntry($, path)),
      explorerEdit: path => pressed(`xp:edit:${keyOf(path)}`, () => detach(startExplorerEdit($, path))),
      explorerEditInput: text => {
        const edit = explorerView?.edit
        if (edit !== null && edit !== undefined) {
          explorerEditText = { path: edit.path, text }
        }
      },
      explorerSave: text => detach(saveExplorerEdit($, text)),
      explorerCloseEdit: () => detach(closeExplorerEdit($)),
      explorerRefresh: () => pressed('xp:refresh', () => detach(refreshExplorer($))),
      explorerCollapse: () => detach(update($, explorer, current => ({ ...current, tree: collapseAll(current.tree) }))),
      explorerOpen: (path, isReveal) =>
        pressed(`xp:open:${isReveal ? 'r' : 'o'}:${keyOf(path)}`, () => detach(openPathIn($, explorerView?.tree.root ?? '', path, isReveal))),
      // --- end explorer ---
      setTab: next => setUi(current => ({ ...current, tab: next })),
      viewSession: id => detach(viewSession($, id)), // --- session history ---
      toggleCommand: id => detach(toggleCommandRow($, id)),
      // --- agents ---
      toggleAgent: id => detach(toggleAgentRow($, id)),
      // --- end agents ---
      toggleFullOutput: id => pressed(`full:${id}`, () => setUi(current => ({ ...current, fullOutput: current.fullOutput === id ? null : id }))),
      setScope: scope => savePrefs({ commandScope: scope }),
      setStatusFilter: filter => setUi(current => ({ ...current, statusFilter: filter })),
      setAccessFilter: filter => setUi(current => ({ ...current, accessFilter: filter })),
      setFilterText: text => setUi(current => ({ ...current, filterText: text })),
      showMore: () => setUi(current => ({ ...current, listLimit: current.listLimit + MORE_STEP })),
      pagePrompts: from =>
        pressed('prompts:page', () => {
          setUi(current => ({ ...current, promptsFrom: from }))
          // The page's first card, of the prompts the tab draws: a past session's while one is shown.
          const key = pageStartKey(shownPast !== null && isPast ? shownPast.prompts : promptList, from)
          if (key !== undefined) {
            detach(scrollToKey($, key))
          }
        }),
      pageEarlier: from => pressed('earlier:page', () => setUi(current => ({ ...current, earlierFrom: from }))),
      toggleAgentKids: agentId =>
        pressed(`agentfold:${keyOf(agentId)}`, () => setUi(current => ({ ...current, shownAgents: withShown(current.shownAgents, agentId, !(current.shownAgents ?? []).includes(agentId)) }))),
      pageAgentCalls: (agentId, from) =>
        pressed(`agentcalls:${keyOf(agentId)}`, () => {
          setUi(current => ({ ...current, agentCallsFrom: from }))
          detach(scrollToKey($, agentCallsKey(agentId)))
        }),
      toggleCommit: key => detach(toggleCommitRow($, key)),
      setCommitScope: (scope: CommitScope) => {
        detach((async () => {
          await update($, git, current => ({ ...current, scope }))
          await refreshGit($, true)
        })())
      },
      openFile: (commitKey, file) => detach(openCommitFile($, commitKey, file)),
      openFileRow: (row: FileRow) => detach(openFileRowOf($, row)),
      setFileFilter: filter => setUi(current => ({ ...current, fileFilter: filter })),
      setSourceFilter: filter => setUi(current => ({ ...current, sourceFilter: filter })),
      setDiffMode: mode => {
        savePrefs({ diffMode: mode })
        detach((async () => {
          const current = await read($, diff)
          if (current === null || current.kind === 'content') {
            return
          }
          const files = current.commitKey === WORKTREE ? view.worktree : (view.commits.find(one => one.sha === current.commitKey)?.files ?? [])
          const file = files.find(one => one.path === current.path)
          if (file !== undefined) {
            await openDiff($, current.commitKey, file, mode)
          }
        })())
      },
      closeOpen: () =>
        pressed('pane:closeopen', () => {
          setUi(closedAll)
          actions.closeDiff()
        }),
      closeDiff: () => {
        detach(update($, diff, () => null))
      },
      setResourceSort: sort => savePrefs({ resourceSort: sort }),
      toggleAlerts: () => savePrefs({ isAlerting: !state.isAlerting }),
      refreshGit: () => {
        detach(refreshGit($, true))
      },
      copy: (text: string, press: UiPressArgument) => {
        detach((async () => {
          const copied = await $.ui.copy({ text, surface: press.surface })
          $.ui.toast(copied.isCopied ? 'Copied.' : `Could not copy: ${copied.reason}`, { timeoutMs: 2_000 })
        })())
      },
      // --- sources by task ---
      setSourceView: view => setUi(current => ({ ...current, sourceView: view })),
      toggleTask: id => detach(toggleTaskRow($, id)),
      toggleEmptyTasks: () => pressed('emptytasks', () => setUi(current => ({ ...current, showEmptyTasks: !current.showEmptyTasks }))),
      // --- end sources by task ---
      // --- ui polish ---
      compact: () => detach(pressCompact($)),
      // --- ui polish ---
      // --- ports ---
      togglePortsRow: key => detach(togglePortsRow($, key)),
      setDevServer: (port, isOn) => detach(setDevServer($, port, isOn)),
      restartDevServer: port => detach(restartDevServer($, port)),
      toggleGroup: id => detach(toggleGroup($, id)),
      jumpToPrompt: (id, press) => jumpToPrompt($, id, press, promptList, list),
      allowFindKeys: press => pressed('find:allow', () => detach(allowFindKeys($, press))),
      showPromptCommands: taskId => pressed(`cmds:${keyOf(taskId)}`, () => detach(showPromptCommands($, taskId))),
      toggleOpenPrompt: id => pressed(`pfull:${keyOf(id)}`, () => setUi(current => ({ ...current, openPrompt: current.openPrompt === id ? null : id }))),
      revealPrompt: id => detach(revealPrompt($, id)),
      setModel: value => detach(pickSetting($, { draftModel: value })),
      setEffort: level => pressed(`effort:${level}`, () => detach(pickSetting($, { draftEffort: level }))),
      applySettings: () => pressed('settings:apply', () => detach(applySettings($))),
      setComputeRange: range => savePrefs({ computeRange: range }),
      procAction: (target, action) => detach(pressProcAction($, target, action)),
      refreshPorts: () => detach(refreshPortsNow($)),
      refreshCache: () => pressed('cache:refresh', () => detach(loadCache($, true))),
      // --- end ports ---
    }
    const data: PaneData = {
      surface: e.surface,
      columns: e.props.bodyColumns,
      now,
      ui: state,
      // --- file tree ---
      tree: treeView,
      // --- end file tree ---
      // --- explorer ---
      explorer:
        explorerView === null
          ? null
          : {
              view: explorerView,
              formText: explorerFormText,
              editText: explorerView.edit !== null && explorerEditText?.path === explorerView.edit.path ? explorerEditText.text : null,
              canEdit: canEditInPane,
            },
      // --- end explorer ---
      live: metrics,
      commands: list,
      // --- agents ---
      agents: agentList,
      agentHistory: openHistory,
      cache: cached,
      // --- end agents ---
      git: view,
      touched: files,
      sources: found,
      services: used,
      diff: open,
      usage: figures,
      output: shown,
      pulse: summary.t > 0 ? summary : null,
      battery: power,
      models: workers,
      settings: controls,
      spend: spent,
      artifacts: made,
      prompts: promptList,
      projectPrompts: projectList,
      sessionId,
      memTotal,
      space: spaceFor(e.surface),
      // --- sources by task ---
      tasks: taskList,
      // --- end sources by task ---
      // --- ports ---
      ports: portsView,
      // --- end ports ---
      // --- session history ---
      sessions: historyView.entries,
      viewed: shownPast,
      // --- end session history ---
    }
    // --- session history ---
    // A past session's prompts are in another conversation; its diffs open from its own record.
    const shownActions: Actions =
      shownPast === null
        ? actions
        : {
            ...actions,
            jumpToPrompt: async (id, press) => (promptList.some(one => one.id === id) ? actions.jumpToPrompt(id, press) : pastJump($)),
            setDiffMode: mode => {
              if (!isPast) {
                actions.setDiffMode(mode)
                return
              }
              savePrefs({ diffMode: mode })
              detach(reopenPastDiff($, shownPast, mode))
            },
          }
    return pane(shownPast !== null && PAST_TABS.includes(tab) ? pastData(data, shownPast) : data, kit, shownActions)
    // --- end session history ---
  })

  // --- agents ---
  // Each spawn names the agent it started and, for a workflow's agent, its run.
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    const agentId = spawned.agentId
    if (agentId !== undefined) {
      const spawn: SpawnFacts = {
        agentId,
        toolUseId: e.tool_use_id,
        description: e.description,
        subagentType: e.subagentType,
        model: spawned.model,
        prompt: e.prompt,
        name: e.name,
        teammateId: spawned.teammateId,
        parentAgentId: e.parentAgentId,
        isBackground: e.background,
        isTeammate: e.isTeammate === true,
        workflow: e.workflow,
      }
      queueAgents(() => agentSpawned($, spawn))
      // Its calls and requests are the work of the prompt it serves: at once its parent's (a nested
      // agent's), its call's earlier agents' or the turn's; then the one its words show it serves.
      const parentTask = e.parentAgentId !== undefined ? agentPrompt.get(e.parentAgentId) : undefined
      const under = parentTask ?? (e.tool_use_id !== '' ? callPrompt.get(e.tool_use_id) : undefined) ?? promptTask
      if (under !== undefined) {
        agentPrompt.set(agentId, under)
      }
      const served: SpawnFor = {
        agentId,
        toolUseId: e.tool_use_id,
        words: `${e.description}\n${e.prompt}`,
        parentAgentId: e.parentAgentId,
        turnTask: promptTask,
        turn: mainTurn,
      }
      queuePrompts(() => attributeSpawn($, served))
    }
    return spawned
  }).catch(($, e, next) => next(e))

  // The background tasks in flight when the main loop stops: a workflow no longer among them has ended.
  on('classic.Stop', ($, e, next) => {
    const inFlight = e.background_tasks
    if (inFlight !== undefined) {
      const tasks: TaskSnapshot[] = inFlight.map(task => ({ id: task.id, type: task.type, description: task.description, name: task.name }))
      queueAgents(() => agentTasksSettled($, tasks))
    }
    return next(e)
  })
  // --- end agents ---

  // --- session history ---
  // The session ends: its record saved a last time, within the exit's short bound. After a
  // `/clear` or a resume the process goes on under another id, whose record begins now.
  on('session.end', async ($, e, next) => {
    const isNewId = e.reason === 'clear' || e.reason === 'resume'
    try {
      saveTimer?.cancel()
      saveTimer = undefined
      if (next.budget.remainingMs > 250) {
        await saveSession($, e.sessionId)
      }
      if (isNewId) {
        const now = await $.clock.now()
        lastSave = undefined
        await update($, history, (view): HistoryView => ({ ...view, floor: now }))
      }
    } catch {
      // Saving never stands in the way of an end.
    }
    const ended = await next(e)
    if (isNewId) {
      detach(refreshEntries($))
    }
    return ended
  })
  // --- end session history ---
}

const batteryLine = (power: BatteryView): string => {
  if (!power.hasBattery || power.start === null || power.latest === null) {
    return ''
  }
  const result = attribute(power.start, power.latest)
  const head = `- **Battery:** ${power.start.percent}% → ${power.latest.percent}% over ${fmtDuration(result.minutes * 60_000)}`
  if (result.state === 'measured') {
    return `${head} · the work ≈${fmtEnergy(result.workJ)} of ${fmtEnergy(result.drainJ)} drained (${(result.sharePct ?? 0).toFixed(0)}% of the drop)`
  }
  return `${head} · ${result.state === 'on-power' ? 'on the power adapter' : 'no charge lost yet'}; the work ≈${fmtEnergy(result.workJ)}`
}

/** The /monitor-report text: what this session cost in network, time, energy and change. */
export const report = (
  metrics: LiveMetrics,
  list: readonly CommandRecord[],
  view: GitView,
  figures: UsageView,
  found: readonly SourceRecord[],
  now: number,
  power: BatteryView,
  workers: readonly ModelUse[],
  // --- sources by task ---
  taskList: readonly TaskLabel[] = [],
  // --- end sources by task ---
  spent: SpendView = EMPTY_SPEND,
  made: readonly ArtifactRecord[] = [],
): string => {
  const s = metrics.session
  const bash = list.filter(record => record.tool === 'Bash')
  const all = timeStats(bash, now)
  const classes = byAccess(bash, now)
  const energy = (record: CommandRecord): number => record.metrics.energyJ + record.metrics.energyEstJ
  const net = (record: CommandRecord): number => record.metrics.netIn + record.metrics.netOut
  const cell = (text: string): string => oneLine(text, 80).replace(/\|/g, '\\|')
  const rows = (score: (record: CommandRecord) => number, format: (record: CommandRecord) => string): string[] =>
    [...bash]
      .filter(record => score(record) > 0)
      .sort((a, b) => score(b) - score(a))
      .slice(0, 5)
      .map(record => `| ${format(record)} | ${accessWord(record.access)} | \`${cell(record.title)}\` |`)
  const changes = summarize(sessionChanges(view.commits, view.worktree))
  const commits = view.commits.filter(commit => commit.isSession)
  const sourceSummary = summarizeSources(found)
  const bytes = s.netIn + s.netOut
  const lines = [
    '## Session Monitor report',
    '',
    `- **Internet:** ↓ ${fmtBytes(s.netIn)} down, ↑ ${fmtBytes(s.netOut)} up · active ${fmtDuration(s.netActiveS * 1000)} at ${fmtRate(activeRate(bytes, s.netActiveS))} while active`,
    `- **Energy:** ${s.energyEstJ > 0 ? '≈' : ''}${fmtEnergy(s.energyJ + s.energyEstJ)} · CPU time ${fmtCpuSeconds(s.cpuS)} · now ${fmtWatts(s.watts)}`,
    `- **Memory:** ${fmtBytes(s.mem)} now, ${fmtBytes(metrics.peakMem)} peak`,
    `- **Commands:** ${all.count} run in ${fmtDuration(all.totalMs)} (avg ${fmtDuration(all.avgMs)}), ${all.failed} failed, ${list.length - bash.length} other tool calls`,
    ...ACCESSES.map(access => `  - ${accessWord(access)}: ${classes[access].count} in ${fmtDuration(classes[access].totalMs)}`),
    `- **Sources:** ${sourceSummary.urls} URLs on ${sourceSummary.domains} websites, ${sourceSummary.searches} searches, ${sourceSummary.fetched} pages opened`,
    `- **Files:** ${changes.added} added, ${changes.modified} modified, ${changes.deleted} deleted (+${changes.plus} −${changes.minus}) · ${commits.length} commits this session`,
    figures.costUsd !== undefined ? `- **Cost:** ${fmtUsd(figures.costUsd)}${figures.contextPct !== undefined ? ` · context ${figures.contextPct}%` : ''}` : '',
    batteryLine(power),
    spent.requests > 0
      ? `- **Model requests:** ${spent.requests} at list prices ≈ ${fmtUsd(spent.totalUsd)}${spent.block !== null ? ` · ${fmtUsd(spent.block.usd)} in the current 5-hour window` : ''}`
      : '',
    ...workers.map(
      use => `- **${shortModel(use.model)} · ${use.effort}:** ${use.prompts} prompts, ${use.turns} turns, ${use.requests} requests, ${use.toolCalls} tool calls`,
    ),
  ]
  const slowRows = rows(record => elapsedMs(record, now), record => fmtDuration(elapsedMs(record, now)))
  if (slowRows.length > 0) {
    lines.push('', '### Longest commands', '', '| Time | Access | Command |', '| --- | --- | --- |', ...slowRows)
  }
  const energyRows = rows(energy, record => `${record.metrics.energyEstJ > 0 ? '≈' : ''}${fmtEnergy(energy(record))}`)
  if (energyRows.length > 0) {
    lines.push('', '### Most energy', '', '| Energy | Access | Command |', '| --- | --- | --- |', ...energyRows)
  }
  const netRows = rows(net, record => `${fmtBytes(net(record))} in ${fmtDuration(record.metrics.netActiveS * 1000)}`)
  if (netRows.length > 0) {
    lines.push('', '### Most network', '', '| Bytes | Access | Command |', '| --- | --- | --- |', ...netRows)
  }
  const costRows = [...list]
    .filter(record => record.spend !== undefined)
    .sort((a, b) => (b.spend?.usd ?? 0) - (a.spend?.usd ?? 0))
    .slice(0, 5)
    .map(record => `| ≈ ${fmtUsd(record.spend?.usd ?? 0)} | ${cell(record.tool)} | ${cell(record.summary)} |`)
  if (costRows.length > 0) {
    lines.push('', '### Most expensive calls', '', '| Cost | Tool | What it did |', '| --- | --- | --- |', ...costRows)
  }
  if (made.length > 0) {
    lines.push(
      '',
      '### Artifacts',
      '',
      ...made.map(one => (one.kind === 'page' ? `- [${cell(one.title)}](${one.url ?? ''})${one.count > 1 ? ` · published ${one.count}×` : ''}` : `- Sent \`${cell(one.path ?? one.title)}\``)),
    )
  }
  const domains = byDomain(found)
  if (domains.length > 0) {
    lines.push('', '### Websites used', '')
    for (const group of domains.slice(0, 20)) {
      lines.push(`- **${group.domain}** (${group.sources.length})`)
      lines.push(...group.sources.slice(0, 10).map(source => `  - ${source.url ?? ''}`))
    }
  }
  // --- sources by task ---
  lines.push(...taskReportLines(taskList, found, now))
  // --- end sources by task ---
  if (commits.length > 0) {
    lines.push('', '### Commits this session', '', ...commits.map(commit => `- \`${commit.short}\` ${commit.subject}`))
  }
  return lines.filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n')
}
