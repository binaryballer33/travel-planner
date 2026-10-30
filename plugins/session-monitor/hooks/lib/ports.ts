// The Ports tab's pure logic: the helper's (sampler/procs.py) JSON read with
// guards, the dev servers' status, which processes a press may signal, and
// the two-step Kill.

import type {
  ClaudeSession,
  DevLog,
  DevPhase,
  DevServerConfig,
  DevServerLive,
  KillArmed,
  ListenerOwner,
  PortListener,
  PortsView,
  ProcNode,
  ProcState,
  UiState,
} from '../../types'
import type { Tone } from './format'
import { isAbsolutePath } from './tree'

/** How often the listing is read while the Ports tab is open. */
export const PORTS_POLL_MS = 3_000
/** How often a starting dev server is checked, and for how long. */
export const START_POLL_MS = 1_000
export const START_TIMEOUT_MS = 60_000
/** How long a first press of Kill waits for the confirming one. */
export const ARM_MS = 6_000
/** Seconds Turn off waits after SIGTERM before SIGKILL. */
export const STOP_TIMEOUT_S = 5
export const DEV_SERVERS_KEY = 'devServers'
const MAX_DEV_SERVERS = 12

const QTA = '/Users/shaquillemandy/Trading/quant-trade-analysis'

/**
 * The web app's `dev` script (`task dev`) sets `NODE_OPTIONS='--inspect=8133'`,
 * and Next.js puts its worker's debugger on the next port, 8134: the API's.
 * So the web app starts here as that script does, without the debugger.
 */
export const WEB_DEV_COMMAND = 'bun run --cwd apps/web next dev -p 8133'

/** What 8133 ran before: the web app's debugger took the API's port. */
const OLD_WEB_DEV_COMMAND = 'task dev'

export const DEFAULT_DEV_SERVERS: readonly DevServerConfig[] = [
  { port: 8133, name: 'Trade analysis web app', cwd: QTA, command: WEB_DEV_COMMAND, url: 'http://localhost:8133' },
  { port: 8134, name: 'Trade analysis API', cwd: QTA, command: 'task dev:api', url: 'http://127.0.0.1:8134/docs' },
]

/** Saved settings with the web app's old command moved to the one that leaves 8134 free; `changed` when one was. */
export const migrateDevServers = (configs: readonly DevServerConfig[]): { configs: DevServerConfig[]; changed: boolean } => {
  let changed = false
  const moved = configs.map(config => {
    if (config.port === 8133 && config.cwd === QTA && config.command.trim() === OLD_WEB_DEV_COMMAND) {
      changed = true
      return { ...config, command: WEB_DEV_COMMAND }
    }
    return config
  })
  return { configs: moved, changed }
}

export const EMPTY_PORTS: PortsView = {
  updatedAt: 0,
  uid: -1,
  home: '',
  logDir: '',
  sessions: [],
  listeners: [],
  devServers: [],
  logs: [],
  configs: [...DEFAULT_DEV_SERVERS],
  phases: [],
}

/** What one `procs.py snapshot` reports. */
export type PortsSnapshot = {
  uid: number
  home: string
  logDir: string
  sessions: ClaudeSession[]
  listeners: PortListener[]
  devServers: DevServerLive[]
  logs: DevLog[]
  /** How many processes remain in each watched process group. */
  groups: { pgid: number; alive: number }[]
}

export type ProcAction = 'suspend' | 'resume' | 'kill' | 'force'

export const SIGNAL_OF: Readonly<Record<ProcAction, 'STOP' | 'CONT' | 'TERM' | 'KILL'>> = {
  suspend: 'STOP',
  resume: 'CONT',
  kill: 'TERM',
  force: 'KILL',
}

/** A process a row's buttons act on. */
export type ProcTarget = {
  pid: number
  startedAt: number
  name: string
  uid: number
  state: ProcState
  /** This pane's own Claude process. */
  isThis: boolean
  isMonitor: boolean
}

