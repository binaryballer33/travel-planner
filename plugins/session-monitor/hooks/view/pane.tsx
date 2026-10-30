// The Session Monitor pane: the tab bar, the live strip where a tab shows
// live figures, and the open tab.

import type { RenderElement } from 'claude-code'

import type { LiveMetrics, MonitorTab, Pulse, UiState } from '../../types'
import { fmtBytes, fmtMemory, fmtPct, fmtRate, fmtUsd, fmtWatts, memShare, oneLine, toneCpu, toneMem, toneNetTotal, tonePercentUsed, toneRate, toneWatts } from '../lib/format'
import { commandsTab } from './commands'
import { computeTab } from './compute'
import { promptsTab } from './prompts'
import { commitsTab } from './commits'
// --- ui polish ---
import { compactButton } from './compact'
// --- ui polish ---
import { filesTab } from './files'
import { explorerTab } from './explorer' // --- explorer ---
import { DESKTOP_LIMITS, sentCostOf, type DrawCost } from '../lib/fit'
import type { Actions, PaneData, Ui } from './kit'
import { overview } from './overview'
// --- ports ---
import { portsTab } from './ports'
// --- end ports ---
import { resourcesTab } from './resources'
import { sourcesTab } from './sources'
import { TAB_BAR_KEY } from './tab-bar'
// --- agents ---
import { agentsTab } from './agents'
import { cacheTab } from './cache'
import { TAB_HOTKEYS } from '../lib/hotkeys'
// --- end agents ---

/** The tabs in the bar's order, each with its letter (lib/hotkeys.ts). */
export const TABS: readonly { id: MonitorTab; text: string; hotkey: string }[] = [
  { id: 'overview', text: 'Overview', hotkey: TAB_HOTKEYS.overview },
  { id: 'prompts', text: 'Prompts', hotkey: TAB_HOTKEYS.prompts },
  { id: 'agents', text: 'Agents', hotkey: TAB_HOTKEYS.agents }, // --- agents ---
  { id: 'commands', text: 'Commands', hotkey: TAB_HOTKEYS.commands },
  { id: 'commits', text: 'Commits', hotkey: TAB_HOTKEYS.commits },
  { id: 'files', text: 'Files', hotkey: TAB_HOTKEYS.files },
  { id: 'explorer', text: 'Explorer', hotkey: TAB_HOTKEYS.explorer }, // --- explorer ---
  { id: 'sources', text: 'Sources', hotkey: TAB_HOTKEYS.sources },
  { id: 'resources', text: 'Resources', hotkey: TAB_HOTKEYS.resources },
  { id: 'compute', text: 'Compute', hotkey: TAB_HOTKEYS.compute },
  // --- ports ---
  { id: 'ports', text: 'Ports', hotkey: TAB_HOTKEYS.ports },
  // --- end ports ---
  { id: 'cache', text: 'Cache', hotkey: TAB_HOTKEYS.cache },
]

/** Which tabs draw live figures, and so are drawn again on every sampler write. */
export const isLiveTab = (tab: MonitorTab): boolean => tab === 'overview' || tab === 'resources' || tab === 'compute' || tab === 'cache'

type Strip = {
  status: Pulse['status']
  message?: string
  netIn: number
  netOut: number
  rates?: { netInBps: number; netOutBps: number; cpuPct: number; watts: number; mem: number }
  costUsd?: number
  contextPct?: number
  batteryPct?: number
  isCharging?: boolean
}

/** The strip's figures: live ones on the live tabs, the 10-second summary elsewhere. */
const stripOf = (data: PaneData): Strip | null => {
  const { live, pulse } = data
  if (live !== null) {
    const s = live.session
    return {
      status: live.status,
      message: live.message,
      netIn: s.netIn,
      netOut: s.netOut,
      rates: { netInBps: s.netInBps, netOutBps: s.netOutBps, cpuPct: s.cpuPct, watts: s.watts, mem: s.mem },
      costUsd: data.usage?.costUsd ?? pulse?.costUsd,
      contextPct: data.usage?.contextPct ?? pulse?.contextPct,
      batteryPct: pulse?.batteryPct,
      isCharging: pulse?.isCharging,
    }
  }
  if (pulse === null) {
    return null
  }
  return { ...pulse, message: undefined }
}

/** The Mac's RAM: what the sampler measured, else what `sysctl hw.memsize` said at the start; 0 while neither is known. */
const ramOf = (data: PaneData): number => {
  const measured = data.live?.system.memTotal ?? 0
  return measured > 0 ? measured : data.memTotal
}

