// Overview: the models, your latest prompts and the agents, the latest calls
// to finish, commands by kind and what runs now, the session's figures, the
// heaviest commands, each tool's calls, time spent and what was published,
// each a card. The live rates are the header's, over every tab; the charts
// are Compute's.

import type { RenderElement } from 'claude-code'

import type { ArtifactRecord, CommandRecord, GroupSample, LiveMetrics, ModelUse, RateLimitView, Totals, UsageView } from '../../types'
// --- agents ---
import { agentsSection, OVERVIEW_AGENTS_CARD } from './agents'
import { EFFORT_LEVELS, effortName, modelLabel, type EffortLevel } from '../lib/effort'
import { SLIDER_ACCENT } from './effort-slider'
import { latestPromptsSection, OVERVIEW_PROMPTS_CARD } from './prompts'
// --- end agents ---
import {
  accessTone,
  accessWord,
  clip,
  fmtBytes,
  fmtClock,
  fmtCpuSeconds,
  fmtDuration,
  fmtMemory,
  fmtPct,
  fmtRate,
  fmtTokens,
  fmtUsd,
  fmtWatts,
  keyOf,
  meter,
  oneLine,
  shortModel,
  statusGlyph,
  statusTone,
  toneCpu,
  toneDuration,
  toneEnergy,
  toneMem,
  toneNetTotal,
  tonePercentUsed,
  toneRate,
  toneUsd,
  toneWatts,
  type Tone,
} from '../lib/format'
import { actorText, callRuns, commandGap, modelSegs, netSeg } from './commands'
import type { RowSegment } from './row'
import { sessionBars, viewedData } from './sessions' // --- session history ---
import { sessionChanges, summarize } from '../lib/git'
import { ZERO_TOTALS } from '../lib/sampler'
import { summarizeSources } from '../lib/sources'
import { ACCESSES, activeRate, byAccess, byTool, elapsedMs, RECENT_COUNT, recentlyFinished, runningOrRecent, timeStats } from '../lib/stats'
// --- ui polish ---
import { compactButton } from './compact'
// --- ui polish ---
import { callCard, cardStack, energySum, picker, energyText, figure, figureRow, NET_IN, notedFigure, rowLine, sectionCard, seg, TITLE_COLOR, titleSeg, type Actions, type PaneData, type Ui } from './kit'

/** The keys of Overview's cards, in the order drawn (the Prompts and Agents cards are drawn by their tabs' views). */
export const OVERVIEW_CARDS = {
  controls: 'card:ov:controls',
  models: 'card:ov:models',
  prompts: OVERVIEW_PROMPTS_CARD,
  agents: OVERVIEW_AGENTS_CARD,
  recent: 'card:ov:recent',
  commands: 'card:ov:commands',
  running: 'card:ov:running',
  session: 'card:ov:session',
  top: 'card:ov:top',
  tools: 'card:ov:tools',
  time: 'card:ov:time',
  artifacts: 'card:ov:artifacts',
} as const

type Share = { name: string; totals: Totals; rateIn: number; rateOut: number; tone: Tone }

const fold = (groups: readonly GroupSample[], extra?: Totals): { totals: Totals; rateIn: number; rateOut: number } => {
  const totals: Totals = { ...ZERO_TOTALS }
  let rateIn = 0
  let rateOut = 0
  const add = (more: Totals): void => {
    totals.cpuS += more.cpuS
    totals.energyJ += more.energyJ
    totals.energyEstJ += more.energyEstJ
    totals.netIn += more.netIn
    totals.netOut += more.netOut
    totals.diskR += more.diskR
    totals.diskW += more.diskW
    totals.netActiveS += more.netActiveS
  }
  for (const group of groups) {
    add(group.tot)
    rateIn += group.netInBps
    rateOut += group.netOutBps
  }
  if (extra !== undefined) {
    add(extra)
  }
  return { totals, rateIn, rateOut }
}