export type ActionResult = { ok: boolean; message: string }
export type LaunchResult = ActionResult & { pid: number; pgid: number }
export type StopResult = ActionResult & { isFree: boolean; forced: boolean }

// ------------------------------------------------------------------------- //
// Reading the helper's JSON
// ------------------------------------------------------------------------- //

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

const num = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

const nums = (value: unknown): number[] =>
  Array.isArray(value) ? value.filter((one): one is number => typeof one === 'number' && Number.isFinite(one)) : []

const list = <T>(value: unknown, read: (one: unknown) => T | undefined): T[] =>
  Array.isArray(value) ? value.map(read).filter((one): one is T => one !== undefined) : []

const STATES: readonly ProcState[] = ['running', 'suspended', 'zombie']
const OWNERS: readonly ListenerOwner[] = ['claude', 'dev', 'other']

const stateOf = (value: unknown): ProcState => STATES.find(one => one === value) ?? 'running'

const parseJson = (text: string): unknown => {
  const line = text.trim().split('\n').pop() ?? ''
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

const procNode = (value: unknown): ProcNode | undefined => {
  if (!isRecord(value) || typeof value.pid !== 'number') {
    return undefined
  }
  return {
    pid: value.pid,
    ppid: num(value.ppid),
    pgid: num(value.pgid),
    uid: num(value.uid, -1),
    name: str(value.name) || 'process',
    state: stateOf(value.state),
    cpuPct: num(value.cpuPct),
    memBytes: num(value.memBytes),
    startedAt: num(value.startedAt),
    ports: nums(value.ports),
    depth: num(value.depth),
    isMonitor: value.isMonitor === true,
  }
}

const session = (value: unknown): ClaudeSession | undefined => {
  const node = procNode(value)
  if (node === undefined || !isRecord(value)) {
    return undefined
  }
  return { ...node, cwd: str(value.cwd), isThis: value.isThis === true, children: list(value.children, procNode) }
}

const listener = (value: unknown): PortListener | undefined => {
  if (!isRecord(value) || typeof value.port !== 'number' || typeof value.pid !== 'number') {
    return undefined
  }
  const found: PortListener = {
    port: value.port,
    address: str(value.address) || '*',
    pid: value.pid,
    name: str(value.name) || '?',
    uid: num(value.uid, -1),
    owner: OWNERS.find(one => one === value.owner) ?? 'other',
    startedAt: num(value.startedAt),
    state: stateOf(value.state),
    isMonitor: value.isMonitor === true,
  }
  if (typeof value.sessionPid === 'number') {
    found.sessionPid = value.sessionPid
  }
  return found
}

const devServer = (value: unknown): DevServerLive | undefined => {
  if (!isRecord(value) || typeof value.port !== 'number') {
    return undefined
  }
  return {
    port: value.port,
    pids: nums(value.pids),
    pgid: num(value.pgid),
    name: str(value.name) || 'server',
    startedAt: num(value.startedAt),
    cpuPct: num(value.cpuPct),
    memBytes: num(value.memBytes),
    procs: num(value.procs),
    cwd: str(value.cwd),
    isGroupSafe: value.isGroupSafe === true,
  }
}

const devLog = (value: unknown): DevLog | undefined =>
  isRecord(value) && typeof value.port === 'number'
    ? { port: value.port, lines: Array.isArray(value.lines) ? value.lines.filter((one): one is string => typeof one === 'string') : [] }
    : undefined

const group = (value: unknown): { pgid: number; alive: number } | undefined =>
  isRecord(value) && typeof value.pgid === 'number' ? { pgid: value.pgid, alive: num(value.alive) } : undefined

const failure = (value: unknown, fallback: string): string => (isRecord(value) && typeof value.message === 'string' ? value.message : fallback)

/** One `procs.py snapshot` answer, or why it could not be read. */
export const parseSnapshot = (text: string): PortsSnapshot | { error: string } => {
  const value = parseJson(text)
  if (!isRecord(value) || value.ok !== true) {
    return { error: failure(value, 'The process helper printed nothing readable.') }
  }
  return {
    uid: num(value.uid, -1),
    home: str(value.home),
    logDir: str(value.logDir),
    sessions: list(value.sessions, session),
    listeners: list(value.listeners, listener),
    devServers: list(value.devServers, devServer),
    logs: list(value.logs, devLog),
    groups: list(value.groups, group),
  }
}

export const parseResult = (text: string): ActionResult => {
  const value = parseJson(text)
  return { ok: isRecord(value) && value.ok === true, message: failure(value, 'The process helper printed nothing readable.') }
}

export const parseLaunch = (text: string): LaunchResult => {
  const value = parseJson(text)
  const result = parseResult(text)
  const pid = isRecord(value) ? num(value.pid) : 0
  return { ...result, ok: result.ok && pid > 1, pid, pgid: isRecord(value) ? num(value.pgid, pid) : 0 }
}

export const parseStop = (text: string): StopResult => {
  const value = parseJson(text)
  return { ...parseResult(text), isFree: isRecord(value) && value.isFree === true, forced: isRecord(value) && value.forced === true }
}

/** The dev servers kept in `$.store`, or undefined when there are none worth keeping. */
export const readDevServers = (value: unknown): DevServerConfig[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined
  }
  const configs = value
    .filter(isRecord)
    .filter(one => typeof one.port === 'number' && Number.isInteger(one.port) && one.port > 0 && one.port < 65_536)
    .map(one => ({ port: num(one.port), name: str(one.name) || `:${num(one.port)}`, cwd: str(one.cwd), command: str(one.command), url: str(one.url) }))
    .filter(one => isAbsolutePath(one.cwd) && one.command.trim() !== '')
  const unique = configs.filter((one, index) => configs.findIndex(other => other.port === one.port) === index).slice(0, MAX_DEV_SERVERS)
  return unique.length > 0 ? unique : undefined
}

