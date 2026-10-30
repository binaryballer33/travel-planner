import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { DevServerConfig, PortListener, PortsView, ProcNode, UiState } from '../types'
import {
  actionLabel,
  actionsFor,
  applySnapshot,
  confirmStep,
  DEFAULT_DEV_SERVERS,
  devStatus,
  EMPTY_PORTS,
  launchArgs,
  linkHref,
  logTail,
  migrateDevServers,
  parseLaunch,
  parseResult,
  parseSnapshot,
  parseStop,
  portsUi,
  readDevServers,
  sessionTotals,
  signalArgs,
  snapshotArgs,
  splitListeners,
  stopArgs,
  targetOf,
  tildePath,
  toggled,
  verdict,
  WEB_DEV_COMMAND,
  type PortsSnapshot,
  type ProcTarget,
} from '../hooks/lib/ports'
import { DEFAULT_UI } from '../hooks/register'
import { CARD_BACKGROUND } from '../hooks/view/kit'
import { DEV_CARD_KEY, LISTENERS_CARD_KEY, portsCardKey, PORTS_SUMMARY_KEY, SESSIONS_CARD_KEY } from '../hooks/view/ports'
import { clickRow, fail, keysOf, NOW, ok, PANE, RAM, run, textsIn, tabButton } from './world'

const QTA = '/Users/shaquillemandy/Trading/quant-trade-analysis'
const HOME = '/Users/shaquillemandy'

const node = (pid: number, fields: Partial<ProcNode> = {}): ProcNode => ({
  pid,
  ppid: 10,
  pgid: 10,
  uid: 501,
  name: `proc ${pid}`,
  state: 'running',
  cpuPct: 0,
  memBytes: 1e6,
  startedAt: NOW - 60_000,
  ports: [],
  depth: 1,
  isMonitor: false,
  ...fields,
})

const target = (fields: Partial<ProcTarget> = {}): ProcTarget => ({
  pid: 40,
  startedAt: NOW - 60_000,
  name: 'python3 serve.py',
  uid: 501,
  state: 'running',
  isThis: false,
  isMonitor: false,
  ...fields,
})

const listener = (port: number, pid: number, owner: PortListener['owner'], fields: Partial<PortListener> = {}): PortListener => ({
  port,
  address: '127.0.0.1',
  pid,
  name: `proc ${pid}`,
  uid: 501,
  owner,
  startedAt: NOW - 60_000,
  state: 'running',
  isMonitor: false,
  ...fields,
})

const API: DevServerConfig = DEFAULT_DEV_SERVERS[1] ?? { port: 8134, name: '', cwd: '', command: '', url: '' }

