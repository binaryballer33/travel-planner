// Agents: the sub-agents, teammates, workflows and background shells the
// session started, running ones first, each with its model, tokens, requests,
// tool calls and time; a workflow's agents nest beneath it. A summary card
// counts them; Running now and Finished hold a card for each agent. Opened,
// an agent's card shows its figures, ids and parent, then the tool calls
// made inside it, the newest first, drawn and opened as the Commands tab
// draws them.

import type { RenderElement } from 'claude-code'

import type { AgentRecord, CommandRecord, CostBreakdown } from '../../types'
import {
  agentGlyph,
  agentTone,
  allCallsOf,
  ancestorsOf,
  childrenOf,
  effectiveStatus,
  elapsedOf,
  isLive,
  isOrphan,
  kindText,
  layoutAgents,
  phaseText,
  SHELL_PREFIX,
  shellRecords,
  statusNote,
  visibleRows,
  type AgentRow,
} from '../lib/agents'
import { MAX_COMMANDS } from '../lib/commands'
import { fitList, keptRun, listShareOf } from '../lib/fit'
import { fmtClock, fmtDuration, fmtPct, fmtTokens, fmtUsd, keyOf, oneLine, shortModel, toneDuration, toneNetTotal, tonePercentUsed, toneUsd } from '../lib/format'
import { agentNetwork, callsNetText } from '../lib/prompts'
import { addParts, shareText, sumShares, windowShare, type WindowShare } from '../lib/spend'
import { commandGap, commandRow, COST_ACCENT, modelSegs } from './commands'
import { newerFromOf, pageOf, pager } from './paging'
import { agentItemCard, agentTabCard, card, cardStack, costBreakdown, figure, figureRow, panel, rowLine, section, sectionCard, seg, titleSeg, type Actions, type PaneData, type Ui } from './kit'
import type { RowPress, RowSegment } from './row'
import { sessionBars } from './sessions' // --- session history ---

/** A row's key: short and control-free whatever the id. */
export const agentKey = (id: string): string => `agent:${keyOf(id)}`

/** An opened row's card: its figures, ids and the tool calls made inside it. */
export const agentCardKey = (id: string): string => `agentcard:${keyOf(id)}`

/** The Context & cost panel in an opened row's card. */
export const agentCostKey = (id: string): string => `agentcost:${keyOf(id)}`

/** Its cost broken down by the kind of token, in its Context & cost panel. */
export const agentPartsKey = (id: string): string => `agentparts:${keyOf(id)}`

/** The list of the tool calls in an opened row's card. */
export const agentCallsKey = (id: string): string => `agentcalls:${keyOf(id)}`

/** The tab's cards: how many agents there are and what they used, then the rows still working and those finished. */
export const AGENTS_SUMMARY_KEY = 'agents-summary'
export const AGENTS_RUNNING_KEY = 'agents-running'
export const AGENTS_FINISHED_KEY = 'agents-finished'

/**
 * `rowLine` with its open flag (the accent bar and the lit row). A kit whose
 * `rowLine` takes no flag yet drops it; once it does, this is `rowLine` itself.
 */
type DrawRow = (
  ui: Ui,
  data: PaneData,
  key: string,
  press: RowPress,
  segments: readonly RowSegment[],
  onPress: () => void,
  isOpen?: boolean,
  subtitle?: string,
) => RenderElement
const drawRow: DrawRow = rowLine

/** The window a context share is taken of, when the session has not said. */
const DEFAULT_WINDOW = 200_000

const RUN_WORDS: Readonly<Record<string, string>> = { answer: 'answered', aborted: 'stopped', refusal: 'refused', error: 'failed' }

/** The context window an agent's latest request is measured against: 1M for a `[1m]` model, else the session's. */
export const windowOf = (record: AgentRecord, data: PaneData): number =>
  record.model?.endsWith('[1m]') === true ? 1_000_000 : data.usage !== null && data.usage.contextWindow > 0 ? data.usage.contextWindow : DEFAULT_WINDOW

/** About how much of the 5-hour limit a row took: its own, or for a workflow its agents' summed. */
export const blockPctOfRow = (row: AgentRow, data: PaneData): WindowShare | undefined => {
  const spend = data.spend
  if (spend === null) {
    return undefined
  }
  const records = row.record.kind === 'workflow' ? data.agents.filter(one => one.parentId === row.record.id) : [row.record]
  return sumShares(records.map(one => windowShare(one.blockUsd ?? 0, one.blockKey, spend)))
}