const liveStrip = (data: PaneData, ui: Ui, act: Actions): RenderElement | null => {
  const { Box, Text } = ui
  const strip = stripOf(data)
  if (strip === null) {
    return null
  }
  const state =
    strip.status === 'running'
      ? { text: '● LIVE', tone: 'success' as const }
      : strip.status === 'starting'
        ? { text: '○ starting', tone: 'warning' as const }
        : strip.status === 'paused'
          ? { text: '❚❚ paused', tone: 'warning' as const }
          : { text: strip.status === 'unsupported' ? '○ metrics off' : '✗ sampler', tone: 'error' as const }
  const total = strip.netIn + strip.netOut
  const rates = strip.rates
  return (
    <Box flexDirection="column" rowGap={data.space.row}>
      <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap} rowGap={data.space.row}>
        <Text bold color={state.tone}>
          {state.text}
        </Text>
        <Text>
          <Text color={toneNetTotal(total)} bold>
            ⇅ {fmtBytes(total)}
          </Text>
          <Text dimColor> used</Text>
          <Text dimColor>
            {' '}
            (↓ {fmtBytes(strip.netIn)} ↑ {fmtBytes(strip.netOut)})
          </Text>
        </Text>
        {rates !== undefined && <Text color={toneRate(rates.netInBps)}>↓ {fmtRate(rates.netInBps)}</Text>}
        {rates !== undefined && <Text color={toneRate(rates.netOutBps)}>↑ {fmtRate(rates.netOutBps)}</Text>}
        {rates !== undefined && <Text color={toneCpu(rates.cpuPct)}>CPU {fmtPct(rates.cpuPct)}</Text>}
        {rates !== undefined && <Text color={toneWatts(rates.watts)}>⚡ {fmtWatts(rates.watts)}</Text>}
        {rates !== undefined && <Text color={toneMem(rates.mem)}>Mem {fmtMemory(rates.mem, ramOf(data))}</Text>}
        {strip.costUsd !== undefined && <Text color="claude">{fmtUsd(strip.costUsd)}</Text>}
        {strip.contextPct !== undefined && <Text color={tonePercentUsed(strip.contextPct)}>ctx {fmtPct(strip.contextPct)}</Text>}
        {/* --- ui polish --- */}
        {strip.contextPct !== undefined && compactButton(data, ui, act, 'compact')}
        {/* --- ui polish --- */}
        {strip.batteryPct !== undefined && (
          <Text color={strip.batteryPct <= 20 ? 'error' : strip.batteryPct <= 40 ? 'warning' : 'success'}>
            🔋 {strip.batteryPct}%{strip.isCharging === true ? ' ⚡' : ''}
          </Text>
        )}
        {rates === undefined && <Text dimColor>updates every 10 s here</Text>}
      </Box>
      {strip.message !== undefined && strip.status !== 'running' && (
        <Text color={strip.status === 'paused' ? 'warning' : 'error'}>{oneLine(strip.message, 300)}</Text>
      )}
    </Box>
  )
}

const tabText = (id: MonitorTab, text: string, pulse: Pulse | null): string => {
  if (pulse === null) {
    return text
  }
  if (id === 'commands') {
    return `${text} ${pulse.commands}${pulse.running > 0 ? ` · ${pulse.running} live` : ''}`
  }
  if (id === 'files') {
    return `${text} ${pulse.files}`
  }
  if (id === 'prompts' && (pulse.prompts ?? 0) > 0) {
    return `${text} ${pulse.prompts ?? 0}`
  }
  if (id === 'sources') {
    return `${text} ${pulse.sources}`
  }
  // --- agents ---
  if (id === 'agents') {
    const live = pulse.agentsLive ?? 0
    return `${text}${(pulse.agents ?? 0) > 0 ? ` ${pulse.agents ?? 0}` : ''}${live > 0 ? ` · ${live} live` : ''}`
  }
  // --- end agents ---
  return text
}

/** The tab a button's key names (`tab:commands`); undefined for any other key. */
export const tabOfKey = (key: string): MonitorTab | undefined => TABS.find(tab => `tab:${tab.id}` === key)?.id