describe('the dev servers', () => {
  test('default to the trade analysis web app and API', () => {
    expect(DEFAULT_DEV_SERVERS.map(one => [one.port, one.command, one.cwd])).toEqual([
      // The web app's dev script without NODE_OPTIONS='--inspect=8133', whose worker debugger took :8134.
      [8133, 'bun run --cwd apps/web next dev -p 8133', QTA],
      [8134, 'task dev:api', QTA],
    ])
    expect(WEB_DEV_COMMAND).not.toContain('inspect')
    expect(EMPTY_PORTS.configs).toEqual([...DEFAULT_DEV_SERVERS])
  })

  test("saved settings move the web app off `task dev`; anything else is kept", () => {
    const old = [{ ...(DEFAULT_DEV_SERVERS[0] ?? API), command: 'task dev' }, API]
    expect(migrateDevServers(old)).toEqual({ configs: [...DEFAULT_DEV_SERVERS], changed: true })
    expect(migrateDevServers([...DEFAULT_DEV_SERVERS])).toEqual({ configs: [...DEFAULT_DEV_SERVERS], changed: false })
    const custom = [{ ...(DEFAULT_DEV_SERVERS[0] ?? API), command: 'bun run dev:fast' }, { ...API, command: 'task dev' }]
    expect(migrateDevServers(custom)).toEqual({ configs: custom, changed: false })
  })

  test("a port held by another dev server's process group is that server's (the web app's debugger on the API's port)", () => {
    const web = { port: 8133, pids: [700], pgid: 700, name: 'node next dev', startedAt: NOW, cpuPct: 3, memBytes: 3e8, procs: 5, cwd: QTA, isGroupSafe: true }
    const debuggerPort = { ...web, port: 8134, pids: [701], cwd: `${QTA}/apps/web` }
    const view: PortsView = {
      ...EMPTY_PORTS,
      updatedAt: NOW,
      devServers: [web, debuggerPort],
      listeners: [listener(8133, 700, 'dev', { name: 'node next dev' }), listener(8134, 701, 'dev', { name: 'node next-server' })],
    }
    const held = devStatus(API, view)
    expect(held).toMatchObject({ kind: 'taken', text: '✗ held by Trade analysis web app (:8133)', tone: 'error' })
    expect(held.heldBy?.port).toBe(8133)
    expect(devStatus(DEFAULT_DEV_SERVERS[0] ?? API, view).kind).toBe('listening')
    // The API in a group of its own is the API.
    expect(devStatus(API, { ...view, devServers: [web, { ...debuggerPort, pgid: 890 }] }).kind).toBe('listening')
  })

  test('read from the store with guards', () => {
    expect(readDevServers(undefined)).toBeUndefined()
    expect(readDevServers([])).toBeUndefined()
    expect(readDevServers({ port: 1 })).toBeUndefined()
    const read = readDevServers([
      { port: 3000, name: 'Docs', cwd: '/srv/docs', command: 'npm start', url: 'http://localhost:3000' },
      { port: 3000, name: 'Again', cwd: '/srv/again', command: 'npm start' },
      { port: 70_000, cwd: '/srv', command: 'x' },
      { port: 4000, cwd: 'relative', command: 'x' },
      { port: 5000, cwd: '/srv', command: '   ' },
      'nonsense',
      { port: 6000, cwd: '/srv/api', command: 'make api' },
    ])
    expect(read).toEqual([
      { port: 3000, name: 'Docs', cwd: '/srv/docs', command: 'npm start', url: 'http://localhost:3000' },
      { port: 6000, name: ':6000', cwd: '/srv/api', command: 'make api', url: '' },
    ])
  })

  test('status: stopped, starting, listening, stopping, taken by another program', () => {
    const view: PortsView = { ...EMPTY_PORTS, updatedAt: NOW }
    expect(devStatus(API, view).kind).toBe('stopped')
    expect(devStatus(API, view).tone).toBe('inactive')
    const starting = { ...view, phases: [{ port: 8134, phase: 'starting' as const, since: NOW }] }
    expect(devStatus(API, starting)).toMatchObject({ kind: 'starting', text: '◌ starting…', tone: 'warning' })
    const live = { port: 8134, pids: [900], pgid: 890, name: 'uv run uvicorn', startedAt: NOW, cpuPct: 1, memBytes: 1e8, procs: 3, cwd: QTA, isGroupSafe: true }
    const up = { ...view, devServers: [live], listeners: [listener(8134, 900, 'dev')] }
    expect(devStatus(API, up)).toMatchObject({ kind: 'listening', text: '● listening', tone: 'success' })
    expect(devStatus(API, { ...up, devServers: [{ ...live, cwd: `${QTA}/api` }] }).kind).toBe('listening')
    expect(devStatus(API, { ...up, phases: [{ port: 8134, phase: 'stopping', since: NOW }] }).text).toBe('◌ stopping…')
    const taken = { ...up, devServers: [{ ...live, cwd: '/somewhere/else' }], listeners: [listener(8134, 900, 'dev', { name: 'nginx' })] }
    expect(devStatus(API, taken)).toMatchObject({ kind: 'taken', text: '✗ taken by nginx', tone: 'error' })
  })
})

describe('reading the helper', () => {
  const snapshotJson = {
    ok: true,
    uid: 501,
    home: HOME,
    logDir: `${HOME}/.claude/session-monitor/logs`,
    sessions: [
      {
        pid: 10,
        name: 'Claude Code',
        state: 'running',
        cpuPct: 5,
        memBytes: 4e8,
        startedAt: NOW,
        ports: [],
        depth: 0,
        cwd: '/repo',
        isThis: true,
        children: [{ pid: 20, name: 'gk mcp', state: 'suspended', cpuPct: 1, memBytes: 5e7, ports: [7000], depth: 1 }, { name: 'no pid' }],
      },
      'junk',
    ],
    listeners: [{ port: 7000, pid: 20, owner: 'claude', sessionPid: 10, name: 'gk mcp' }, { port: 'x' }, { port: 22, pid: 4, owner: 'mystery' }],
    devServers: [{ port: 8133, pids: [302, 'x'], pgid: 300, name: 'bun run dev', isGroupSafe: true }],
    logs: [{ port: 8133, lines: ['ready', 3] }],
    groups: [{ pgid: 300, alive: 2 }],
  }

  test('a snapshot, dropping what does not parse', () => {
    const parsed = parseSnapshot(`some warning\n${JSON.stringify(snapshotJson)}\n`)
    if ('error' in parsed) {
      throw new Error(parsed.error)
    }
    expect(parsed.uid).toBe(501)
    expect(parsed.sessions).toHaveLength(1)
    expect(parsed.sessions[0]?.isThis).toBe(true)
    expect(parsed.sessions[0]?.children.map(one => [one.pid, one.state, one.ports])).toEqual([[20, 'suspended', [7000]]])
    expect(parsed.sessions[0]?.children[0]?.isMonitor).toBe(false)
    expect(parsed.listeners.map(one => [one.port, one.owner, one.sessionPid])).toEqual([
      [7000, 'claude', 10],
      [22, 'other', undefined],
    ])
    expect(parsed.devServers[0]?.pids).toEqual([302])
    expect(parsed.logs).toEqual([{ port: 8133, lines: ['ready'] }])
    expect(parsed.groups).toEqual([{ pgid: 300, alive: 2 }])
  })

  test('a failure says why', () => {
    expect(parseSnapshot('not json')).toEqual({ error: 'The process helper printed nothing readable.' })
    expect(parseSnapshot('{"ok":false,"message":"RuntimeError: ps printed nothing"}')).toEqual({ error: 'RuntimeError: ps printed nothing' })
  })

  test('action results', () => {
    expect(parseResult('{"ok":true,"message":"Suspended x (40)."}')).toEqual({ ok: true, message: 'Suspended x (40).' })
    expect(parseResult('')).toEqual({ ok: false, message: 'The process helper printed nothing readable.' })
    expect(parseLaunch('{"ok":true,"pid":890,"pgid":890,"message":"Started"}')).toEqual({ ok: true, message: 'Started', pid: 890, pgid: 890 })
    expect(parseLaunch('{"ok":true,"message":"Started"}').ok).toBe(false)
    expect(parseStop('{"ok":true,"isFree":true,"forced":true,"message":"Stopped"}')).toEqual({ ok: true, message: 'Stopped', isFree: true, forced: true })
  })

  test('a snapshot replaces the listing and keeps the settings and pending actions', () => {
    const before: PortsView = { ...EMPTY_PORTS, phases: [{ port: 8133, phase: 'starting', since: NOW }], error: 'old' }
    const snapshot: PortsSnapshot = { uid: 501, home: HOME, logDir: '/logs', sessions: [], listeners: [], devServers: [], logs: [], groups: [] }
    const after = applySnapshot(before, snapshot, NOW + 5)
    expect(after.updatedAt).toBe(NOW + 5)
    expect(after.error).toBeUndefined()
    expect(after.phases).toEqual(before.phases)
    expect(after.configs).toEqual(before.configs)
  })
})