/** What the agent is doing now, while it works; '' for a finished one, a workflow or a shell. */
const doingNow = (row: AgentRow, data: PaneData): string => (isLive(row.status) ? phaseText(row.record, data.now) : '')

const STATUS_WORDS: Record<AgentRecord['status'], string> = {
  pending: 'Starting',
  running: 'Running',
  waiting: 'Waiting',
  idle: 'Idle',
  completed: 'Done',
  failed: 'Failed',
  killed: 'Stopped',
}

const KIND_WORDS: Record<AgentRecord['kind'], string> = {
  subagent: 'Sub-agent',
  teammate: 'Teammate',
  workflow: 'Workflow',
  'workflow-agent': 'Workflow agent',
  shell: 'Background shell',
}

/** When something last happened, and how long ago. */
const agoText = (then: number, now: number): string => `${fmtClock(then, now)} (${fmtDuration(Math.max(0, now - then))} ago)`

/** What the row is and how it stands: its status, kind and model, its times, and what it has done. */
const agentFigures = (row: AgentRow, data: PaneData, ui: Ui): RenderElement[] => {
  const record = row.record
  const ms = elapsedOf(record, data.now)
  const isAgent = record.kind !== 'shell' && record.kind !== 'workflow'
  return [
    figure(ui, data, 'Status', record.isEndAssumed === true ? 'Done (end not reported)' : STATUS_WORDS[row.status], agentTone(row.status)),
    figure(ui, data, 'Kind', KIND_WORDS[record.kind], 'claude'),
    ...(record.type !== '' && isAgent ? [figure(ui, data, 'Type', oneLine(record.type, 60), 'claude')] : []),
    figure(ui, data, 'Started', fmtClock(record.startedAt, data.now)),
    ...(record.endedAt !== undefined ? [figure(ui, data, 'Ended', fmtClock(record.endedAt, data.now))] : []),
    figure(ui, data, 'Time', fmtDuration(ms), toneDuration(ms)),
    ...(record.activeMs > 0 ? [figure(ui, data, 'Working', fmtDuration(record.activeMs))] : []),
    ...(record.model !== undefined
      ? [figure(ui, data, 'Model', oneLine(shortModel(record.model), 60), 'claude'), figure(ui, data, 'Effort', oneLine(record.effort ?? 'default', 30), 'claude')]
      : []),
    ...(row.agents > 0 ? [figure(ui, data, 'Agents', String(row.agents))] : []),
    ...(row.requests > 0 || isAgent ? [figure(ui, data, 'Requests', String(row.requests), row.requests === 0 ? 'subtle' : undefined)] : []),
    ...(isAgent ? [figure(ui, data, 'Last activity', agoText(record.lastActivityAt, data.now))] : []),
    ...(isAgent && record.lastRequestAt !== undefined ? [figure(ui, data, 'Last request', fmtClock(record.lastRequestAt, data.now))] : []),
    ...(isAgent && record.stopReason !== undefined ? [figure(ui, data, 'Stopped', oneLine(record.stopReason, 30), 'subtle')] : []),
    ...(isAgent
      ? [
          figure(ui, data, 'Started by', record.toolUseId !== undefined ? 'an Agent call' : isOrphan(record) ? 'Claude Code itself' : 'unknown'),
          figure(ui, data, "In Claude's agent list", record.wasListed ? 'yes' : 'no', record.wasListed ? 'success' : 'subtle'),
        ]
      : []),
    ...(record.turns > 0 || isAgent ? [figure(ui, data, 'Turn ends seen', String(record.turns), record.turns === 0 ? 'subtle' : undefined)] : []),
    ...(row.toolCalls > 0 ? [figure(ui, data, 'Tool calls', String(row.toolCalls))] : []),
    ...(row.tokens > 0 ? [figure(ui, data, 'Tokens', fmtTokens(row.tokens), 'suggestion')] : []),
    ...(record.tokensIn > 0 ? [figure(ui, data, 'Sent', fmtTokens(record.tokensIn), 'subtle')] : []),
    ...(record.tokensOut > 0 ? [figure(ui, data, 'Received', fmtTokens(record.tokensOut), 'subtle')] : []),
    ...(record.kind !== 'shell' ? [figure(ui, data, 'Background', record.isBackground ? 'yes' : 'no')] : []),
  ]
}