/** The tab buttons, each with its hotkey; they scroll away with the rest of the pane. In the desktop app, a Client's (view/tab-bar.tsx). */
const tabButtons = (data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Button } = ui
  if (ui.TabBar !== undefined) {
    const tabs = TABS.map(tab => ({ id: tab.id, label: tabText(tab.id, tab.text, data.pulse), hotkey: tab.hotkey, isActive: data.ui.tab === tab.id }))
    return ui.TabBar(TAB_BAR_KEY, { tabs, columnGap: data.space.gap - 1, rowGap: data.space.row })
  }
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap - 1} rowGap={data.space.row}>
      {TABS.map(tab => (
        <Button
          key={`tab:${tab.id}`}
          label={tabText(tab.id, tab.text, data.pulse)}
          hotkey={tab.hotkey}
          variant={data.ui.tab === tab.id ? 'primary' : 'secondary'}
          onPress={() => act.setTab(tab.id)}
        />
      ))}
    </Box>
  )
}

const header = (data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box } = ui
  return (
    <Box flexDirection="column" rowGap={data.space.row}>
      {tabButtons(data, ui, act)}
      {liveStrip(data, ui, act)}
    </Box>
  )
}

/** What each tab draws. */
const TAB_VIEWS: Readonly<Record<MonitorTab, (data: PaneData, ui: Ui, act: Actions) => RenderElement>> = {
  overview,
  commands: commandsTab,
  prompts: promptsTab,
  compute: computeTab,
  agents: agentsTab,
  files: filesTab,
  explorer: explorerTab, // --- explorer ---
  commits: commitsTab,
  sources: sourcesTab,
  resources: resourcesTab,
  ports: portsTab,
  cache: cacheTab,
}

/**
 * The most a drawing for an app may come to as the engine sends it (its text
 * held to the engine's 100,000 characters, a Link it will not send as the
 * Text it sends instead, lib/fit.ts sentCostOf), just short of the desktop
 * app's bounds (DESKTOP_LIMITS). sentCostOf counts nodes and depth as the
 * app does, so those sit a hair under its limits: a drawing the app
 * would draw is drawn. The characters keep room for a live figure's growth,
 * sentCostOf's estimate being above the app's count. The lists are held well
 * under it all; this is the net under them.
 */
export const PANE_SAFE: DrawCost = { nodes: 1_990, depth: 31, chars: 255_000 }

/** Whether a drawing of this cost is one the desktop app draws, with room to spare. */
export const fitsPane = (cost: DrawCost): boolean => cost.nodes < PANE_SAFE.nodes && cost.depth < PANE_SAFE.depth && cost.chars < PANE_SAFE.chars

/** The key of the notice drawn in place of a tab too big to draw. */
export const TOO_BIG_KEY = 'pane:toobig'

/** A drawing's bounds, in the order the notice names them, and what each counts. */
const BOUND_NOUNS: readonly (readonly [keyof DrawCost, string])[] = [
  ['nodes', 'elements'],
  ['depth', 'levels'],
  ['chars', 'characters'],
]

/**
 * Why the pane draws a notice in place of a drawing of this cost: each bound
 * it reached, against the pane's own (PANE_SAFE), which the guard holds to,
 * and the app's past it (DESKTOP_LIMITS). Quoting the app's alone would read
 * as a contradiction between the two: 1,857 elements, and an app that draws
 * fewer than 2,000.
 */
export const tooBigText = (cost: DrawCost): string => {
  const reached = BOUND_NOUNS.filter(([bound]) => cost[bound] >= PANE_SAFE[bound])
  const list = (of: DrawCost, isNamed: boolean): string => reached.map(([bound, noun]) => `${of[bound].toLocaleString('en-US')}${isNamed ? ` ${noun}` : ''}`).join(' and ')
  return `It came to ${list(cost, true)}; the pane draws fewer than ${list(PANE_SAFE, false)}, short of the app's ${list(DESKTOP_LIMITS, false)}, at which the app would go on showing the drawing before, its buttons dead. Close what is open, or pick another tab.`
}

/** What Close what is open leaves of the pane's state: no call, output, prompt, commit, agent or task open, the rest as it was. */
export const closedAll = (current: UiState): UiState => ({
  ...current,
  expandedCommand: null,
  fullOutput: null,
  openPrompt: null,
  markedPrompt: null,
  openCommit: null,
  expandedAgent: null,
  openTask: null,
})

/** What the pane says in place of a tab the app would not draw: why, and a button that closes what made it so big. */
const tooBigNotice = (cost: DrawCost, data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Text, Button } = ui
  return (
    <Box key={TOO_BIG_KEY} flexDirection="column" rowGap={data.space.row} borderStyle="round" borderColor="warning" paddingX={2} paddingY={1}>
      <Text bold color="warning">
        This view is too big for the app to draw
      </Text>
      <Text dimColor>{tooBigText(cost)}</Text>
      <Box flexDirection="row">
        <Button key="pane:closeopen" label="Close what is open" variant="primary" onPress={() => act.closeOpen()} />
      </Box>
    </Box>
  )
}