export const shares = (live: LiveMetrics, commands: readonly CommandRecord[]): Share[] => {
  const by = (kinds: readonly GroupSample['kind'][]): GroupSample[] => live.groups.filter(group => kinds.includes(group.kind))
  const bash = commands.filter(record => record.tool === 'Bash')
  const commandTotals: Totals = { ...ZERO_TOTALS }
  for (const record of bash) {
    commandTotals.cpuS += record.metrics.cpuS
    commandTotals.energyJ += record.metrics.energyJ
    commandTotals.energyEstJ += record.metrics.energyEstJ
    commandTotals.netIn += record.metrics.netIn
    commandTotals.netOut += record.metrics.netOut
    commandTotals.netActiveS += record.metrics.netActiveS
  }
  return [
    { name: 'Claude engine · API & web', ...fold(by(['claude'])), tone: 'claude' },
    { name: 'MCP servers & services', ...fold(by(['service'])), tone: 'suggestion' },
    {
      name: 'Commands you ran',
      totals: commandTotals,
      rateIn: bash.reduce((total, record) => total + record.metrics.netInBps, 0),
      rateOut: bash.reduce((total, record) => total + record.metrics.netOutBps, 0),
      tone: 'warning',
    },
    { name: 'Short-lived helpers', ...fold(by(['helper']), live.shortLived), tone: 'subtle' },
    { name: 'This monitor', ...fold(by(['monitor'])), tone: 'inactive' },
  ]
}

/** Commands by read / write / execute: how many, how long, the longest, and failures. */
const commandsCard = (data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Text, Button } = ui
  const bash = data.commands.filter(record => record.tool === 'Bash')
  const all = timeStats(bash, data.now)
  const classes = byAccess(bash, data.now)
  const longest = all.longest
  const longestMs = longest === undefined ? 0 : elapsedMs(longest, data.now)
  return sectionCard(ui, data, OVERVIEW_CARDS.commands, 'Commands', 'shell commands by read, write and execute', [
    figureRow(ui, data, [
      figure(ui, data, 'Run', String(all.count)),
      figure(ui, data, 'Total time', fmtDuration(all.totalMs)),
      figure(ui, data, 'Average', fmtDuration(all.avgMs)),
      figure(ui, data, 'Failed', String(all.failed), all.failed > 0 ? 'error' : 'subtle'),
      ...(longest === undefined ? [] : [notedFigure(ui, data, 'Longest', fmtDuration(longestMs), oneLine(longest.summary, 48), toneDuration(longestMs))]),
    ]),
    <Box flexDirection="column">
      {ACCESSES.map(access => {
        const stats = classes[access]
        const slowest = stats.longest
        return (
          <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap}>
            <Box width={10} flexShrink={0}>
              <Text color={accessTone(access)} bold>
                {accessWord(access)}
              </Text>
            </Box>
            <Box width={6} flexShrink={0} justifyContent="flex-end">
              <Text bold>{stats.count}</Text>
            </Box>
            <Box width={10} flexShrink={0} justifyContent="flex-end">
              <Text>{fmtDuration(stats.totalMs)}</Text>
            </Box>
            <Box width={13} flexShrink={0}>
              <Text dimColor> avg {fmtDuration(stats.avgMs)}</Text>
            </Box>
            {stats.failed > 0 && (
              <Box flexShrink={0}>
                <Text color="error">✗ {stats.failed}</Text>
              </Box>
            )}
            {slowest !== undefined && (
              <Box flexGrow={1} flexShrink={0} width={WRAP_ROOM}>
                <Text dimColor>
                  longest {fmtDuration(elapsedMs(slowest, data.now))} · {oneLine(slowest.title, 120)}
                </Text>
              </Box>
            )}
          </Box>
        )
      })}
    </Box>,
    <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap} rowGap={data.space.row} alignItems="center">
      <Button key="time:commands" label="See every command" dimColor onPress={() => act.setTab('commands')} />
      <Text dimColor>
        <Text color={accessTone('read')}>R</Text> reads · <Text color={accessTone('write')}>W</Text> writes files ·{' '}
        <Text color={accessTone('execute')}>X</Text> runs programs
      </Text>
    </Box>,
  ])
}