/** What its requests came to, as a panel in the Commands tab's cost accent: its latest request's size, its cost at list prices, and its share of the 5-hour window. */
const costBlock = (row: AgentRow, data: PaneData, ui: Ui): RenderElement[] => {
  const record = row.record
  const window = windowOf(record, data)
  const contextPct = (record.contextTokens / window) * 100
  const blockPct = blockPctOfRow(row, data)
  const five = data.usage?.rateLimits.find(limit => limit.kind === 'five_hour')
  const figures = [
    ...(record.contextTokens > 0
      ? [figure(ui, data, 'Context', `${fmtTokens(record.contextTokens)} (${fmtPct(contextPct)} of ${fmtTokens(window)})`, tonePercentUsed(contextPct))]
      : []),
    ...(row.usd > 0 ? [figure(ui, data, 'Cost', `≈ ${fmtUsd(row.usd)}`, toneUsd(row.usd))] : []),
    ...(blockPct !== undefined
      ? [figure(ui, data, record.kind === 'workflow' ? 'Its agents used' : 'This agent used', `${shareText(blockPct)} of the 5-hour window`, tonePercentUsed(blockPct.pct * 10))]
      : []),
    ...(five !== undefined ? [figure(ui, data, 'Window used', `${fmtPct(five.percentUsed)} of 100%`, tonePercentUsed(five.percentUsed))] : []),
    ...(five?.resetsAt !== undefined ? [figure(ui, data, 'Resets', fmtClock(Date.parse(five.resetsAt), data.now))] : []),
  ]
  const parts = partsOfRow(row, data)
  const breakdown = parts === undefined ? [] : [costBreakdown(ui, data, agentPartsKey(record.id), parts, record.kind === 'workflow' ? 'its agents’ requests' : `its ${row.requests} request${row.requests === 1 ? '' : 's'}`)]
  return figures.length === 0 && breakdown.length === 0 ? [] : [panel(ui, data, agentCostKey(record.id), 'Context & cost', COST_ACCENT, [figureRow(ui, data, figures), ...breakdown])]
}

/** A row's cost by the kind of token: its own, or a workflow's agents' added up; none where none was kept. */
const partsOfRow = (row: AgentRow, data: PaneData): CostBreakdown | undefined =>
  row.record.kind === 'workflow'
    ? data.agents.filter(one => one.parentId === row.record.id).reduce<CostBreakdown | undefined>((sum, one) => (one.parts === undefined ? sum : addParts(sum, one.parts)), undefined)
    : row.record.parts

/** Each run of its loop: when it started and ended, its requests, and how it ended. */
const runsBlock = (record: AgentRecord, data: PaneData, ui: Ui): RenderElement[] => {
  const { Box, Text } = ui
  const runs = record.runs ?? []
  return runs.length === 0
    ? []
    : [
        <Box flexDirection="column">
          <Text bold>
            Runs <Text dimColor>· {runs.length}</Text>
          </Text>
          {runs.map((run, index) => {
            const runMs = (run.endedAt ?? data.now) - run.startedAt
            return (
              <Text>
                <Text dimColor>{index + 1}. </Text>
                {fmtClock(run.startedAt, data.now)}
                <Text dimColor> → </Text>
                {run.endedAt !== undefined ? fmtClock(run.endedAt, data.now) : <Text color="warning">running</Text>}
                <Text color={toneDuration(runMs)}> {fmtDuration(runMs)}</Text>
                <Text dimColor>
                  {' '}
                  · {run.requests} request{run.requests === 1 ? '' : 's'}
                  {run.reason !== undefined ? ` · ${RUN_WORDS[run.reason] ?? oneLine(run.reason, 20)}` : ''}
                </Text>
              </Text>
            )
          })}
        </Box>,
      ]
}

/** Its ids, name, parent, task and run, and the call that started it. */
const idsBlock = (record: AgentRecord, data: PaneData, ui: Ui): RenderElement => {
  const { Box, Text } = ui
  const all = [...data.agents, ...shellRecords(data.commands)]
  const parent = record.parentId === undefined ? undefined : all.find(one => one.id === record.parentId)
  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>Id </Text>
        {oneLine(record.id, 120)}
      </Text>
      {record.name !== undefined && (
        <Text>
          <Text dimColor>Name </Text>
          {oneLine(record.name, 120)}
          {record.teammateId !== undefined && <Text dimColor> · {oneLine(record.teammateId, 120)}</Text>}
        </Text>
      )}
      {record.parentId !== undefined && (
        <Text>
          <Text dimColor>Parent </Text>
          {parent === undefined ? oneLine(record.parentId, 120) : `${oneLine(parent.label, 120)} (${oneLine(parent.id, 120)})`}
        </Text>
      )}
      {(record.taskId !== undefined || record.runId !== undefined) && (
        <Text>
          {record.taskId !== undefined && <Text dimColor>Task </Text>}
          {oneLine(record.taskId ?? '', 120)}
          {record.runId !== undefined && <Text dimColor>{record.taskId !== undefined ? ' · ' : ''}Run </Text>}
          {oneLine(record.runId ?? '', 120)}
        </Text>
      )}
      {record.toolUseId !== undefined && record.toolUseId !== record.id && record.kind !== 'shell' && (
        <Text>
          <Text dimColor>Started by call </Text>
          {oneLine(record.toolUseId, 120)}
        </Text>
      )}
    </Box>
  )
}