export const pane = (data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box } = ui
  const tab = data.ui.tab
  const body = TAB_VIEWS[tab](data, ui, act)
  const frame = (content: RenderElement): RenderElement => (
    <Box flexDirection="column" gap={data.space.section} paddingX={data.surface === 'terminal' ? 0 : 1}>
      {header(data, ui, act)}
      {content}
    </Box>
  )
  const drawn = frame(body)
  // The terminal draws a tree of any size; an app keeps the drawing before one past its bounds, and its buttons die with it.
  if (data.surface === 'terminal') {
    return drawn
  }
  const cost = sentCostOf(drawn)
  return fitsPane(cost) ? drawn : frame(tooBigNotice(cost, data, ui, act))
}

/** A connect time: `38 ms`, `<1 ms` on the Mac itself, `1.2 s` on a slow network. */
const fmtLatency = (ms: number): string => (ms < 1 ? '<1 ms' : ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`)

/** A figure, or a dash while it is not measured. */
const orDash = (value: number | undefined, show: (value: number) => string): string => (value === undefined ? '—' : show(value))

/**
 * The status line under the prompt: the whole Mac and nothing else. CPU and
 * memory in use as shares of the machine, the network both ways, and the
 * latency to the Claude API once a probe has one. While the sampler is not
 * running (before its first tick, or stopped) every figure is a dash, not a
 * stale or made-up number.
 */
export const statusLine = (live: LiveMetrics): string => {
  const mac = live.system
  const isLive = live.status === 'running'
  const memPct = mac.memUsed === undefined || mac.memTotal === undefined ? undefined : memShare(mac.memUsed, mac.memTotal)
  const parts = [
    `CPU ${orDash(isLive ? mac.cpuPct : undefined, fmtPct)}`,
    `Mem ${orDash(isLive ? memPct : undefined, fmtPct)}`,
    isLive ? `↓ ${fmtRate(mac.netInBps)} ↑ ${fmtRate(mac.netOutBps)}` : '↓ — ↑ —',
  ]
  if (isLive && mac.latencyMs !== undefined) {
    parts.push(`ping ${fmtLatency(mac.latencyMs)}`)
  }
  return parts.join(' · ')
}

/**
 * What the header and the strip above the prompt show of a summary. A new
 * summary is written only when this changes, so a tab that draws nothing live
 * is not drawn again for a byte of network traffic: a redraw takes the focus
 * off the code view's frames, and with it a selection's ⌘C.
 */
export const pulseKey = (value: Pulse): string =>
  JSON.stringify({
    ...value,
    t: 0,
    netIn: fmtBytes(value.netIn),
    netOut: fmtBytes(value.netOut),
    total: fmtBytes(value.netIn + value.netOut),
    costUsd: value.costUsd === undefined ? undefined : fmtUsd(value.costUsd),
    contextPct: value.contextPct === undefined ? undefined : fmtPct(value.contextPct),
  })

/** A count and its noun, singular for one: `1 prompt`, `2 prompts`. */
const counted = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

/** The tabs the quick-stats strip above the prompt opens, in the tab bar's order. */
export const QUICK_TABS = ['overview', 'prompts', 'agents', 'commands', 'commits', 'files', 'explorer', 'sources'] as const

export type QuickTab = (typeof QUICK_TABS)[number]

/** The quick-stats strip's buttons above the prompt: each opens its tab. */
export const quickLabels = (pulse: Pulse): Record<QuickTab, string> => {
  const lines = (pulse.plus ?? 0) + (pulse.minus ?? 0) > 0 ? ` (+${pulse.plus ?? 0} −${pulse.minus ?? 0})` : ''
  const live = pulse.agentsLive ?? 0
  return {
    overview: 'Overview',
    prompts: counted(pulse.prompts ?? 0, 'prompt'),
    commands: `${pulse.commands} cmds${pulse.running > 0 ? ` · ${pulse.running} running` : ''}${pulse.failed > 0 ? ` · ✗${pulse.failed}` : ''}`,
    agents: `${counted(pulse.agents ?? 0, 'agent')}${live > 0 ? ` · ${live} live` : ''}`,
    files: `±${pulse.changed ?? 0} files${lines}`,
    explorer: 'Explorer',
    commits: counted(pulse.commits ?? 0, 'commit'),
    sources: `${pulse.sources} sources`,
  }
}