describe('listings', () => {
  test('Claude and dev listeners first, by port; other apps after', () => {
    const split = splitListeners([listener(9000, 3, 'other'), listener(8134, 2, 'dev'), listener(7000, 1, 'claude'), listener(80, 4, 'other')])
    expect(split.mine.map(one => one.port)).toEqual([7000, 8134])
    expect(split.others.map(one => one.port)).toEqual([80, 9000])
  })

  test('a session totals its tree', () => {
    const session = { ...node(10, { cpuPct: 2, memBytes: 100 }), cwd: '/repo', isThis: true, children: [node(20, { cpuPct: 1.5, memBytes: 50 })] }
    expect(sessionTotals(session)).toEqual({ cpuPct: 3.5, memBytes: 150 })
  })

  test('paths, log tails, open rows', () => {
    expect(tildePath(`${HOME}/Trading`, HOME)).toBe('~/Trading')
    expect(tildePath('/opt/x', HOME)).toBe('/opt/x')
    expect(tildePath(`${HOME}x/y`, HOME)).toBe(`${HOME}x/y`)
    expect(logTail(['=== starting ===', 'a', '', 'b', 'c'], 2)).toBe('b ⏎ c')
    expect(toggled(['a'], 'b')).toEqual(['a', 'b'])
    expect(linkHref('http://127.0.0.1:8134/docs')).toBe('http://localhost:8134/docs')
    expect(linkHref('http://[::1]:8000')).toBe('http://localhost:8000')
    expect(linkHref('http://127.0.0.10:80/')).toBe('http://127.0.0.10:80/')
    expect(linkHref('https://example.com')).toBe('https://example.com')
    expect(toggled(['a', 'b'], 'a')).toEqual(['b'])
  })

  test('the UI fields read safely from a state an older load wrote', () => {
    const stale = { ...DEFAULT_UI } as Partial<UiState>
    delete stale.portsOpen
    delete stale.killArmed
    delete stale.portsOtherOpen
    expect(portsUi({ ...DEFAULT_UI, ...stale })).toEqual({ open: [], armed: null, isOtherOpen: false })
    expect(portsUi({ ...DEFAULT_UI, portsOpen: ['pt:dev:8133'], killArmed: { key: 'kill:4', at: 1 }, portsOtherOpen: true })).toEqual({
      open: ['pt:dev:8133'],
      armed: { key: 'kill:4', at: 1 },
      isOtherOpen: true,
    })
  })
})