/**
 * Why some of the calls it made are not in the list: the monitor did not see
 * them or keeps only its newest MAX_COMMANDS, and the agent's transcript, read
 * (`isRead`) or not, does not hold them either.
 */
export const unseenText = (count: number, isRead: boolean): string =>
  `${count} not listed: the monitor did not see ${count === 1 ? 'it' : 'them'} or keeps only its newest ${MAX_COMMANDS} calls, and ${isRead ? `${count === 1 ? 'it is' : 'they are'} not in the agent's transcript` : 'its transcript could not be read'}.`

/** How many of an agent's calls a page of its card lists, the newest first. */
export const AGENT_CALLS_PAGE = 20

/** Its card's ‹ Newer and Older › over its calls. */
export const agentNewerKey = (id: string): string => `agentnewer:${keyOf(id)}`
export const agentOlderKey = (id: string): string => `agentolder:${keyOf(id)}`

/**
 * The calls made inside the agent (a workflow's: inside its agents), the
 * newest first, drawn and spaced as the Commands tab draws them: a click
 * opens one here. A page of AGENT_CALLS_PAGE, as many of them as fit
 * `callShare` of the list budget, the open call kept; ‹ Newer and Older ›
 * reach every one.
 */
const callsBlock = (row: AgentRow, data: PaneData, ui: Ui, act: Actions, callShare: number): RenderElement => {
  const { Box, Text } = ui
  const record = row.record
  const open = data.ui.expandedCommand
  const calls = allCallsOf(record, data.agents, data.commands, data.agentHistory)
  const history = data.agentHistory?.agentId === record.id ? data.agentHistory : null
  // Each row is drawn once, however many pages are weighed.
  const drawn = new Map<string, RenderElement>()
  const rowOf = (call: CommandRecord): RenderElement => {
    const made = drawn.get(call.id) ?? commandRow(call, data, ui, act)
    drawn.set(call.id, made)
    return made
  }
  const isOpen = (id: string): boolean => id === open
  // The open call, when it is further back than this page (opened from the Commands tab), is drawn after it.
  const start = Math.min(Math.max(0, data.ui.agentCallsFrom ?? 0), Math.max(0, calls.length - 1))
  const openIndex = calls.findIndex(call => call.id === open)
  const openCall = openIndex >= 0 && (openIndex < start || openIndex >= start + AGENT_CALLS_PAGE) ? calls[openIndex] : undefined
  const budget = callShare - (openCall === undefined ? 0 : listShareOf(rowOf(openCall)))
  const page = pageOf(calls, start, AGENT_CALLS_PAGE, rowOf, isOpen, budget)
  const elements = [...page.cards.map(card => card.element), ...(openCall === undefined ? [] : [rowOf(openCall)])]
  const unseen = Math.max(0, row.toolCalls - calls.length)
  return (
    <Box flexDirection="column" rowGap={data.space.row}>
      <Text bold>
        {record.kind === 'workflow' ? 'Its agents’ tool calls' : 'Tool calls'}{' '}
        <Text dimColor>
          · {calls.length}
          {unseen > 0 ? ` of ${row.toolCalls}` : ''}
          {calls.length > 1 ? ', the newest first' : ''}
        </Text>
      </Text>
      {history?.state === 'loading' ? (
        <Text dimColor>Reading its transcript for the calls the monitor no longer holds…</Text>
      ) : (
        unseen > 0 && <Text dimColor>{unseenText(unseen, history?.state !== 'failed')}</Text>
      )}
      {calls.length === 0 && unseen === 0 && history?.state !== 'loading' && <Text dimColor>None yet.</Text>}
      {elements.length > 0 && (
        <Box key={agentCallsKey(record.id)} flexDirection="column" rowGap={commandGap(data.space)}>
          {elements}
        </Box>
      )}
      {pager(
        calls.length,
        page,
        newerFromOf(calls, page, AGENT_CALLS_PAGE, rowOf, isOpen, budget),
        { newer: agentNewerKey(record.id), older: agentOlderKey(record.id) },
        false,
        from => act.pageAgentCalls(record.id, from),
        data,
        ui,
      )}
    </Box>
  )
}