// ------------------------------------------------------------------------- //
// The view
// ------------------------------------------------------------------------- //

/** The listing a snapshot makes, keeping the dev servers' settings and pending actions. */
export const applySnapshot = (view: PortsView, snapshot: PortsSnapshot, now: number): PortsView => ({
  ...view,
  updatedAt: now,
  uid: snapshot.uid,
  home: snapshot.home,
  logDir: snapshot.logDir,
  sessions: snapshot.sessions,
  listeners: snapshot.listeners,
  devServers: snapshot.devServers,
  logs: snapshot.logs,
  error: undefined,
})

export const withPhase = (phases: readonly DevPhase[], port: number, phase: DevPhase['phase'], now: number): DevPhase[] => [
  ...phases.filter(one => one.port !== port),
  { port, phase, since: now },
]

export const withoutPhase = (phases: readonly DevPhase[], port: number): DevPhase[] => phases.filter(one => one.port !== port)

export type DevStatusKind = 'listening' | 'stopped' | 'starting' | 'stopping' | 'taken'

export type DevStatus = {
  kind: DevStatusKind
  text: string
  tone: Tone
  live?: DevServerLive
  /** What holds the port when it is not the server. */
  holder?: PortListener
  /** Another dev server whose processes hold this port (the web app's debugger on the API's). */
  heldBy?: DevServerConfig
}

/** True when the listener runs from the server's folder (or the folder is unknown). */
export const isServerItself = (config: DevServerConfig, live: DevServerLive): boolean =>
  live.cwd === '' || live.cwd === config.cwd || live.cwd.startsWith(`${config.cwd.replace(/\/$/, '')}/`)

/** Whether one listener's processes began before another's: by start time, then by pid. */
const startedBefore = (a: DevServerLive, b: DevServerLive): boolean =>
  a.startedAt < b.startedAt || (a.startedAt === b.startedAt && Math.min(...a.pids) < Math.min(...b.pids))