describe('which processes a press may signal', () => {
  test('never this session, pid 1, the monitor, other users or an exited process', () => {
    expect(verdict(target(), 501)).toEqual({ canSignal: true, reason: '' })
    expect(verdict(target({ pid: 1 }), 501).canSignal).toBe(false)
    expect(verdict(target({ isThis: true }), 501).reason).toBe('this is the Claude process running this pane')
    expect(verdict(target({ isMonitor: true }), 501).reason).toContain('Session Monitor')
    expect(verdict(target({ uid: 0 }), 501).reason).toBe('owned by another user (uid 0)')
    expect(verdict(target(), -1).canSignal).toBe(false)
    expect(verdict(target({ state: 'zombie' }), 501).canSignal).toBe(false)
  })

  test('suspend or resume, kill and force kill', () => {
    expect(actionsFor(target())).toEqual(['suspend', 'kill', 'force'])
    expect(actionsFor(target({ state: 'suspended' }))).toEqual(['resume', 'kill', 'force'])
    expect(targetOf(node(20, { isMonitor: true }), false)).toMatchObject({ pid: 20, isMonitor: true, isThis: false })
  })

  test('kill takes two presses within six seconds; a late second press arms it again', () => {
    const first = confirmStep(null, 'kill:40', NOW)
    expect(first).toEqual({ isConfirmed: false, armed: { key: 'kill:40', at: NOW } })
    expect(actionLabel('kill', target(), first.armed, NOW + 1_000)).toBe('Click again to kill python3 serve.py')
    expect(actionLabel('force', target(), first.armed, NOW + 1_000)).toBe('Force kill')
    expect(confirmStep(first.armed, 'kill:40', NOW + 5_999)).toEqual({ isConfirmed: true, armed: null })
    expect(confirmStep(first.armed, 'kill:40', NOW + 6_000)).toEqual({ isConfirmed: false, armed: { key: 'kill:40', at: NOW + 6_000 } })
    expect(confirmStep(first.armed, 'force:40', NOW + 1_000).isConfirmed).toBe(false)
    expect(confirmStep(first.armed, 'kill:41', NOW + 1_000).isConfirmed).toBe(false)
    expect(actionLabel('kill', target(), first.armed, NOW + 7_000)).toBe('Kill')
    const forced = confirmStep(null, 'force:40', NOW).armed
    expect(actionLabel('force', target(), forced, NOW)).toBe('Click again to force kill python3 serve.py')
  })

  test('the helper argv', () => {
    expect(snapshotArgs(DEFAULT_DEV_SERVERS, [], [])).toEqual(['snapshot', '--dev', '8133,8134'])
    expect(snapshotArgs(DEFAULT_DEV_SERVERS, [8134], [890])).toEqual(['snapshot', '--dev', '8133,8134', '--tail', '8134', '--watch', '890'])
    expect(signalArgs('suspend', target({ startedAt: 1.6 }))).toEqual(['signal', 'STOP', '40', '2'])
    expect(signalArgs('resume', target())[1]).toBe('CONT')
    expect(signalArgs('kill', target())[1]).toBe('TERM')
    expect(signalArgs('force', target())[1]).toBe('KILL')
    expect(launchArgs(API)).toEqual(['launch', '8134', QTA, 'task dev:api'])
    expect(stopArgs(8134)).toEqual(['stop', '8134', '5'])
  })
})

// ------------------------------------------------------------------------- //
// The tab, end to end, over a fake machine
// ------------------------------------------------------------------------- //

/** The machine procs.py would report: a fake that records every action. */
type Machine = {
  calls: string[][]
  apiUpAt: number | null
  /** The web app started with its old dev script: its worker's debugger listens on :8134. */
  webWithDebugger: boolean
  webUpAt: number | null
  suspended: Set<number>
  killed: Set<number>
}

const STARTED = NOW - 3_600_000