/** An opened row as a card edged in its status's colour, indented with its row; its calls take at most `callShare` of the list budget. */
const agentDetail = (row: AgentRow, data: PaneData, ui: Ui, act: Actions, callShare: number): RenderElement => {
  const { Box, Text, Button, Code } = ui
  const record = row.record
  const key = keyOf(record.id)
  const commandId = record.kind === 'shell' ? record.id.slice(SHELL_PREFIX.length) : undefined
  const now = doingNow(row, data)
  const note = statusNote(record, data.now)
  return (
    <Box flexDirection="column">
      {card(
        ui,
        data,
        agentCardKey(record.id),
        [
          ...(record.kind === 'shell' && record.description !== undefined
            ? [<Code source={record.description} language="bash" />]
            : record.description !== undefined && record.description !== record.label
              ? [<Text italic>{oneLine(record.description, 400)}</Text>]
              : []),
          ...(record.brief !== undefined
            ? [
                <Text>
                  <Text dimColor>Responsible for </Text>
                  <Text italic>{record.brief}</Text>
                </Text>,
              ]
            : []),
          ...(now !== ''
            ? [
                <Text>
                  <Text dimColor>Doing now </Text>
                  <Text color="warning">{now}</Text>
                </Text>,
              ]
            : []),
          ...(note !== undefined ? [<Text color={record.isEndAssumed === true ? 'subtle' : 'suggestion'}>{note}</Text>] : []),
          ...(record.lastAnswer !== undefined && record.lastAnswer !== ''
            ? [
                <Text>
                  <Text dimColor>Last said </Text>
                  <Text italic>“{record.lastAnswer}”</Text>
                </Text>,
              ]
            : []),
          figureRow(ui, data, agentFigures(row, data, ui)),
          ...(record.kind !== 'shell' ? costBlock(row, data, ui) : []),
          ...runsBlock(record, data, ui),
          idsBlock(record, data, ui),
          ...(record.phases !== undefined && record.phases.length > 0
            ? [
                <Text>
                  <Text dimColor>Phases </Text>
                  {record.phases.join(' → ')}
                </Text>,
              ]
            : []),
          <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap} rowGap={data.space.row}>
            {commandId !== undefined && <Button key={`agentcmd:${key}`} label="Open in Commands" onPress={() => act.toggleCommand(commandId)} />}
            <Button key={`agentcopy:${key}`} label="Copy id" onPress={press => act.copy(record.id, press)} />
            <Button key={`agentclose:${key}`} label="Collapse" onPress={() => act.toggleAgent(record.id)} />
          </Box>,
          ...(record.kind !== 'shell' ? [callsBlock(row, data, ui, act, callShare)] : []),
        ],
        { tone: agentTone(row.status) },
      )}
    </Box>
  )
}

/**
 * A parent's fold: a region where the surface draws one (the desktop app),
 * so a click reaches it across the tab's redraws, which hand a plain button a
 * new handle each time; elsewhere a plain button.
 */
const foldControl = (ui: Ui, id: string, label: string, act: Actions): RenderElement => {
  const { Button } = ui
  if (ui.TitleLink !== undefined) {
    return ui.TitleLink(agentFoldKey(id), { press: { kind: 'fold', id }, text: label, color: 'subtle', bold: false })
  }
  return <Button key={agentFoldKey(id)} label={label} dimColor onPress={() => act.toggleAgentKids(id)} />
}

/** A parent card's list of what it started: how many, their names one under another, and the fold. */
export const agentKidsKey = (id: string): string => `agentkids:${keyOf(id)}`

/** Its button that folds away the cards under it, or brings them back. */
export const agentFoldKey = (id: string): string => `agentfold:${keyOf(id)}`

/** How many of its children a parent's card names; the cards under it show them all. */
const MAX_KID_NAMES = 30

/**
 * What a parent agent started (a workflow's agents, an agent's sub-agents and
 * background shells): how many, each one's name under the other with its
 * status and kind, and a button that shows their cards (folded away until
 * it is pressed, or the parent opened) or folds them away again.
 */
