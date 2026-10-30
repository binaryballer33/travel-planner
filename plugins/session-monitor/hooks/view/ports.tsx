// Ports: the dev servers this tab turns on and off, every Claude Code session
// on this Mac with its process tree, and every TCP listener, each a card under
// a card of their counts. A click on a process row opens its actions in a card
// under it: suspend or resume, kill and force kill (each asking for a second
// click). Memory reads with its share of the Mac's RAM.

import type { RenderElement } from 'claude-code'

import type { ClaudeSession, DevServerConfig, PortListener, PortsView, ProcNode } from '../../types'
import { fmtClock, fmtDuration, fmtMemory, fmtPct, oneLine, toneCpu, toneMem } from '../lib/format'
import {
  actionLabel,
  actionsFor,
  armKey,
  devKey,
  devStatus,
  isArmed,
  linkHref,
  listenerKey,
  listenerTarget,
  OTHER_KEY,
  portsUi,
  procKey,
  sessionTotals,
  splitListeners,
  targetOf,
  tildePath,
  verdict,
  type ProcTarget,
} from '../lib/ports'
import { card, cardStack, figureRow, notedFigure, rowDetailCard, rowLine, sectionCard, seg, titleSeg, type Actions, type PaneData, type Ui } from './kit'
import type { RowPress, RowSegment } from './row'

/** Rows drawn for processes, all sessions together: the pane draws ~100k characters at most. */
const MAX_PROC_ROWS = 160
const MAX_OTHER_ROWS = 80

/** The Ports tab's cards: the counts, the dev servers, the Claude sessions and the listening ports. */
export const PORTS_SUMMARY_KEY = 'card:ports:summary'
export const DEV_CARD_KEY = 'card:ports:dev'
export const SESSIONS_CARD_KEY = 'card:ports:sessions'
export const LISTENERS_CARD_KEY = 'card:ports:listeners'

/** An opened row's card (a process's actions, a dev server's log). */
export const portsCardKey = (rowKey: string): string => `card:${rowKey}`

const press = (key: string): RowPress => ({ kind: 'ports', id: key, path: '' })

const portsText = (ports: readonly number[]): string => ports.map(port => `:${port}`).join(' ')

/** A process's CPU and memory, the memory with its share of the Mac's RAM (`1.21 GB (7.6%)`). */
const figureSegs = (cpuPct: number, memBytes: number, memTotal: number): RowSegment[] => [
  seg(`CPU ${fmtPct(cpuPct)}`, { color: toneCpu(cpuPct), width: 9 }),
  seg(fmtMemory(memBytes, memTotal), { color: toneMem(memBytes), width: 15 }),
]

const stateSeg = (state: ProcNode['state']): RowSegment[] =>
  state === 'suspended' ? [seg('❚❚ suspended', { color: 'warning', bold: true })] : state === 'zombie' ? [seg('exited', { dim: true })] : []

/** A process row's opened part: what it is, and its buttons or why it has none. */
const procPanel = (rowKey: string, target: ProcTarget, view: PortsView, data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Text, Button } = ui
  const judged = verdict(target, view.uid)
  const armed = portsUi(data.ui).armed
  return rowDetailCard(ui, data, portsCardKey(rowKey), [
    <Text dimColor>
      pid {target.pid} · started {fmtClock(target.startedAt, data.now)} ({fmtDuration(data.now - target.startedAt)} ago) · uid {target.uid} ·{' '}
      {target.state}
    </Text>,
    judged.canSignal ? (
      <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap - 1} rowGap={data.space.row}>
        {actionsFor(target).map(action => (
          <Button
            key={`${rowKey}:${action}`}
            label={actionLabel(action, target, armed, data.now)}
            variant={isArmed(armed, armKey(action, target.pid), data.now) ? 'primary' : 'secondary'}
            onPress={() => act.procAction(target, action)}
          />
        ))}
      </Box>
    ) : (
      <Text color="warning">No actions: {judged.reason}.</Text>
    ),
  ])
}