export const devStatus = (config: DevServerConfig, view: PortsView): DevStatus => {
  const phase = view.phases.find(one => one.port === config.port)
  const live = view.devServers.find(one => one.port === config.port && one.pids.length > 0)
  if (phase !== undefined) {
    return { kind: phase.phase, text: phase.phase === 'starting' ? '◌ starting…' : '◌ stopping…', tone: 'warning', live }
  }
  if (live === undefined) {
    return { kind: 'stopped', text: '○ stopped', tone: 'inactive' }
  }
  // A listener in another dev server's process group, started after that
  // server's own listener, is that server's (its worker's debugger), not this one.
  const heldBy = view.configs.find(
    other =>
      other.port !== config.port &&
      live.pgid > 0 &&
      view.devServers.some(one => one.port === other.port && one.pgid === live.pgid && one.pids.length > 0 && startedBefore(one, live)),
  )
  if (heldBy !== undefined) {
    const holder = view.listeners.find(one => one.port === config.port)
    return { kind: 'taken', text: `✗ held by ${heldBy.name} (:${heldBy.port})`, tone: 'error', live, holder, heldBy }
  }
  if (!isServerItself(config, live)) {
    const holder = view.listeners.find(one => one.port === config.port)
    return { kind: 'taken', text: `✗ taken by ${holder?.name ?? live.name}`, tone: 'error', live, holder }
  }
  return { kind: 'listening', text: '● listening', tone: 'success', live }
}

/** Dev servers running now, for the tab's label. */
export const runningCount = (view: PortsView): number => view.configs.filter(config => devStatus(config, view).kind === 'listening').length

/** Listeners of Claude sessions and dev servers first, by port; everything else after. */
export const splitListeners = (listeners: readonly PortListener[]): { mine: PortListener[]; others: PortListener[] } => {
  const byPort = (a: PortListener, b: PortListener): number => a.port - b.port || a.pid - b.pid
  return {
    mine: listeners.filter(one => one.owner !== 'other').sort(byPort),
    others: listeners.filter(one => one.owner === 'other').sort(byPort),
  }
}

/** A session's figures with everything under it. */
export const sessionTotals = (one: ClaudeSession): { cpuPct: number; memBytes: number } => ({
  cpuPct: one.children.reduce((total, child) => total + child.cpuPct, one.cpuPct),
  memBytes: one.children.reduce((total, child) => total + child.memBytes, one.memBytes),
})

/**
 * Where a dev server's link goes: a loopback address spelled `localhost`, the
 * one plain-http host the desktop app makes a link of (browsers try both
 * 127.0.0.1 and ::1 for it).
 */
export const linkHref = (url: string): string => url.replace(/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?=[:/]|$)/, 'http://localhost')

export const tildePath = (path: string, home: string): string =>
  home !== '' && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path

/** The last few lines of a log, for a toast. */
export const logTail = (lines: readonly string[], count: number): string =>
  lines
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('=== '))
    .slice(-count)
    .join(' ⏎ ')

// ------------------------------------------------------------------------- //
// Which presses may act, and the two-step Kill
// ------------------------------------------------------------------------- //

export const targetOf = (node: ProcNode, isThis: boolean): ProcTarget => ({
  pid: node.pid,
  startedAt: node.startedAt,
  name: node.name,
  uid: node.uid,
  state: node.state,
  isThis,
  isMonitor: node.isMonitor,
})

export const listenerTarget = (one: PortListener, thisPid: number | undefined): ProcTarget => ({
  pid: one.pid,
  startedAt: one.startedAt,
  name: one.name,
  uid: one.uid,
  state: one.state,
  isThis: one.pid === thisPid,
  isMonitor: one.isMonitor,
})

/**
 * Whether the pane offers signals for a process, and why not. procs.py checks
 * the same again (with the process's identity) right before it signals.
 */