const snapshotOf = (machine: Machine, args: readonly string[], now: number): string => {
  const isApiUp = machine.apiUpAt !== null && now >= machine.apiUpAt
  const tailAt = args.indexOf('--tail')
  const tails = tailAt >= 0 ? (args[tailAt + 1] ?? '').split(',') : []
  const watchAt = args.indexOf('--watch')
  const watch = watchAt >= 0 ? (args[watchAt + 1] ?? '').split(',').map(Number) : []
  const proc = (pid: number, name: string, fields: Record<string, unknown> = {}): Record<string, unknown> => ({
    pid,
    ppid: 10,
    pgid: 10,
    uid: 501,
    name,
    state: machine.suspended.has(pid) ? 'suspended' : 'running',
    cpuPct: 0.5,
    memBytes: 40e6,
    startedAt: STARTED + pid,
    ports: [],
    depth: 1,
    isMonitor: false,
    ...fields,
  })
  const children = [
    proc(20, 'npm exec @gitkraken/gk mcp'),
    proc(30, 'Python sampler.py', { isMonitor: true }),
    proc(40, 'python3 serve.py 9000', { ports: [9000] }),
  ].filter(one => !machine.killed.has(Number(one.pid)))
  return JSON.stringify({
    ok: true,
    t: now,
    uid: 501,
    home: HOME,
    logDir: `${HOME}/.claude/session-monitor/logs`,
    sessions: [
      { ...proc(10, 'Claude Code', { ppid: 9, depth: 0, cpuPct: 12, memBytes: 800e6 }), cwd: `${HOME}/repo`, isThis: true, children },
      {
        ...proc(500, 'Claude Code', { ppid: 499, pgid: 499, depth: 0 }),
        cwd: `${HOME}/other`,
        isThis: false,
        children: [proc(501, 'node server.js 7000', { ppid: 500, pgid: 499, ports: [7000] })],
      },
    ],
    listeners: [
      ...(machine.killed.has(40) ? [] : [{ port: 9000, address: '127.0.0.1', pid: 40, name: 'python3 serve.py 9000', uid: 501, owner: 'claude', startedAt: STARTED + 40, state: 'running', isMonitor: false, sessionPid: 10 }]),
      { port: 7000, address: '127.0.0.1', pid: 501, name: 'node server.js 7000', uid: 501, owner: 'claude', startedAt: STARTED + 501, state: 'running', isMonitor: false, sessionPid: 500 },
      ...(isApiUp ? [{ port: 8134, address: '127.0.0.1', pid: 900, name: 'Python uvicorn', uid: 501, owner: 'dev', startedAt: NOW, state: 'running', isMonitor: false }] : []),
      ...(machine.webUpAt !== null && now >= machine.webUpAt
        ? [{ port: 8133, address: '*', pid: 700, name: 'node next dev', uid: 501, owner: 'dev', startedAt: NOW, state: 'running', isMonitor: false }]
        : []),
      ...(machine.webWithDebugger
        ? [{ port: 8134, address: '127.0.0.1', pid: 701, name: 'node next-server', uid: 501, owner: 'dev', startedAt: NOW, state: 'running', isMonitor: false }]
        : []),
      { port: 5000, address: '*', pid: 732, name: 'ControlCenter', uid: 501, owner: 'other', startedAt: STARTED, state: 'running', isMonitor: false },
    ],
    devServers: [
      ...(isApiUp
        ? [{ port: 8134, pids: [900], pgid: 890, name: 'Python uvicorn', startedAt: machine.apiUpAt, cpuPct: 1.5, memBytes: 120e6, procs: 4, cwd: QTA, isGroupSafe: true }]
        : []),
      ...(machine.webUpAt !== null && now >= machine.webUpAt
        ? [{ port: 8133, pids: [700], pgid: 700, name: 'node next dev', startedAt: machine.webUpAt, cpuPct: 3, memBytes: 3e8, procs: 5, cwd: QTA, isGroupSafe: true }]
        : []),
      ...(machine.webWithDebugger
        ? [{ port: 8134, pids: [701], pgid: 700, name: 'node next-server', startedAt: NOW, cpuPct: 1, memBytes: 2e8, procs: 5, cwd: `${QTA}/apps/web`, isGroupSafe: true }]
        : []),
    ],
    logs: tails.map(port => ({ port: Number(port), lines: ['=== starting ===', `INFO: Uvicorn running on http://127.0.0.1:${port}`] })),
    groups: watch.map(pgid => ({ pgid, alive: 3 })),
  })
}

const answer = (machine: Machine, args: readonly string[], now: number): string => {
  machine.calls.push([...args])
  const mode = args[0]
  if (mode === 'snapshot') {
    return snapshotOf(machine, args, now)
  }
  if (mode === 'launch' && args[1] === '8133') {
    machine.webUpAt = now + 1_500
    machine.webWithDebugger = args[3]?.includes('task dev') === true
    return JSON.stringify({ ok: true, pid: 700, pgid: 700, log: `${HOME}/.claude/session-monitor/logs/8133.log`, message: 'Started' })
  }
  if (mode === 'stop' && args[1] === '8133') {
    machine.webUpAt = null
    machine.webWithDebugger = false
    return JSON.stringify({ ok: true, isFree: true, forced: false, groups: [700], pids: [], message: 'Stopped node next dev with SIGTERM to process group 700; :8133 is free.' })
  }
  if (mode === 'launch') {
    machine.apiUpAt = now + 1_500
    return JSON.stringify({ ok: true, pid: 890, pgid: 890, log: `${HOME}/.claude/session-monitor/logs/8134.log`, message: 'Started' })
  }
  if (mode === 'stop') {
    machine.apiUpAt = null
    return JSON.stringify({ ok: true, isFree: true, forced: false, groups: [890], pids: [], message: 'Stopped Python uvicorn with SIGTERM to process group 890; :8134 is free.' })
  }
  if (mode === 'signal') {
    const pid = Number(args[2])
    const sig = args[1]
    if (sig === 'STOP') {
      machine.suspended.add(pid)
    } else if (sig === 'CONT') {
      machine.suspended.delete(pid)
    } else {
      machine.killed.add(pid)
    }
    return JSON.stringify({ ok: true, pid, signal: sig, message: `Sent ${sig} to ${pid}.` })
  }
  return JSON.stringify({ ok: false, message: 'usage' })
}

/** procs.py's argv: python, -I, the script, then its own arguments. */
const procsArgs = (argv: readonly string[]): string[] | undefined =>
  argv[1] === '-I' && argv[2]?.endsWith('/sampler/procs.py') === true ? argv.slice(3) : undefined

/**
 * A session over the fake machine: the kit takes one `process.run` hook per
 * test, so this is a small world of its own (no git repository, no battery;
 * the RAM, for memory's share of it).
 */