const devRow = (config: DevServerConfig, view: PortsView, data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Text, Button, Link, Code } = ui
  const key = devKey(config.port)
  const isOpen = portsUi(data.ui).open.includes(key)
  const status = devStatus(config, view)
  const live = status.live
  const phase = view.phases.find(one => one.port === config.port)
  const segments: RowSegment[] = [
    seg(status.text, { color: status.tone, bold: true, width: 14 }),
    seg(`:${config.port}`, { bold: true, width: 6 }),
    titleSeg(config.name, isOpen),
    ...(live !== undefined
      ? [
          seg(`${live.name} · pid ${live.pids.join(', ')}`, { dim: true }),
          seg(`up ${fmtDuration(data.now - live.startedAt)}`, { width: 11 }),
          ...figureSegs(live.cpuPct, live.memBytes, data.memTotal),
        ]
      : []),
  ]
  const lines = view.logs.find(one => one.port === config.port)?.lines ?? []
  const logPath = `${tildePath(view.logDir, view.home)}/${config.port}.log`
  return (
    <Box flexDirection="column">
      {rowLine(ui, data, key, press(key), segments, () => act.togglePortsRow(key), isOpen)}
      <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap} rowGap={data.space.row} marginLeft={2}>
        {(status.kind === 'listening' || status.kind === 'stopped') && (
          <Button
            key={`pt:toggle:${config.port}`}
            label={status.kind === 'listening' ? 'Turn off' : 'Turn on'}
            variant={status.kind === 'listening' ? 'secondary' : 'primary'}
            onPress={() => act.setDevServer(config.port, status.kind !== 'listening')}
          />
        )}
        {phase !== undefined && (
          <Text color="warning">
            {phase.phase === 'starting' ? 'starting' : 'stopping'} for {fmtDuration(data.now - phase.since)}
          </Text>
        )}
        {status.kind === 'taken' && status.heldBy !== undefined && (
          <Text color="error">
            :{config.port} is held by {status.heldBy.name} (:{status.heldBy.port}), most likely its Node debugger: the web app's dev script
            asks for one, and Next.js puts it on the next port.
          </Text>
        )}
        {status.kind === 'taken' && status.heldBy !== undefined && (
          <Button
            key={`pt:free:${config.port}`}
            label={`Restart ${status.heldBy.name} without the debugger`}
            onPress={() => act.restartDevServer(status.heldBy?.port ?? 0)}
          />
        )}
        {status.kind === 'taken' && status.heldBy === undefined && (
          <Text color="error">
            :{config.port} is held by {status.holder?.name ?? live?.name ?? 'another program'} (pid {status.holder?.pid ?? live?.pids[0] ?? '?'}
            {live?.cwd !== undefined && live.cwd !== '' ? ` in ${tildePath(live.cwd, view.home)}` : ''}); stop it under Listening ports
          </Text>
        )}
        {config.url !== '' && <Link href={linkHref(config.url)} label={config.url} />}
        <Text dimColor>
          {oneLine(config.command, 80)} in {tildePath(config.cwd, view.home)}
        </Text>
      </Box>
      {isOpen &&
        rowDetailCard(ui, data, portsCardKey(key), [
          <Text dimColor>
            {logPath} · last {lines.length} lines
            {live !== undefined && !live.isGroupSafe ? ' · shares a process group with Claude, so Turn off stops only its own processes' : ''}
          </Text>,
          lines.length === 0 ? <Text dimColor>No log yet: a server this tab starts writes its output here.</Text> : <Code source={lines.join('\n')} language="text" />,
        ])}
    </Box>
  )
}

const childRow = (node: ProcNode, view: PortsView, data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box } = ui
  const key = procKey(node.pid)
  const isOpen = portsUi(data.ui).open.includes(key)
  const segments: RowSegment[] = [
    seg(`${'  '.repeat(Math.max(0, node.depth - 1))}└`, { dim: true }),
    titleSeg(node.name, isOpen),
    ...(node.isMonitor ? [seg('monitor', { dim: true })] : []),
    ...(node.ports.length > 0 ? [seg(portsText(node.ports), { color: 'suggestion', bold: true })] : []),
    ...stateSeg(node.state),
    seg(`pid ${node.pid}`, { dim: true, width: 10 }),
    ...figureSegs(node.cpuPct, node.memBytes, data.memTotal),
  ]
  return (
    <Box flexDirection="column">
      {rowLine(ui, data, key, press(key), segments, () => act.togglePortsRow(key), isOpen)}
      {isOpen && procPanel(key, targetOf(node, false), view, data, ui, act)}
    </Box>
  )
}