/** The room a row's free text (a class's longest call) starts at before the row wraps it under its figures. */
const WRAP_ROOM = 28

/** How many tools Overview's By tool lists. */
const TOOLS_SHOWN = 10

/** Every tool's calls: how many, how long in total and on average, and how many failed; the most time first. */
const toolsCard = (data: PaneData, ui: Ui): RenderElement | null => {
  const { Box, Text } = ui
  const tools = byTool(data.commands, data.now)
  if (tools.length === 0) {
    return null
  }
  const top = Math.max(1, ...tools.map(tool => tool.totalMs))
  const failures = (name: string): number => data.commands.filter(record => record.tool === name && record.status === 'error').length
  return sectionCard(ui, data, OVERVIEW_CARDS.tools, 'By tool', `${tools.length} tool${tools.length === 1 ? '' : 's'} · the most time first`, [
    <Box flexDirection="column">
      {tools.slice(0, TOOLS_SHOWN).map(tool => {
        const failed = failures(tool.tool)
        return (
          <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap}>
            <Box width={24} flexShrink={0}>
              <Text color="claude">
                {tool.tool.startsWith('mcp__') ? tool.tool.slice(5).replace('__', ' · ') : tool.tool}
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text color="suggestion">{meter(tool.totalMs / top, 10)}</Text>
            </Box>
            <Box width={6} flexShrink={0} justifyContent="flex-end">
              <Text bold>{tool.count}</Text>
            </Box>
            <Box width={10} flexShrink={0} justifyContent="flex-end">
              <Text>{fmtDuration(tool.totalMs)}</Text>
            </Box>
            <Box flexShrink={0}>
              <Text dimColor>avg {fmtDuration(tool.totalMs / Math.max(1, tool.count))}</Text>
            </Box>
            {failed > 0 && (
              <Box flexShrink={0}>
                <Text color="error">✗ {failed}</Text>
              </Box>
            )}
          </Box>
        )
      })}
      {tools.length > TOOLS_SHOWN && <Text dimColor>and {tools.length - TOOLS_SHOWN} more</Text>}
    </Box>,
  ])
}

/** Time spent: monitored, on the network (and by whom), running tool calls, and agents working. */
const timeCard = (data: PaneData, live: LiveMetrics, ui: Ui): RenderElement => {
  const { Text } = ui
  const s = live.session
  const monitored = Math.max(1, (live.t - live.startedAt) / 1000)
  const bytes = s.netIn + s.netOut
  const parts = shares(live, data.commands).filter(part => part.totals.netActiveS > 0.05)
  const calls = timeStats(data.commands, data.now)
  const agentMs = data.agents.reduce((total, record) => total + record.activeMs, 0)
  return sectionCard(ui, data, OVERVIEW_CARDS.time, 'Time spent', 'how long the session used the network, ran tools and ran agents', [
    figureRow(ui, data, [
      figure(ui, data, 'Monitored', fmtDuration(monitored * 1000)),
      notedFigure(
        ui,
        data,
        'Internet active',
        <Text bold color={NET_IN}>
          {fmtDuration(s.netActiveS * 1000)}
        </Text>,
        `${fmtPct(Math.min(100, (s.netActiveS / monitored) * 100))} of the time`,
      ),
      notedFigure(ui, data, 'Moved', fmtBytes(bytes), `at ${fmtRate(activeRate(bytes, s.netActiveS))} while active`, toneNetTotal(bytes)),
      notedFigure(ui, data, 'Tool calls', fmtDuration(calls.totalMs), `over ${calls.count} calls · avg ${fmtDuration(calls.avgMs)}`),
      ...(agentMs > 0 ? [notedFigure(ui, data, 'Agents', fmtDuration(agentMs), 'working, summed over every agent')] : []),
    ]),
    ...(parts.length > 0
      ? [
          <Text dimColor>On the network</Text>,
          figureRow(
            ui,
            data,
            parts.map(part => figure(ui, data, part.name.split(' ·')[0] ?? part.name, fmtDuration(part.totals.netActiveS * 1000), part.tone)),
          ),
        ]
      : []),
  ])
}