const kidsBlock = (row: AgentRow, data: PaneData, ui: Ui, act: Actions, shown: ReadonlySet<string>): RenderElement => {
  const { Box, Text, Button } = ui
  const record = row.record
  // A background shell is a call's record, so it is found among the calls.
  const kids = childrenOf(record, [...data.agents, ...shellRecords(data.commands)])
  const shells = kids.filter(one => one.kind === 'shell').length
  const agentCount = kids.length - shells
  const isFolded = !shown.has(record.id)
  const counts = [agentCount > 0 ? `${agentCount} agent${agentCount === 1 ? '' : 's'}` : '', shells > 0 ? `${shells} background shell${shells === 1 ? '' : 's'}` : ''].filter(part => part !== '').join(' · ')
  return (
    <Box key={agentKidsKey(record.id)} flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap} alignItems="center">
        <Text color="merged" bold>
          {counts}
        </Text>
        {foldControl(ui, record.id, isFolded ? `▸ Expand ${kids.length === 1 ? 'its card' : `their ${kids.length} cards`}` : `▾ Collapse ${kids.length === 1 ? 'its card' : `their ${kids.length} cards`}`, act)}
      </Box>
      {kids.slice(0, MAX_KID_NAMES).map(kid => {
        const status = effectiveStatus(kid, data.agents, data.now)
        return (
          <Box flexDirection="row" columnGap={data.space.gap}>
            <Text color={agentTone(status)} bold>
              {agentGlyph(status, Math.floor(data.now / 1000))}
            </Text>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text>{oneLine(kid.label, 120)}</Text>
            </Box>
            <Text dimColor>{oneLine(kindText(kid), 20)}</Text>
          </Box>
        )
      })}
      {kids.length > MAX_KID_NAMES && <Text dimColor>{`… and ${kids.length - MAX_KID_NAMES} more`}</Text>}
    </Box>
  )
}

/** An agent's network as its row shows it: its shell calls' summed (a background shell, its command's); `⇅ —` when none was measured. */
const agentNetSeg = (record: AgentRecord, data: PaneData): RowSegment => {
  const net = agentNetwork(record, data.commands)
  return seg(callsNetText(net), { color: net.measured > 0 ? toneNetTotal(net.netIn + net.netOut) : 'inactive', role: 'stat' })
}

/** An agent as a card of its own: its row and, below it while open, its details, whose calls take at most `callShare` of the list budget; a workflow's agents indented under it. */
const agentRowLine = (row: AgentRow, data: PaneData, ui: Ui, act: Actions, callShare: number, shown: ReadonlySet<string>): RenderElement => {
  const { Box } = ui
  const record = row.record
  const isOpen = data.ui.expandedAgent === record.id
  const ms = elapsedOf(record, data.now)
  const blockPct = blockPctOfRow(row, data)
  const now = doingNow(row, data)
  const subtitle = [now !== '' ? `▸ ${now}` : '', record.brief ?? ''].filter(part => part !== '').join('  ·  ')
  const segments: RowSegment[] = [
    ...(row.depth > 0 ? [seg(`${'  '.repeat(row.depth - 1)}└`, { dim: true })] : []),
    seg(agentGlyph(row.status, Math.floor(data.now / 1000)), { color: agentTone(row.status), bold: true }),
    seg(fmtClock(record.startedAt, data.now), { dim: true, role: 'stat' }),
    seg(fmtDuration(ms), { color: isLive(row.status) ? toneDuration(ms) : 'subtle', width: 7, role: 'stat' }),
    seg(oneLine(kindText(record), 20), { color: 'claude' }),
    titleSeg(record.label, isOpen),
    ...(row.agents > 0 ? [seg(`${row.agents} agent${row.agents === 1 ? '' : 's'}`, { color: 'merged', role: 'stat' })] : []),
    agentNetSeg(record, data),
    ...modelSegs(record.model, record.effort),
    ...(row.tokens > 0 ? [seg(`${fmtTokens(row.tokens)} tok`, { color: 'suggestion', role: 'stat' })] : []),
    ...(row.requests > 0 ? [seg(`${row.requests} req`, { dim: true, role: 'stat' })] : []),
    ...(row.toolCalls > 0 ? [seg(`${row.toolCalls} tool${row.toolCalls === 1 ? '' : 's'}`, { dim: true, role: 'stat' })] : []),
    ...(row.usd > 0 ? [seg(`≈ ${fmtUsd(row.usd)}`, { color: toneUsd(row.usd), role: 'stat' })] : []),
    ...(blockPct !== undefined ? [seg(`5h ${shareText(blockPct)}`, { color: tonePercentUsed(blockPct.pct * 10), role: 'stat' })] : []),
  ]
  const isParent = row.children > 0
  return (
    <Box flexDirection="column" marginLeft={row.depth * 2}>
      {agentTabCard(
        ui,
        data,
        record.id,
        row.status,
        [
          drawRow(ui, data, agentKey(record.id), { kind: 'agent', id: record.id, path: '' }, segments, () => act.toggleAgent(record.id), isOpen, subtitle),
          ...(isParent ? [kidsBlock(row, data, ui, act, shown)] : []),
          ...(isOpen ? [agentDetail(row, data, ui, act, callShare)] : []),
        ],
        isParent,
      )}
    </Box>
  )
}