export const verdict = (target: ProcTarget, uid: number): { canSignal: boolean; reason: string } => {
  if (target.pid <= 1) {
    return { canSignal: false, reason: 'pid 1 and below belong to the system' }
  }
  if (target.isThis) {
    return { canSignal: false, reason: 'this is the Claude process running this pane' }
  }
  if (target.isMonitor) {
    return { canSignal: false, reason: 'this is the Session Monitor’s own helper' }
  }
  if (uid < 0 || target.uid !== uid) {
    return { canSignal: false, reason: `owned by another user (uid ${target.uid})` }
  }
  if (target.state === 'zombie') {
    return { canSignal: false, reason: 'it has already exited (its parent has not collected it yet)' }
  }
  return { canSignal: true, reason: '' }
}

export const actionsFor = (target: ProcTarget): ProcAction[] =>
  target.state === 'suspended' ? ['resume', 'kill', 'force'] : ['suspend', 'kill', 'force']

export const needsConfirm = (action: ProcAction): boolean => action === 'kill' || action === 'force'

export const armKey = (action: ProcAction, pid: number): string => `${action}:${pid}`

export const isArmed = (armed: KillArmed | null, key: string, now: number): boolean =>
  armed !== null && armed.key === key && now - armed.at < ARM_MS

/** A press of Kill: the first arms it, a second within ARM_MS acts; a late one arms it again. */
export const confirmStep = (armed: KillArmed | null, key: string, now: number): { isConfirmed: boolean; armed: KillArmed | null } =>
  isArmed(armed, key, now) ? { isConfirmed: true, armed: null } : { isConfirmed: false, armed: { key, at: now } }

export const actionLabel = (action: ProcAction, target: ProcTarget, armed: KillArmed | null, now: number): string => {
  const isWaiting = isArmed(armed, armKey(action, target.pid), now)
  switch (action) {
    case 'suspend':
      return 'Suspend'
    case 'resume':
      return 'Resume'
    case 'kill':
      return isWaiting ? `Click again to kill ${target.name}` : 'Kill'
    case 'force':
      return isWaiting ? `Click again to force kill ${target.name}` : 'Force kill'
  }
}

export const actionVerb = (action: ProcAction): string =>
  action === 'suspend' ? 'suspend' : action === 'resume' ? 'resume' : action === 'kill' ? 'kill' : 'force kill'

// ------------------------------------------------------------------------- //
// Keys, the UI fields, the helper's argv
// ------------------------------------------------------------------------- //

export const devKey = (port: number): string => `pt:dev:${port}`
export const procKey = (pid: number): string => `pt:proc:${pid}`
export const listenerKey = (pid: number, port: number): string => `pt:lis:${pid}:${port}`
export const OTHER_KEY = 'pt:other'

/** The Ports tab's UI fields, read safely from a state an older load wrote. */
export const portsUi = (state: UiState): { open: string[]; armed: KillArmed | null; isOtherOpen: boolean } => {
  const open: unknown = state.portsOpen
  const armed: unknown = state.killArmed
  return {
    open: Array.isArray(open) ? open.filter((one): one is string => typeof one === 'string') : [],
    armed: isRecord(armed) && typeof armed.key === 'string' && typeof armed.at === 'number' ? { key: armed.key, at: armed.at } : null,
    isOtherOpen: state.portsOtherOpen === true,
  }
}

export const toggled = (open: readonly string[], key: string): string[] =>
  open.includes(key) ? open.filter(one => one !== key) : [...open, key].slice(-40)

export const snapshotArgs = (configs: readonly DevServerConfig[], tails: readonly number[], watch: readonly number[]): string[] => [
  'snapshot',
  '--dev',
  configs.map(one => one.port).join(','),
  ...(tails.length > 0 ? ['--tail', tails.join(',')] : []),
  ...(watch.length > 0 ? ['--watch', watch.join(',')] : []),
]

export const signalArgs = (action: ProcAction, target: ProcTarget): string[] => [
  'signal',
  SIGNAL_OF[action],
  String(target.pid),
  String(Math.round(target.startedAt)),
]

export const launchArgs = (config: DevServerConfig): string[] => ['launch', String(config.port), config.cwd, config.command]

export const stopArgs = (port: number): string[] => ['stop', String(port), String(STOP_TIMEOUT_S)]