/** The model picker's key, the slider's, and a level button's where no slider is drawn. */
export const MODEL_PICKER_KEY = 'ov:model'
export const EFFORT_SLIDER_KEY = 'ov:effort'
export const effortButtonKey = (level: EffortLevel): string => `ov:effort:${level}`
export const APPLY_SETTINGS_KEY = 'ov:apply'

/**
 * The session's model and effort, to change: the model from the `/config`
 * Model row's choices, the effort on a slider from Faster to Smarter (five
 * level buttons where the surface draws no slider). A level set waits for
 * the session to be idle and applies from the next request.
 */
const controlsCard = (data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Text, Button } = ui
  const settings = data.settings
  const level = settings.draftEffort !== '' ? settings.draftEffort : settings.askedEffort !== '' ? settings.askedEffort : settings.effort
  const model = settings.draftModel !== '' ? settings.draftModel : settings.model
  const isDirty = (settings.draftModel !== '' && settings.draftModel !== settings.model) || (settings.draftEffort !== '' && settings.draftEffort !== (settings.askedEffort !== '' ? settings.askedEffort : settings.effort))
  const options = (settings.modelOptions.includes(model) || model === '' ? settings.modelOptions : [model, ...settings.modelOptions]).map(value => ({
    value,
    label: modelLabel(value),
  }))
  const isPending = settings.askedEffort !== '' && settings.askedEffort !== settings.effort
  const apply = <Button key={APPLY_SETTINGS_KEY} label={isDirty ? 'Apply' : 'Applied'} variant={isDirty ? 'primary' : 'secondary'} dimColor={!isDirty} onPress={() => act.applySettings()} />
  return sectionCard(ui, data, OVERVIEW_CARDS.controls, 'Model & effort', isDirty ? 'picked · press Apply to change' : 'for the next requests', [
    options.length === 0 || settings.isModelLocked ? (
      <Text dimColor>{settings.isModelLocked ? `Model ${modelLabel(settings.model)}: set by your organization.` : 'The model list is not known yet.'}</Text>
    ) : (
      picker(ui, MODEL_PICKER_KEY, 'Model', model, options, value => act.setModel(value))
    ),
    <Box flexDirection="row" columnGap={data.space.gap} alignItems="center">
      <Text bold>Effort</Text>
      <Text color={SLIDER_ACCENT} bold>
        {level === '' ? 'not known yet' : effortName(level)}
      </Text>
      {isPending && !isDirty && <Text dimColor>set · applies from the next request</Text>}
    </Box>,
    ui.EffortSlider !== undefined ? (
      ui.EffortSlider(EFFORT_SLIDER_KEY, { level, isTerminal: data.surface === 'terminal' })
    ) : (
      <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap - 1} rowGap={data.space.row}>
        {EFFORT_LEVELS.map(one => (
          <Button key={effortButtonKey(one)} label={effortName(one)} variant={one === level ? 'primary' : 'secondary'} onPress={() => act.setEffort(one)} />
        ))}
      </Box>
    ),
  ], { action: apply })
}

/** The models that did the work: each model and effort, with its prompts, turns, requests and calls. */
const modelsCard = (data: PaneData, models: readonly ModelUse[], ui: Ui): RenderElement | null => {
  if (models.length === 0) {
    return null
  }
  return sectionCard(
    ui,
    data,
    OVERVIEW_CARDS.models,
    'Models & effort',
    'who did the work',
    models.map(use =>
      figureRow(ui, data, [
        figure(ui, data, 'Model', shortModel(use.model), 'claude'),
        figure(ui, data, 'Effort', use.effort, 'merged'),
        figure(ui, data, 'Prompts', String(use.prompts)),
        figure(ui, data, 'Turns', String(use.turns)),
        figure(ui, data, 'Requests', String(use.requests)),
        figure(ui, data, 'Tool calls', String(use.toolCalls), 'suggestion'),
        ...(use.agentRequests > 0 ? [figure(ui, data, 'Sub-agent requests', String(use.agentRequests))] : []),
      ]),
    ),
  )
}