/** Agents' cards one under another, a line apart as calls' are. */
const agentCards = (rows: readonly AgentRow[], data: PaneData, ui: Ui, act: Actions, callShare: number, shown: ReadonlySet<string>): RenderElement => {
  const { Box } = ui
  return (
    <Box flexDirection="column" rowGap={commandGap(data.space)}>
      {rows.map(row => agentRowLine(row, data, ui, act, callShare, shown))}
    </Box>
  )
}

/** The tab's figures: how many agents, workflows and shells, how many work now, and the tokens and cost of their requests. */
const summaryCard = (records: readonly AgentRecord[], data: PaneData, ui: Ui): RenderElement => {
  const count = (kinds: readonly AgentRecord['kind'][]): number => records.filter(one => kinds.includes(one.kind)).length
  const working = records.filter(one => isLive(effectiveStatus(one, records, data.now))).length
  const tokens = records.reduce((total, one) => total + one.tokensIn + one.tokensOut, 0)
  const usd = data.agents.reduce((total, one) => total + (one.usd ?? 0), 0)
  return card(ui, data, AGENTS_SUMMARY_KEY, [
    figureRow(ui, data, [
      figure(ui, data, 'Agents', String(count(['subagent', 'teammate', 'workflow-agent']))),
      figure(ui, data, 'Workflows', String(count(['workflow']))),
      figure(ui, data, 'Background shells', String(count(['shell']))),
      figure(ui, data, 'Working now', String(working), working > 0 ? 'warning' : 'subtle'),
      ...(tokens > 0 ? [figure(ui, data, 'Tokens sent and received', fmtTokens(tokens), 'suggestion')] : []),
      ...(usd > 0 ? [figure(ui, data, 'Cost', `≈ ${fmtUsd(usd)}`, toneUsd(usd))] : []),
    ]),
  ])
}

export const agentsTab = (data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Text, Button } = ui
  const records = [...data.agents, ...shellRecords(data.commands)]
  if (records.length === 0) {
    const none = (
      <Text dimColor>
        {data.viewed !== null ? 'That session started no agents.' : 'No agents yet. Sub-agents, workflows and background shells appear here as Claude starts them.'}
      </Text>
    )
    return data.sessions.length === 0 && data.viewed === null ? none : cardStack(ui, data, [...sessionBars(data, ui, act, 'agents'), none]) // --- session history ---
  }
  const all = layoutAgents(records, data.now)
  // A parent's children's cards are drawn once it is expanded (or one of them is open); until then it names them.
  const shown = new Set([...(data.ui.shownAgents ?? []), ...ancestorsOf(data.ui.expandedAgent, records)])
  const layout = { ...all, running: visibleRows(all.running, shown), finished: visibleRows(all.finished, shown) }
  const wanted = [...layout.running, ...layout.finished.slice(0, data.ui.listLimit)]
  // The rows the pane can draw, the open one (its card, but its calls) always; its calls get the room left.
  const weights = new Map(wanted.map(row => [row, listShareOf(agentRowLine(row, data, ui, act, 0, shown))]))
  const room = 1
  const keptRows = fitList(wanted, row => weights.get(row) ?? 0, row => row.record.id === data.ui.expandedAgent, room)
  const kept = new Set(keptRows)
  const callShare = room - keptRows.reduce((total, row) => total + (weights.get(row) ?? 0), 0)
  const running = layout.running.filter(row => kept.has(row))
  const finished = layout.finished.filter(row => kept.has(row))
  const newest = keptRows.slice(0, keptRun(keptRows, wanted)).filter(row => finished.includes(row)).length
  const more = layout.finished.length - finished.length
  return cardStack(ui, data, [
    ...sessionBars(data, ui, act, 'agents'), // --- session history ---
    summaryCard(records, data, ui),
    sectionCard(
      ui,
      data,
      AGENTS_RUNNING_KEY,
      'Running now',
      `${layout.runningRoots}`,
      layout.running.length === 0 ? [<Text dimColor>Nothing running.</Text>] : [agentCards(running, data, ui, act, callShare, shown)],
    ),
    ...(layout.finished.length > 0
      ? [
          sectionCard(ui, data, AGENTS_FINISHED_KEY, `Finished (${layout.finishedRoots})`, '', [
            agentCards(finished, data, ui, act, callShare, shown),
            ...(keptRows.length < wanted.length
              ? [<Text dimColor>{`The newest ${newest} fill the pane.`}</Text>]
              : more > 0
                ? [<Button key="agents:more" label={`Show ${Math.min(50, more)} more of ${more}`} onPress={() => act.showMore()} />]
                : []),
          ]),
        ]
      : []),
  ])
}