const sessionRows = (one: ClaudeSession, budget: number, view: PortsView, data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Text } = ui
  const key = procKey(one.pid)
  const isOpen = portsUi(data.ui).open.includes(key)
  const totals = sessionTotals(one)
  const segments: RowSegment[] = [
    seg(one.isThis ? '● this session' : '○ session', { color: one.isThis ? 'claude' : 'suggestion', bold: true, width: 15 }),
    titleSeg(one.cwd !== '' ? tildePath(one.cwd, view.home) : 'Claude Code', isOpen),
    ...(one.ports.length > 0 ? [seg(portsText(one.ports), { color: 'suggestion', bold: true })] : []),
    ...stateSeg(one.state),
    seg(`started ${fmtClock(one.startedAt, data.now)}`, { dim: true }),
    seg(`pid ${one.pid}`, { dim: true, width: 10 }),
    ...figureSegs(totals.cpuPct, totals.memBytes, data.memTotal),
  ]
  const shown = one.children.slice(0, Math.max(0, budget))
  return (
    <Box flexDirection="column">
      {rowLine(ui, data, key, press(key), segments, () => act.togglePortsRow(key), isOpen)}
      {isOpen && procPanel(key, targetOf(one, one.isThis), view, data, ui, act)}
      {shown.map(child => childRow(child, view, data, ui, act))}
      {one.children.length > shown.length && (
        <Box marginLeft={2}>
          <Text dimColor>… {one.children.length - shown.length} more processes</Text>
        </Box>
      )}
    </Box>
  )
}

const listenerRow = (one: PortListener, thisPid: number | undefined, view: PortsView, data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box } = ui
  const key = listenerKey(one.pid, one.port)
  const isOpen = portsUi(data.ui).open.includes(key)
  const whose =
    one.owner === 'dev'
      ? seg('dev server', { color: 'success' })
      : one.sessionPid === thisPid
        ? seg('this session', { color: 'claude' })
        : seg(`session ${one.sessionPid ?? '?'}`, { color: 'suggestion' })
  const segments: RowSegment[] = [
    seg(`:${one.port}`, { bold: true, color: one.owner === 'dev' ? 'success' : 'claude', width: 7 }),
    seg(oneLine(one.address, 24), { dim: true, width: 18 }),
    titleSeg(one.name, isOpen),
    whose,
    ...stateSeg(one.state),
    seg(`pid ${one.pid}`, { dim: true, width: 10 }),
  ]
  return (
    <Box flexDirection="column">
      {rowLine(ui, data, key, press(key), segments, () => act.togglePortsRow(key), isOpen)}
      {isOpen && procPanel(key, listenerTarget(one, thisPid), view, data, ui, act)}
    </Box>
  )
}

const otherRows = (others: readonly PortListener[], data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Text } = ui
  const isOpen = portsUi(data.ui).isOtherOpen
  const segments: RowSegment[] = [
    titleSeg(`Other apps (${others.length})`, isOpen),
    seg(isOpen ? 'click to hide' : 'click to show · listed only, no actions', { dim: true }),
  ]
  return (
    <Box flexDirection="column">
      {rowLine(ui, data, OTHER_KEY, press(OTHER_KEY), segments, () => act.togglePortsRow(OTHER_KEY), isOpen)}
      {isOpen &&
        others.slice(0, MAX_OTHER_ROWS).map(one => (
          <Box flexDirection="row" columnGap={data.space.gap} marginLeft={2}>
            <Box width={7} flexShrink={0}>
              <Text dimColor>:{one.port}</Text>
            </Box>
            <Box width={18} flexShrink={0}>
              <Text dimColor>{oneLine(one.address, 24)}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text dimColor>
                {one.name}
              </Text>
            </Box>
            <Text dimColor>
              pid {one.pid}
              {one.uid !== data.ports?.uid && one.uid >= 0 ? ` · uid ${one.uid}` : ''}
            </Text>
          </Box>
        ))}
      {isOpen && others.length > MAX_OTHER_ROWS && <Text dimColor>… {others.length - MAX_OTHER_ROWS} more</Text>}
    </Box>
  )
}