/**
 * The last few calls to finish, newest first, each a card of its own with
 * room between them; a click opens one in Commands. Their titles are blue,
 * as the Commands tab's are.
 */
const recentCard = (data: PaneData, ui: Ui, act: Actions): RenderElement | null => {
  const { Box } = ui
  const recent = recentlyFinished(data.commands)
  if (recent.length === 0) {
    return null
  }
  const failed = recent.filter(record => record.status === 'error').length
  return sectionCard(ui, data, OVERVIEW_CARDS.recent, 'Most recent commands', `last ${Math.min(RECENT_COUNT, recent.length)}${failed > 0 ? ` · ${failed} failed` : ''}`, [
    <Box flexDirection="column" rowGap={commandGap(data.space)}>
      {recent.map(record => {
        const ms = elapsedMs(record, data.now)
        const actor = actorText(record, data.agents)
        const segments: RowSegment[] = [
          seg(statusGlyph(record.status, 0), { color: statusTone(record.status), bold: true }),
          seg(fmtClock(record.endedAt ?? record.startedAt, data.now), { dim: true }),
          seg(fmtDuration(ms), { color: toneDuration(ms), width: 7 }),
          seg(actor.text, { color: actor.tone, bold: true }),
          ...(record.tool !== 'Bash' ? [seg(clip(record.tool.startsWith('mcp__') ? record.tool.slice(5) : record.tool, 24), { color: 'suggestion' })] : []),
          titleSeg(record.summary, false, TITLE_COLOR),
          netSeg(record),
          ...modelSegs(record.model, record.effort),
          ...(record.spend !== undefined ? [seg(`≈ ${fmtUsd(record.spend.usd)}`, { color: toneUsd(record.spend.usd), role: 'stat' })] : []),
        ]
        const row = rowLine(ui, data, `recent:${record.id}`, { kind: 'cmd', id: record.id, path: '' }, segments, () => act.toggleCommand(record.id), false, callRuns(record))
        return callCard(ui, data, record.id, record.status, [row])
      })}
    </Box>,
  ])
}

/** How many artifacts Overview lists, the newest first. */
const ARTIFACTS_SHOWN = 8

/** The pages published with the Artifact tool and the files sent to you, newest first. */
const artifactsCard = (live: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Text, Button, Link } = ui
  const data = viewedData(live) // --- session history --- a past session chosen in the picker: its artifacts
  const list: readonly ArtifactRecord[] = data.artifacts
  const pages = list.filter(one => one.kind === 'page').length
  const files = list.length - pages
  const aside = list.length === 0 ? '' : `${pages} page${pages === 1 ? '' : 's'} · ${files} file${files === 1 ? '' : 's'} sent`
  const rows =
    list.length === 0
      ? [<Text dimColor>{data.viewed !== null ? 'That session published no pages and sent no files.' : 'None yet. Pages Claude publishes with the Artifact tool and files it sends you appear here.'}</Text>]
      : list.slice(0, ARTIFACTS_SHOWN).map(one => (
          <Box flexDirection="column">
            <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap} alignItems="center">
              <Text color={one.kind === 'page' ? 'claude' : 'suggestion'} bold>
                {one.kind === 'page' ? '◆' : '↧'}
              </Text>
              <Text dimColor>{fmtClock(one.lastAt, data.now)}</Text>
              {one.url !== undefined ? <Link href={one.url} label={oneLine(one.title, 80)} /> : <Text bold>{oneLine(one.title, 80)}</Text>}
              <Text dimColor>{one.kind === 'page' ? `page${one.version !== undefined ? ` · v${oneLine(one.version, 12)}` : ''}` : 'file sent'}</Text>
              {one.count > 1 && <Text dimColor>· {one.kind === 'page' ? 'published' : 'sent'} {one.count}×</Text>}
              {one.kind === 'file' && one.path !== undefined && (
                <Button key={`art:${keyOf(one.id)}`} label="Reveal in Finder" dimColor onPress={() => act.revealArtifact(one.id)} />
              )}
            </Box>
            {(one.caption !== undefined || one.path !== undefined) && (
              <Box marginLeft={2}>
                <Text dimColor>
                  {oneLine(one.caption ?? one.path ?? '', 200)}
                </Text>
              </Box>
            )}
          </Box>
        ))
  const more = list.length > ARTIFACTS_SHOWN ? [<Text dimColor>and {list.length - ARTIFACTS_SHOWN} more</Text>] : []
  return sectionCard(ui, data, OVERVIEW_CARDS.artifacts, 'Artifacts', aside, [...sessionBars(data, ui, act, 'artifacts'), ...rows, ...more])
}