/** The column of agent cards in Overview's Agents. */
export const OVERVIEW_AGENT_LIST = 'ov:agents:list'

/** Overview's Agents card's key. */
export const OVERVIEW_AGENTS_CARD = 'card:ov:agents'

/** How many agents Overview lists, the working ones first. */
const OVERVIEW_AGENTS = 6

/**
 * Overview's Agents: how many work now and have finished, what they cost,
 * and the working ones (else the latest), each saying what it is doing; a
 * click opens one in the Agents tab.
 */
export const agentsSection = (data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Text, Button } = ui
  const all = [...data.agents, ...shellRecords(data.commands)]
  const statusOf = (record: AgentRecord): AgentRecord['status'] => effectiveStatus(record, all, data.now)
  const working = all.filter(record => isLive(statusOf(record)))
  const finished = all.length - working.length
  const cost = data.agents.reduce((total, record) => total + (record.usd ?? 0), 0)
  const latest = [...all].sort((a, b) => (b.endedAt ?? b.lastActivityAt) - (a.endedAt ?? a.lastActivityAt))
  const shown = (working.length > 0 ? working : latest).slice(0, OVERVIEW_AGENTS)
  const frame = Math.floor(data.now / 1000)
  return sectionCard(ui, data, OVERVIEW_AGENTS_CARD, 'Agents', 'sub-agents, workflows and background shells', [
    <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap} rowGap={data.space.row}>
      <Text color={working.length > 0 ? 'warning' : 'subtle'} bold>
        ⠿ {working.length} working
      </Text>
      <Text dimColor>
        · {finished} finished{cost > 0 ? ` · ≈ ${fmtUsd(cost)} at list prices` : ''}
      </Text>
      <Button key="agents:open" label="Open Agents" dimColor onPress={() => act.setTab('agents')} />
    </Box>,
    ...(all.length === 0
      ? [<Text dimColor>None yet. Agents Claude starts, workflows and background shell commands appear here.</Text>]
      : [
          <Box key={OVERVIEW_AGENT_LIST} flexDirection="column" rowGap={commandGap(data.space)}>
            {shown.map(record => {
              const status = statusOf(record)
              const ms = elapsedOf(record, data.now)
              const doing = isLive(status) ? phaseText(record, data.now) : (record.brief ?? '')
              const segments: RowSegment[] = [
                seg(agentGlyph(status, frame), { color: agentTone(status), bold: true }),
                seg(fmtClock(record.startedAt, data.now), { dim: true, role: 'stat' }),
                seg(fmtDuration(ms), { color: isLive(status) ? toneDuration(ms) : 'subtle', width: 7, role: 'stat' }),
                seg(oneLine(kindText(record), 20), { color: 'claude' }),
                titleSeg(record.label, false),
                agentNetSeg(record, data),
                ...modelSegs(record.model, record.effort),
                ...((record.usd ?? 0) > 0 ? [seg(`≈ ${fmtUsd(record.usd ?? 0)}`, { color: toneUsd(record.usd ?? 0), role: 'stat' })] : []),
              ]
              return agentItemCard(ui, data, record.id, status, [
                drawRow(ui, data, `ov:${keyOf(record.id)}`, { kind: 'agent', id: record.id, path: '' }, segments, () => act.toggleAgent(record.id), false, doing),
              ])
            })}
          </Box>,
        ]),
    ...(working.length === 0 && all.length > 0 ? [<Text dimColor>Nothing working now; the latest are shown.</Text>] : []),
  ])
}