const machineWorld = (on: On, toasts: string[]): { machine: Machine; clock: ReturnType<typeof mock.clock> } => {
  const clock = mock.clock(on, { now: NOW })
  const machine: Machine = { calls: [], apiUpAt: null, webWithDebugger: false, webUpAt: null, suspended: new Set(), killed: new Set() }
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', ($, e) => {
    if (e.argv[0] === 'sysctl') {
      return { value: ok(`${RAM}\n`) }
    }
    const args = procsArgs(e.argv)
    return { value: args === undefined ? fail() : ok(answer(machine, args, clock.now())) }
  })
  on('process.spawn', async function* () {
    await clock.sleep(1e9)
    return { value: { code: 0, signal: null } }
  })
  on('fs.exists', ($, e) => ({ value: e.path === '/Library/Developer/CommandLineTools/usr/bin/python3' }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 10, mtimeMs: NOW, isLink: false } }))
  on('session.usage', () => ({ value: { startedAt: NOW - 60_000, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 1 }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { machine, clock }
}

const signals = (machine: Machine): string[] => machine.calls.filter(call => call[0] === 'signal').map(call => `${call[1]} ${call[2]}`)

for (const surface of ['terminal', 'desktop'] as const) {
  test(`ports on ${surface}: dev servers on and off, sessions' processes, two-step kill`, { timeoutMs: 30_000 }, async ($, on) => {
    const toasts: string[] = []
    const { machine, clock } = machineWorld(on, toasts)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
    // Nothing reads processes while another tab is open.
    await clock.advance(5_000)
    expect(machine.calls).toEqual([])

    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:ports' })
    await clock.advance(1_000)
    expect(machine.calls[0]?.slice(0, 3)).toEqual(['snapshot', '--dev', '8133,8134'])

    // Dev servers: both stopped, each with its toggle and link.
    expect(await ui.find({ in: 'pt:dev:8134', type: 'Text', text: '○ stopped' })).toBeDefined()
    expect(await ui.find({ in: 'pt:dev:8134', type: 'Text', text: 'Trade analysis API' })).toBeDefined()
    expect((await ui.find({ key: 'pt:toggle:8134' }))?.props.label).toBe('Turn on')
    // The desktop links plain http only to localhost: 127.0.0.1 is spelled so, the label kept.
    const links = await ui.findAll({ type: 'Link' })
    expect(links.map(link => link.props.href)).toEqual(['http://localhost:8133', 'http://localhost:8134/docs'])
    expect(links.map(link => link.props.label)).toEqual(['http://localhost:8133', 'http://127.0.0.1:8134/docs'])

    // Turn on: launched detached, then polled every second until it listens.
    await ui.press({ key: 'pt:toggle:8134' })
    expect(machine.calls.find(call => call[0] === 'launch')).toEqual(['launch', '8134', QTA, 'task dev:api'])
    expect(await ui.find({ in: 'pt:dev:8134', type: 'Text', text: '◌ starting…' })).toBeDefined()
    expect(await ui.find({ key: 'pt:toggle:8134' })).toBeUndefined()
    await clock.advance(1_000)
    expect(toasts.some(text => text.includes('is up'))).toBe(false)
    expect(machine.calls.at(-1)).toEqual(['snapshot', '--dev', '8133,8134', '--tail', '8134', '--watch', '890'])
    await clock.advance(1_000)
    expect(toasts).toContain('Trade analysis API is up on :8134')
    expect(await ui.find({ in: 'pt:dev:8134', type: 'Text', text: '● listening' })).toBeDefined()
    expect(await ui.find({ in: 'pt:dev:8134', type: 'Text', text: 'Python uvicorn · pid 900' })).toBeDefined()
    expect((await ui.find({ key: 'pt:toggle:8134' }))?.props.label).toBe('Turn off')
    expect(await ui.find({ in: 'pt:lis:900:8134', type: 'Text', text: 'dev server' })).toBeDefined()

    // Its row opens on the log's last lines.
    await clickRow(ui, 'pt:dev:8134')
    expect(await ui.find({ type: 'Code', text: /Uvicorn running on http:\/\/127\.0\.0\.1:8134/ })).toBeDefined()

    // Turn off: SIGTERM to the group (procs.py stop), then stopped.
    await clock.advance(1_000)
    await ui.press({ key: 'pt:toggle:8134' })
    expect(machine.calls.find(call => call[0] === 'stop')).toEqual(['stop', '8134', '5'])
    expect(toasts.some(text => text.startsWith('Turned off Trade analysis API.') && text.includes('process group 890'))).toBe(true)
    expect(await ui.find({ in: 'pt:dev:8134', type: 'Text', text: '○ stopped' })).toBeDefined()

    // Sessions: this one and another, with their trees and ports.
    expect(await ui.find({ in: 'pt:proc:10', type: 'Text', text: '● this session' })).toBeDefined()
    expect(await ui.find({ in: 'pt:proc:10', type: 'Text', text: '~/repo' })).toBeDefined()
    expect(await ui.find({ in: 'pt:proc:500', type: 'Text', text: '○ session' })).toBeDefined()
    expect(await ui.find({ in: 'pt:proc:40', type: 'Text', text: ':9000' })).toBeDefined()
    expect(await ui.find({ in: 'pt:proc:30', type: 'Text', text: 'monitor' })).toBeDefined()

    // A child process: Suspend sends SIGSTOP at once, then it offers Resume.
    await clickRow(ui, 'pt:proc:40')
    expect((await ui.find({ key: 'pt:proc:40:suspend' }))?.props.label).toBe('Suspend')
    await ui.press({ key: 'pt:proc:40:suspend' })
    expect(signals(machine)).toEqual([`STOP 40`])
    expect(machine.calls.find(call => call[0] === 'signal')).toEqual(['signal', 'STOP', '40', String(STARTED + 40)])
    expect(await ui.find({ in: 'pt:proc:40', type: 'Text', text: '❚❚ suspended' })).toBeDefined()
    expect((await ui.find({ key: 'pt:proc:40:resume' }))?.props.label).toBe('Resume')

    // Kill: the first press arms it, a second within 6 s sends SIGTERM.
    await clock.advance(1_000)
    await ui.press({ key: 'pt:proc:40:kill' })
    expect(signals(machine)).toEqual([`STOP 40`])
    expect((await ui.find({ key: 'pt:proc:40:kill' }))?.props.label).toBe('Click again to kill python3 serve.py 9000')
    await clock.advance(1_000)
    await ui.press({ key: 'pt:proc:40:kill' })
    expect(signals(machine)).toEqual([`STOP 40`, 'TERM 40'])
    expect((await ui.findAll({ type: 'Client' })).some(client => client.key === 'pt:proc:40')).toBe(false)

    // A second press after 6 s arms it again instead of killing.
    await clickRow(ui, 'pt:proc:20')
    await ui.press({ key: 'pt:proc:20:kill' })
    await clock.advance(7_000)
    expect((await ui.find({ key: 'pt:proc:20:kill' }))?.props.label).toBe('Kill')
    await ui.press({ key: 'pt:proc:20:kill' })
    expect(signals(machine)).toEqual([`STOP 40`, 'TERM 40'])
    expect((await ui.find({ key: 'pt:proc:20:kill' }))?.props.label).toBe('Click again to kill npm exec @gitkraken/gk mcp')
    await clock.advance(1_000)
    await ui.press({ key: 'pt:proc:20:kill' })
    expect(signals(machine)).toEqual([`STOP 40`, 'TERM 40', 'TERM 20'])

    // This session's own Claude process and the monitor's sampler offer no Kill.
    await clickRow(ui, 'pt:proc:10')
    expect(await ui.find({ key: 'pt:proc:10:kill' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'No actions: this is the Claude process running this pane.' })).toBeDefined()
    await clickRow(ui, 'pt:proc:30')
    expect(await ui.find({ key: 'pt:proc:30:kill' })).toBeUndefined()
    // Another session may be killed, with the same confirmation.
    await clickRow(ui, 'pt:proc:500')
    expect((await ui.find({ key: 'pt:proc:500:kill' }))?.props.label).toBe('Kill')

    // Other apps: listed, collapsed until clicked, never with actions.
    expect(await ui.find({ in: 'pt:other', type: 'Text', text: 'Other apps (1)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'ControlCenter' })).toBeUndefined()
    await clickRow(ui, 'pt:other')
    expect(await ui.find({ type: 'Text', text: 'ControlCenter' })).toBeDefined()
    expect((await ui.findAll({ type: 'Button' })).some(button => button.key?.includes('732') === true)).toBe(false)

    // Leaving the tab stops the polling.
    await ui.press({ key: 'tab:overview' })
    const count = machine.calls.length
    await clock.advance(10_000)
    expect(machine.calls.length).toBe(count)
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`ports on ${surface}: each list a card, an opened row's actions or log a card under it, memory with its share of the RAM`, { timeoutMs: 30_000 }, async ($, on) => {
    const toasts: string[] = []
    const { clock } = machineWorld(on, toasts)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:ports' })
    await clock.advance(1_000)
    // The counts, then dev servers, Claude sessions and listening ports: a card each, softly filled on the desktop alone.
    const cards = [PORTS_SUMMARY_KEY, DEV_CARD_KEY, SESSIONS_CARD_KEY, LISTENERS_CARD_KEY]
    expect(await keysOf(ui, 'card:ports:')).toEqual(cards)
    for (const key of cards) {
      const props = (await ui.find({ key }))?.props
      expect(props?.borderStyle).toBe('round')
      expect(props?.backgroundColor).toBe(surface === 'desktop' ? CARD_BACKGROUND : undefined)
    }
    // Two sessions with six processes between them, and three ports listened on, one by another app.
    const counts = (await textsIn(ui, PORTS_SUMMARY_KEY)).join('\n')
    expect(counts).toContain('Dev servers\n0 of 2\nrunning')
    expect(counts).toContain('Claude sessions\n2\non this Mac')
    expect(counts).toContain('Processes\n6\nnone suspended')
    expect(counts).toContain('Listening ports\n3\n1 in other apps')
    // A process's memory with its share of the world's 16 GB: this session's tree sums 920 MB.
    expect(await ui.find({ in: 'pt:proc:10', type: 'Text', text: '920 MB (5.4%)' })).toBeDefined()
    expect(await ui.find({ in: 'pt:proc:40', type: 'Text', text: '40.0 MB (0.2%)' })).toBeDefined()
    // An opened process's actions are a card under its row.
    await clickRow(ui, 'pt:proc:40')
    const actions = portsCardKey('pt:proc:40')
    expect((await ui.find({ key: actions }))?.props.borderStyle).toBe('round')
    expect(await textsIn(ui, actions)).toEqual(expect.arrayContaining(['[Suspend]', '[Kill]']))
    await clock.advance(1_000)
    await clickRow(ui, 'pt:proc:40')
    expect(await keysOf(ui, actions)).toEqual([])
    // A dev server opened to its log's last lines: a card too.
    await clickRow(ui, 'pt:dev:8134')
    expect((await textsIn(ui, portsCardKey('pt:dev:8134'))).join('\n')).toContain('8134.log · last 2 lines')
    expect(await ui.find({ type: 'Code', text: /Uvicorn running/ })).toBeDefined()
    // A running dev server's memory, with its share; the counts follow it.
    await ui.press({ key: 'pt:toggle:8134' })
    await clock.advance(2_000)
    expect(await ui.find({ in: 'pt:dev:8134', type: 'Text', text: '120 MB (0.7%)' })).toBeDefined()
    expect((await textsIn(ui, PORTS_SUMMARY_KEY)).join('\n')).toContain('Dev servers\n1 of 2\nrunning')
  })
}

test('ports: turning on a server whose port is taken is refused, naming the owner', { timeoutMs: 20_000 }, async ($, on) => {
  const toasts: string[] = []
  const { machine, clock } = machineWorld(on, toasts)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:ports' })
  await clock.advance(1_000)
  // Something else takes :8134 between the listing and the press.
  machine.apiUpAt = clock.now()
  await ui.press({ key: 'pt:toggle:8134' })
  expect(machine.calls.some(call => call[0] === 'launch')).toBe(false)
  expect(toasts).toContain(':8134 is already in use by Python uvicorn (pid 900); Trade analysis API was not started.')
})

test('ports: /monitor ports opens the tab; surfaces without row regions still get the buttons', { timeoutMs: 20_000 }, async ($, on) => {
  const toasts: string[] = []
  const { machine, clock } = machineWorld(on, toasts)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(await run($, 'monitor', 'ports')).toBe('Session Monitor is open.')
  await clock.advance(1_000)
  expect(machine.calls[0]?.[0]).toBe('snapshot')
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect((await tabButton(ui, 'ports'))?.props.variant).toBe('primary')
  expect((await ui.findAll({ type: 'Client' })).length).toBe(0)
  expect((await ui.find({ key: 'pt:toggle:8133' }))?.props.label).toBe('Turn on')
  expect((await ui.find({ key: 'pt:toggle:8134' }))?.props.label).toBe('Turn on')
})

test("ports: the web app's debugger on :8134 is named, and one press restarts the web app without it", { timeoutMs: 30_000 }, async ($, on) => {
  const toasts: string[] = []
  const { machine, clock } = machineWorld(on, toasts)
  // Started with the old `task dev`: the web app listens on :8133, its worker's debugger on :8134.
  machine.webUpAt = NOW
  machine.webWithDebugger = true
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:ports' })
  await clock.advance(1_000)
  await clock.settle()
  // Only the web app counts as on; the API's row says who holds its port, with no Turn on.
  expect((await ui.find({ key: 'pt:toggle:8133' }))?.props.label).toBe('Turn off')
  expect(await ui.find({ key: 'pt:toggle:8134' })).toBeUndefined()
  expect(await ui.find({ in: 'pt:dev:8134', type: 'Text', text: '✗ held by Trade analysis web app (:8133)' })).toBeDefined()
  expect(await ui.find({ in: 'pt:dev:8133', type: 'Text', text: '● listening' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^:8134 is held by Trade analysis web app \(:8133\), most likely its Node debugger/ })).toBeDefined()
  expect((await ui.find({ key: 'pt:free:8134' }))?.props.label).toBe('Restart Trade analysis web app without the debugger')

  await ui.press({ key: 'pt:free:8134' })
  await clock.advance(3_000)
  await clock.settle()
  const steps = machine.calls.filter(call => call[0] === 'stop' || call[0] === 'launch')
  expect(steps).toEqual([
    ['stop', '8133', '5'],
    ['launch', '8133', QTA, WEB_DEV_COMMAND],
  ])
  // :8134 is free: the API turns on by itself, and only it starts.
  expect((await ui.find({ key: 'pt:toggle:8134' }))?.props.label).toBe('Turn on')
  await ui.press({ key: 'pt:toggle:8134' })
  await clock.advance(3_000)
  await clock.settle()
  expect(machine.calls.filter(call => call[0] === 'launch').map(call => call[1])).toEqual(['8133', '8134'])
  expect((await ui.find({ key: 'pt:toggle:8133' }))?.props.label).toBe('Turn off')
  expect((await ui.find({ key: 'pt:toggle:8134' }))?.props.label).toBe('Turn off')
})