/** The tab's counts: dev servers running, Claude sessions, the processes under them, and the ports listened on. */
const summaryCard = (view: PortsView, running: number, data: PaneData, ui: Ui): RenderElement => {
  const nodes = view.sessions.flatMap(one => [one, ...one.children])
  const suspended = nodes.filter(node => node.state === 'suspended').length
  const others = splitListeners(view.listeners).others.length
  return card(ui, data, PORTS_SUMMARY_KEY, [
    figureRow(ui, data, [
      notedFigure(ui, data, 'Dev servers', `${running} of ${view.configs.length}`, 'running', running > 0 ? 'success' : 'subtle'),
      notedFigure(ui, data, 'Claude sessions', String(view.sessions.length), 'on this Mac', 'claude'),
      notedFigure(ui, data, 'Processes', String(nodes.length), suspended > 0 ? `${suspended} suspended` : 'none suspended', suspended > 0 ? 'warning' : undefined),
      notedFigure(ui, data, 'Listening ports', String(view.listeners.length), `${others} in other apps`, 'suggestion'),
    ]),
  ])
}

export const portsTab = (data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Text, Button } = ui
  const view = data.ports
  if (view === null || view.updatedAt === 0) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={view?.error !== undefined ? 'error' : undefined} dimColor={view?.error === undefined}>
          {view?.error !== undefined ? `Could not read processes and ports: ${oneLine(view.error, 300)}` : 'Reading processes and ports…'}
        </Text>
        <Button key="pt:refresh" label="Refresh" onPress={() => act.refreshPorts()} />
      </Box>
    )
  }
  const thisPid = view.sessions.find(one => one.isThis)?.pid
  const { mine, others } = splitListeners(view.listeners)
  const running = view.configs.filter(config => devStatus(config, view).kind === 'listening').length
  let budget = MAX_PROC_ROWS
  const sessions = view.sessions.map(one => {
    const rows = sessionRows(one, budget, view, data, ui, act)
    budget -= one.children.length
    return rows
  })
  return cardStack(ui, data, [
    <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap} rowGap={data.space.row} alignItems="center">
      <Button key="pt:refresh" label="Refresh" onPress={() => act.refreshPorts()} />
      <Text dimColor>as of {fmtClock(view.updatedAt, data.now)} · read every 3 s while this tab is open</Text>
      {view.error !== undefined && <Text color="error">{oneLine(view.error, 200)}</Text>}
    </Box>,
    summaryCard(view, running, data, ui),
    sectionCard(
      ui,
      data,
      DEV_CARD_KEY,
      'Dev servers',
      `logs in ${tildePath(view.logDir, view.home)}`,
      view.configs.map(config => devRow(config, view, data, ui, act)),
    ),
    sectionCard(
      ui,
      data,
      SESSIONS_CARD_KEY,
      'Claude sessions',
      'click a process for suspend, resume and kill',
      view.sessions.length === 0 ? [<Text dimColor>No Claude Code process found.</Text>] : sessions,
    ),
    sectionCard(ui, data, LISTENERS_CARD_KEY, 'Listening ports', 'TCP · Claude sessions and dev servers first', [
      ...(mine.length === 0 ? [<Text dimColor>No Claude session or dev server is listening on a TCP port.</Text>] : []),
      ...mine.map(one => listenerRow(one, thisPid, view, data, ui, act)),
      ...(others.length > 0 ? [otherRows(others, data, ui, act)] : []),
    ]),
    <Text dimColor>
      Turn on starts the server detached, in its own process group, so it keeps running when the pane, the plugin or this session
      ends; Turn off sends SIGTERM to that group and SIGKILL after 5 s. Kill and Force kill need a second click within 6 s. Not
      offered: this session’s own Claude process, pid 1, other users’ processes and the monitor’s own helpers. Names leave out
      anything that looks like a secret. Memory is what a process holds now, with its share of the Mac’s RAM.
    </Text>,
  ])
}