/**
 * What runs now: how many calls and agents are at work (the counts the
 * header leaves out), then each call with its live CPU, memory (with its share
 * of the Mac's RAM), power and network; a click opens one in Commands.
 */
const runningCard = (data: PaneData, live: LiveMetrics, ui: Ui, act: Actions): RenderElement => {
  const { Box, Text } = ui
  // Finished calls linger LINGER_MS, so a quick one is on screen long enough to read.
  const running = runningOrRecent(data.commands, data.now)
  const activeCount = running.filter(record => record.status === 'running' || record.status === 'background').length
  const finished = running.length - activeCount
  const agentsLive = data.pulse?.agentsLive ?? 0
  const frame = Math.floor(live.t / 1000)
  return sectionCard(ui, data, OVERVIEW_CARDS.running, 'Running now', 'tool calls and agents at work this moment', [
    figureRow(ui, data, [
      figure(ui, data, 'Calls running', String(activeCount), activeCount > 0 ? 'warning' : 'subtle'),
      ...(finished > 0 ? [figure(ui, data, 'Just finished', String(finished), 'success')] : []),
      figure(ui, data, 'Agents working', String(agentsLive), agentsLive > 0 ? 'warning' : 'subtle'),
    ]),
    running.length === 0 ? (
      <Text dimColor>Nothing running. A call shows here while it runs, and for a few seconds after it ends.</Text>
    ) : (
      <Box flexDirection="column" rowGap={data.space.row}>
        {running.slice(-8).map(record => {
          const ms = elapsedMs(record, data.now)
          const net = record.metrics.netInBps + record.metrics.netOutBps
          const segments: RowSegment[] = [
            seg(statusGlyph(record.status, frame), { color: statusTone(record.status), bold: true }),
            seg(fmtDuration(ms), { color: toneDuration(ms), width: 7 }),
            titleSeg(record.summary, false),
            seg(fmtPct(record.metrics.cpuPct), { color: toneCpu(record.metrics.cpuPct), width: 5, role: 'stat' }),
            seg(fmtMemory(record.metrics.mem, data.memTotal), { color: toneMem(record.metrics.mem), width: 15, role: 'stat' }),
            seg(fmtWatts(record.metrics.watts), { color: toneWatts(record.metrics.watts), width: 7, role: 'stat' }),
            seg(`⇅ ${fmtRate(net)}`, { color: toneRate(net), width: 12, role: 'stat' }),
          ]
          return rowLine(ui, data, `run:${record.id}`, { kind: 'cmd', id: record.id, path: '' }, segments, () => act.toggleCommand(record.id), false, record.title)
        })}
      </Box>
    ),
  ])
}

/** What a rate-limit window is called. */
const WINDOW_NAMES: Readonly<Record<string, string>> = { five_hour: '5-hour window', seven_day: '7-day window', spend_limit: 'Spend limit' }

/** A rate-limit window as a figure: how much of it is used, and when it resets. */
const windowFigure = (limit: RateLimitView, data: PaneData, ui: Ui): RenderElement => {
  const { Text } = ui
  const resetsAt = limit.resetsAt === undefined ? Number.NaN : Date.parse(limit.resetsAt)
  return notedFigure(
    ui,
    data,
    WINDOW_NAMES[limit.kind] ?? limit.kind.replace(/_/g, ' '),
    <Text bold>
      <Text color={tonePercentUsed(limit.percentUsed)}>{meter(limit.percentUsed / 100, 8)}</Text> {fmtPct(limit.percentUsed)}
    </Text>,
    Number.isFinite(resetsAt) ? `used · resets ${fmtClock(resetsAt, data.now)}` : 'used',
  )
}

/**
 * The session: what it cost, how full its context and its rate-limit windows
 * are, then what its work came to (commands, sources, files, lines and
 * commits), and its buttons: the charts, compact, and alerts.
 */
const sessionCard = (live: PaneData, liveUsage: UsageView, ui: Ui, act: Actions): RenderElement => {
  const { Box, Text, Button } = ui
  // --- session history ---
  // A past session chosen in the picker: its figures, read-only.
  const data = viewedData(live)
  const usage = data.viewed !== null && data.usage !== null ? data.usage : liveUsage
  // --- end session history ---
  const bash = data.commands.filter(record => record.tool === 'Bash')
  const count = (status: CommandRecord['status']): number => bash.filter(record => record.status === status).length
  const changes = summarize(sessionChanges(data.git.commits, data.git.worktree))
  const sessionCommits = data.git.commits.filter(commit => commit.isSession).length
  const sources = data.viewed !== null ? data.viewed.sources : summarizeSources(data.sources)
  const contextPct = usage.contextPct
  return sectionCard(ui, data, OVERVIEW_CARDS.session, 'Session', `${usage.model} · ${usage.turns} turns`, [
    ...sessionBars(data, ui, act, 'session'), // --- session history ---
    figureRow(ui, data, [
      ...(usage.costUsd === undefined ? [] : [figure(ui, data, 'Cost', fmtUsd(usage.costUsd), 'claude')]),
      ...(contextPct === undefined
        ? []
        : [
            notedFigure(
              ui,
              data,
              'Context',
              <Text bold>
                <Text color={tonePercentUsed(contextPct)}>{meter(contextPct / 100, 10)}</Text> {fmtPct(contextPct)}
              </Text>,
              usage.contextTokens === undefined ? `of ${fmtTokens(usage.contextWindow)} tokens` : `${fmtTokens(usage.contextTokens)} / ${fmtTokens(usage.contextWindow)} tokens`,
            ),
          ]),
      ...usage.rateLimits.map(limit => windowFigure(limit, data, ui)),
    ]),
    figureRow(ui, data, [
      notedFigure(
        ui,
        data,
        'Shell commands',
        <Text bold>
          <Text color="success">✓ {count('ok')}</Text> <Text color="error">✗ {count('error')}</Text>{' '}
          <Text color="warning">⠿ {count('running') + count('background')}</Text> <Text color="inactive">⊘ {count('denied')}</Text>
        </Text>,
        '',
      ),
      notedFigure(ui, data, 'Sources', `${sources.urls} URLs on ${sources.domains} sites`, `${sources.searches} search${sources.searches === 1 ? '' : 'es'}`, 'suggestion'),
      notedFigure(
        ui,
        data,
        'Files changed',
        <Text bold>
          <Text color="success">+{changes.added}</Text> <Text color="warning">~{changes.modified}</Text> <Text color="error">−{changes.deleted}</Text>
          {changes.renamed > 0 && <Text color="merged"> →{changes.renamed}</Text>}
        </Text>,
        changes.renamed > 0 ? 'added · modified · deleted · renamed' : 'added · modified · deleted',
      ),
      notedFigure(
        ui,
        data,
        'Lines',
        <Text bold>
          <Text color="success">+{changes.plus}</Text> <Text color="error">−{changes.minus}</Text>
        </Text>,
        '',
      ),
      notedFigure(ui, data, 'Commits', String(sessionCommits), 'this session', 'merged'),
    ]),
    // --- session history --- (the charts, compact and alerts act on this session: not shown for a past one)
    ...(data.viewed !== null
      ? []
      : [
          <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap - 1} rowGap={data.space.row} alignItems="center">
            <Button key="ov:compute" label="Charts in Compute" onPress={() => act.setTab('compute')} />
            {/* --- ui polish --- */}
            {contextPct !== undefined && compactButton(data, ui, act, 'compact:session')}
            {/* --- ui polish --- */}
            <Button key="alerts" label={data.ui.isAlerting ? 'Alerts on' : 'Alerts off'} dimColor={!data.ui.isAlerting} onPress={() => act.toggleAlerts()} />
            <Text dimColor>toasts for failed, slow, network-heavy or energy-heavy commands</Text>
          </Box>,
        ]),
  ])
}

/** The shell commands that used the most energy, network, CPU and memory; a click opens one in Commands. */
const topCard = (data: PaneData, ui: Ui, act: Actions): RenderElement | null => {
  const { Box } = ui
  const bash = data.commands.filter(record => record.tool === 'Bash' && record.metrics.isSampled)
  if (bash.length === 0) {
    return null
  }
  const pick = (score: (record: CommandRecord) => number): CommandRecord | undefined => [...bash].sort((a, b) => score(b) - score(a))[0]
  const rows: { name: string; record: CommandRecord | undefined; value: (record: CommandRecord) => string; tone: (record: CommandRecord) => Tone }[] = [
    { name: 'Most energy', record: pick(record => energySum(record.metrics)), value: record => energyText(record.metrics), tone: record => toneEnergy(energySum(record.metrics)) },
    {
      name: 'Most network',
      record: pick(record => record.metrics.netIn + record.metrics.netOut),
      value: record => fmtBytes(record.metrics.netIn + record.metrics.netOut),
      tone: record => toneNetTotal(record.metrics.netIn + record.metrics.netOut),
    },
    { name: 'Most CPU', record: pick(record => record.metrics.cpuS), value: record => fmtCpuSeconds(record.metrics.cpuS), tone: () => 'warning' },
    {
      name: 'Most memory',
      record: pick(record => record.metrics.peakMem),
      value: record => fmtMemory(record.metrics.peakMem, data.memTotal),
      tone: record => toneMem(record.metrics.peakMem),
    },
  ]
  const shown = rows.flatMap(row => {
    const record = row.record
    if (record === undefined) {
      return []
    }
    const segments: RowSegment[] = [
      seg(row.name, { dim: true, width: 13 }),
      seg(row.value(record), { color: row.tone(record), bold: true, width: 16 }),
      titleSeg(record.summary, false),
    ]
    return [rowLine(ui, data, `top:${keyOf(row.name)}`, { kind: 'cmd', id: record.id, path: '' }, segments, () => act.toggleCommand(record.id), false, record.title)]
  })
  return sectionCard(ui, data, OVERVIEW_CARDS.top, 'Heaviest commands', 'the shell command that used the most of each', [
    <Box flexDirection="column" rowGap={data.space.row}>
      {shown}
    </Box>,
  ])
}

export const overview = (data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Text } = ui
  const live = data.live
  const usage = data.usage
  if (live === null || usage === null) {
    return <Text dimColor>Loading…</Text>
  }
  const cards: (RenderElement | null)[] = [
    controlsCard(data, ui, act),
    modelsCard(data, data.models, ui),
    latestPromptsSection(data, ui, act),
    agentsSection(data, ui, act) /* --- agents --- */,
    recentCard(data, ui, act),
    commandsCard(data, ui, act),
    runningCard(data, live, ui, act),
    sessionCard(data, usage, ui, act),
    topCard(data, ui, act),
    toolsCard(data, ui),
    timeCard(data, live, ui),
    artifactsCard(data, ui, act),
  ]
  return cardStack(
    ui,
    data,
    cards.filter((one): one is RenderElement => one !== null),
  )
}
