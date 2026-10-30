// Commands: every Bash command (or every tool call) with its status, access
// class, time, energy, network and memory, grouped by the prompt that made
// it, each group a card. Opened, a call's figures, flow, cost and output sit
// in a card of their own, its flow and its cost each a panel in an accent of
// its own. The Agents tab draws an agent's calls with these same rows and
// cards.

import type { RenderElement } from 'claude-code'

import type { AccessFilter, AgentRecord, CommandRecord, CommandSpend } from '../../types'
import { agentLabelOf } from '../lib/agents'
import {
  accessLetter,
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
  fmtWatts,
  keyOf,
  oneLine,
  shortModel,
  statusGlyph,
  statusTone,
  toneCpu,
  toneDuration,
  toneEnergy,
  toneMem,
  toneNetTotal,
  toneRate,
  toneUsd,
  toneWatts,
  fmtInOut,
  fmtTokens,
  fmtUsd,
  tonePercentUsed,
  type Tone,
  sanitize,
} from '../lib/format'
import { commandOutline, outlineParts, type OutlinePart } from '../lib/outline'
import { blockPctOf, estimateTokens, ownSpend, shareText } from '../lib/spend'
import { fitList, keptRun, listShareOf, shareOf } from '../lib/fit'
import { flowHint, flowSentence } from '../lib/flow'
import { callsNetText, callsNetwork, groupCommands, type CommandGroup } from '../lib/prompts'
import type { FlowLink } from '../../types'
import { ACCESSES, byAccess, elapsedMs } from '../lib/stats'
import { callCard, card, cardStack, costBreakdown, type LineRun, energySum, energyText, figure, figureRow, jumpLabel, panel, picker, rowLine, seg, TITLE_COLOR, titleSeg, type Actions, type PaneData, type Space, type Ui } from './kit'
import type { RowSegment } from './row'
import { sessionBanner, sessionPicker } from './sessions' // --- session history ---

const OUTPUT_TAIL_LINES = 80
/** However long its lines run, a closed output draws at most this much of its tail, so its card leaves room for the list. */
const OUTPUT_TAIL_CHARS = 20_000
const OUTPUT_FULL_CHARS = 30_000

/**
 * The memory cell's width in a row: room for its longest figure and share
 * (`▣ 1000 kB (10.0%)`), so the cells after it stay put while a running
 * call's figure grows.
 */
export const MEMORY_CELLS = 17

/** The Commands tab's summary card: the time spent by access class, and the filters. */
export const COMMANDS_SUMMARY_KEY = 'cmds-summary'

/** A prompt group's card: its header row, then its calls. */
export const groupCardKey = (id: string): string => `grpcard:${keyOf(id === '' ? 'none' : id)}`

/** The list of a group's calls in its card. */
export const groupCallsKey = (id: string): string => `grpcalls:${keyOf(id === '' ? 'none' : id)}`

/** An opened call's card: its figures, flow, cost and output. */
export const commandCardKey = (id: string): string => `cmdcard:${keyOf(id)}`

/** An opened call's Flow, a panel in its card. */
export const flowPanelKey = (id: string): string => `cmdflow:${keyOf(id)}`

/** An opened call's Context & cost, a panel in its card. */
export const costPanelKey = (id: string): string => `cmdcost:${keyOf(id)}`

/** Its cost broken down by the kind of token, in its Context & cost panel. */
export const costPartsKey = (id: string): string => `cmdparts:${keyOf(id)}`

/** The accent an opened call's Flow is edged, headed and pointed in, so it stands apart from the figures above it. */
export const FLOW_ACCENT: Tone = 'merged'

/** The accent of its Context & cost (an agent's too), apart from the Flow's. */
export const COST_ACCENT: Tone = 'claude'

/** The room between a list's call rows: a line more than between other rows, so each call (two or three lines) reads apart. */
export const commandGap = (space: Space): number => space.row + 1

const isLive = (record: CommandRecord): boolean => record.status === 'running' || record.status === 'background'

export const visibleCommands = (data: PaneData): CommandRecord[] => {
  const { ui } = data
  const needle = ui.filterText.trim().toLowerCase()
  return data.commands
    .filter(record => ui.commandScope === 'all' || record.tool === 'Bash')
    .filter(record => ui.accessFilter === 'all' || record.access === ui.accessFilter)
    .filter(record =>
      ui.statusFilter === 'all'
        ? true
        : ui.statusFilter === 'running'
          ? isLive(record)
          : record.status === 'error' || record.status === 'denied',
    )
    .filter(
      record =>
        needle === '' ||
        `${record.tool} ${record.title} ${record.description ?? ''} ${record.summary} ${actorText(record, data.agents).text}`.toLowerCase().includes(needle),
    )
    .reverse()
}

/** Its memory with its share of the Mac's RAM: now and at its peak while it runs, its peak once done, or why there is none. */
const memoryFigures = (record: CommandRecord, data: PaneData, ui: Ui): RenderElement[] => {
  const m = record.metrics
  if (isLive(record)) {
    return [
      figure(ui, data, 'Memory now', fmtMemory(m.mem, data.memTotal), toneMem(m.mem)),
      ...(m.peakMem > 0 ? [figure(ui, data, 'Peak memory', fmtMemory(m.peakMem, data.memTotal), toneMem(m.peakMem))] : []),
    ]
  }
  if (m.isSampled) {
    return [figure(ui, data, 'Peak memory', fmtMemory(m.peakMem, data.memTotal), toneMem(m.peakMem))]
  }
  return [record.tool === 'Bash' ? figure(ui, data, 'Peak memory', '— not measured', 'subtle') : figure(ui, data, 'Memory', 'inside Claude’s own process', 'subtle')]
}

/** The call's figures: how it ran and what it used; while it runs, what it uses now. */
const metricFigures = (record: CommandRecord, data: PaneData, ui: Ui): RenderElement[] => {
  const m = record.metrics
  const live = isLive(record)
  const isBash = record.tool === 'Bash'
  const ms = elapsedMs(record, data.now)
  return [
    figure(ui, data, 'Access', accessWord(record.access), accessTone(record.access)),
    figure(ui, data, 'Started', fmtClock(record.startedAt, data.now)),
    ...(record.endedAt !== undefined ? [figure(ui, data, 'Ended', fmtClock(record.endedAt, data.now))] : []),
    figure(ui, data, 'Time', fmtDuration(ms), toneDuration(ms)),
    ...(record.model !== undefined
      ? [figure(ui, data, 'Model', shortModel(record.model), 'claude'), figure(ui, data, 'Effort', record.effort ?? 'default', 'claude')]
      : []),
    ...(record.exitCode !== undefined ? [figure(ui, data, 'Exit', String(record.exitCode), record.exitCode === 0 ? 'success' : 'error')] : []),
    ...(isBash ? [figure(ui, data, 'CPU', `${m.isEstimate && !m.isSampled ? '≈' : ''}${fmtCpuSeconds(m.cpuS)}`, m.cpuS > 5 ? 'warning' : 'success')] : []),
    ...(live ? [figure(ui, data, 'CPU now', fmtPct(m.cpuPct), toneCpu(m.cpuPct))] : []),
    ...memoryFigures(record, data, ui),
    ...(isBash ? [figure(ui, data, 'Energy', energyText(m), toneEnergy(energySum(m)))] : []),
    ...(live ? [figure(ui, data, 'Power', fmtWatts(m.watts), toneWatts(m.watts))] : []),
    figure(
      ui,
      data,
      'Network',
      m.isSampled ? `⇅ ${fmtBytes(m.netIn + m.netOut)} · ↓ ${fmtBytes(m.netIn)} ↑ ${fmtBytes(m.netOut)}` : isBash ? '—' : 'not measured: it runs inside Claude Code',
      m.isSampled ? toneNetTotal(m.netIn + m.netOut) : 'subtle',
    ),
    ...(m.isSampled ? [figure(ui, data, 'Net time', fmtDuration(m.netActiveS * 1000), m.netActiveS > 0 ? 'suggestion' : 'subtle')] : []),
    ...(live ? [figure(ui, data, 'Network now', fmtRate(m.netInBps + m.netOutBps), toneRate(m.netInBps + m.netOutBps))] : []),
    ...(m.isSampled ? [figure(ui, data, 'Disk', `read ${fmtBytes(m.diskR)} · wrote ${fmtBytes(m.diskW)}`)] : []),
    ...(live ? [figure(ui, data, 'Processes', String(m.procs))] : []),
  ]
}

/**
 * A command's share of the tokens of the request that read it: in (of them
 * cached, read from the prompt cache) and out; all of them for a record kept
 * before they were split.
 */
export const spendTokensText = (spend: CommandSpend, withCached = true): string =>
  spend.input === undefined ? `${fmtTokens(spend.tokens)} tokens` : fmtInOut(spend.input, spend.cached ?? 0, spend.output ?? 0, withCached)

/** A call's tokens as a row shows them, in and out; none before a request has read its output. */
export const tokenSegs = (spend: CommandSpend | undefined): RowSegment[] => (spend === undefined ? [] : [seg(spendTokensText(spend, false), { color: toneUsd(spend.usd), role: 'stat' })])

/** The window a context share is taken of, when the session has not said. */
const DEFAULT_WINDOW = 200_000

/**
 * What the command took of the context and of the 5-hour limit, and what it
 * would have cost: its own tokens, and its share of the request that read
 * it. A panel of its own in the card, in its own accent.
 */
const costBlock = (record: CommandRecord, data: PaneData, ui: Ui): RenderElement => {
  const { Text } = ui
  const spend = record.spend
  const window = data.usage !== null && data.usage.contextWindow > 0 ? data.usage.contextWindow : DEFAULT_WINDOW
  const context = estimateTokens(record.title.length + record.outputChars)
  const contextPct = (context / window) * 100
  const model = record.model ?? spend?.model ?? data.usage?.model ?? ''
  const own = ownSpend(record.title.length, record.outputChars, model)
  const five = data.usage?.rateLimits.find(limit => limit.kind === 'five_hour')
  const share = spend === undefined || data.spend === null ? undefined : blockPctOf(spend, data.spend)
  const block = data.spend?.block ?? null
  const isCurrentBlock = block !== null && spend?.blockKey === block.key
  return panel(ui, data, costPanelKey(record.id), 'Context & cost', COST_ACCENT, [
    figureRow(ui, data, [
      figure(ui, data, 'Context', `≈ ${fmtTokens(context)} tokens (${contextPct > 0 && contextPct < 0.1 ? '<0.1%' : fmtPct(contextPct)} of ${fmtTokens(window)})`, tonePercentUsed(contextPct * 10)),
      ...(own !== undefined ? [figure(ui, data, 'Its own tokens', `≈ ${fmtTokens(own.input)} in · ${fmtTokens(own.output)} out · ${fmtUsd(own.usd)}`, toneUsd(own.usd))] : []),
      ...(spend !== undefined
        ? [
            figure(ui, data, 'Tokens', spendTokensText(spend), toneUsd(spend.usd)),
            figure(ui, data, 'Cost', `≈ ${fmtUsd(spend.usd)}`, toneUsd(spend.usd)),
            figure(ui, data, 'Request', `${fmtUsd(spend.requestUsd)} · ${fmtTokens(spend.requestTokens)} tokens · ${spend.shares} output${spend.shares === 1 ? '' : 's'}`, 'subtle'),
          ]
        : []),
      ...(share !== undefined ? [figure(ui, data, 'This command used', `${shareText(share)} of the 5-hour window`, tonePercentUsed(share.pct * 20))] : []),
      ...(five !== undefined ? [figure(ui, data, 'Window used', `${fmtPct(five.percentUsed)} of 100%`, tonePercentUsed(five.percentUsed))] : []),
      ...(five?.resetsAt !== undefined ? [figure(ui, data, 'Resets', fmtClock(Date.parse(five.resetsAt), data.now))] : []),
      ...(isCurrentBlock ? [figure(ui, data, 'Session in this window', `${fmtUsd(block.usd)} · ${block.requests} requests`, 'subtle')] : []),
    ]),
    ...(spend?.parts !== undefined
      ? [
          costBreakdown(
            ui,
            data,
            costPartsKey(record.id),
            spend.parts,
            `its share${spend.requestUsd > 0 ? ` (${fmtPct((spend.usd / spend.requestUsd) * 100)})` : ''} of the request that read its output`,
          ),
        ]
      : []),
    ...(spend === undefined
      ? [
          <Text dimColor>
            {record.endedAt === undefined
              ? 'Its cost is counted once it finishes and Claude reads its output.'
              : record.actor.kind === 'plugin'
                ? 'A plugin made this call, so no model request read it.'
                : 'Its cost is counted when the request that reads its output finishes.'}
          </Text>,
        ]
      : []),
  ])
}

/** One linked call in the flow: what it did, what it reused, and a button that opens it. */
const flowLine = (link: FlowLink, arrow: string, owner: string, data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Text, Button } = ui
  const other = data.commands.find(record => record.id === link.id)
  return (
    <Box flexDirection="row" columnGap={data.space.gap} alignItems="center">
      <Text color={FLOW_ACCENT} bold>
        {arrow}
      </Text>
      {other !== undefined && (
        <Text color={statusTone(other.status)} bold>
          {statusGlyph(other.status, 0)}
        </Text>
      )}
      <Text color="suggestion">{clip(link.tool.startsWith('mcp__') ? link.tool.slice(5) : link.tool, 24)}</Text>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text>
          {link.summary}
          {link.uses.length > 0 ? (
            <Text color="success"> · reused {link.uses.map(bit => `“${oneLine(bit, 40)}”`).join(', ')}</Text>
          ) : (
            <Text dimColor> · nothing from it repeated</Text>
          )}
        </Text>
      </Box>
      {other !== undefined && <Button key={`flow:${keyOf(owner)}:${keyOf(link.id)}`} label="Open" dimColor onPress={() => act.toggleCommand(link.id)} />}
    </Box>
  )
}

/** A label over the Flow's links: its words in the accent, then what they mean, dim. */
const flowLabel = (ui: Ui, words: string, meaning: string): RenderElement => {
  const { Text } = ui
  return (
    <Text>
      <Text color={FLOW_ACCENT}>{words}</Text>
      <Text dimColor> ({meaning})</Text>
    </Text>
  )
}

/**
 * Where the call sits in its loop, as a panel of its own in the card: the
 * calls that led to it, when Claude read its output and what it said, and
 * what Claude ran next.
 */
const flowBlock = (record: CommandRecord, data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Text } = ui
  const flow = record.flow
  const after = flow?.after ?? []
  const next = flow?.next ?? []
  return panel(ui, data, flowPanelKey(record.id), 'Flow', FLOW_ACCENT, [
    <Text>{flowSentence(record)}</Text>,
    ...(after.length > 0 ? [flowLabel(ui, 'Came after', 'outputs Claude had read when it made this call')] : []),
    ...after.map(link => flowLine(link, '←', record.id, data, ui, act)),
    ...(flow?.readAt !== undefined
      ? [
          <Text>
            <Text dimColor>Read at </Text>
            {fmtClock(flow.readAt, data.now)}
            {flow.said !== undefined && (
              <Text>
                <Text dimColor> · Claude then said </Text>
                <Text italic>“{flow.said}”</Text>
              </Text>
            )}
          </Text>,
        ]
      : []),
    ...(next.length > 0 ? [flowLabel(ui, 'Next', 'calls Claude made after reading this output')] : []),
    ...next.map(link => flowLine(link, '→', record.id, data, ui, act)),
  ])
}

/**
 * What of an output a card draws: its last lines (at most OUTPUT_TAIL_CHARS
 * of them however long they run), or opened in full its last
 * OUTPUT_FULL_CHARS; with how many lines and characters are left out.
 */
export const shownOutput = (output: string, isFull: boolean): { text: string; hidden: number; cut: number } => {
  const all = output.split('\n')
  const tail = isFull || all.length <= OUTPUT_TAIL_LINES ? output : all.slice(-OUTPUT_TAIL_LINES).join('\n')
  const most = isFull ? OUTPUT_FULL_CHARS : OUTPUT_TAIL_CHARS
  const text = tail.length > most ? tail.slice(-most) : tail
  return { text, hidden: isFull ? 0 : Math.max(0, all.length - OUTPUT_TAIL_LINES), cut: tail.length - text.length }
}

/** An opened call, as a card edged in its status's colour: who ran it, its figures, flow, cost and output. */
export const commandDetail = (record: CommandRecord, data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Text, Button, Code } = ui
  const isFull = data.ui.fullOutput === record.id
  const output = data.output ?? ''
  const shown = shownOutput(output, isFull)
  const actor = actorText(record, data.agents)
  return card(
    ui,
    data,
    commandCardKey(record.id),
    [
      <Text>
        <Text color={actor.tone} bold>
          {actor.text}
        </Text>
        <Text dimColor> ran it · </Text>
        <Text italic>{record.summary}</Text>
      </Text>,
      ...(record.description !== undefined && record.description !== record.summary ? [<Text italic dimColor>{record.description}</Text>] : []),
      record.tool === 'Bash' ? (
        <Code source={record.title} language="bash" />
      ) : (
        <Text>
          <Text color="claude">{record.tool}</Text> {record.title}
        </Text>
      ),
      figureRow(ui, data, metricFigures(record, data, ui)),
      flowBlock(record, data, ui, act),
      costBlock(record, data, ui),
      ...(record.agentId !== undefined ? [<Text dimColor>Run by sub-agent {record.agentId}</Text>] : []),
      <Text bold>
        Output <Text dimColor>· {record.outputLines.toLocaleString('en-US')} lines · {fmtBytes(record.outputChars)}</Text>
        {shown.hidden > 0 && <Text dimColor> · last {OUTPUT_TAIL_LINES} lines shown</Text>}
        {shown.cut > 0 &&
          (isFull ? (
            <Text dimColor> · first {shown.cut.toLocaleString('en-US')} characters not shown</Text>
          ) : (
            <Text dimColor> · its last {OUTPUT_TAIL_CHARS.toLocaleString('en-US')} characters shown</Text>
          ))}
      </Text>,
      record.status === 'running' ? (
        <Text color="warning">Still running — output appears when it finishes.</Text>
      ) : output.trim() === '' ? (
        <Text dimColor>(no output)</Text>
      ) : (
        <Code source={sanitize(shown.text)} language="text" />
      ),
      <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap} rowGap={data.space.row}>
        {(shown.hidden > 0 || shown.cut > 0 || isFull) && (
          <Button key={`full:${record.id}`} label={isFull ? 'Show less' : 'Show full output'} onPress={() => act.toggleFullOutput(record.id)} />
        )}
        <Button key={`copyout:${record.id}`} label="Copy output" onPress={press => act.copy(output, press)} />
        <Button key={`copycmd:${record.id}`} label="Copy command" onPress={press => act.copy(record.title, press)} />
        <Button key={`close:${record.id}`} label="Collapse" onPress={() => act.toggleCommand(record.id)} />
      </Box>,
    ],
    { tone: statusTone(record.status) },
  )
}

/** Who ran a call, as the row shows it, and its color; a sub-agent named from the Agents records when it has no name of its own. */
export const actorText = (record: CommandRecord, agents: readonly AgentRecord[] = []): { text: string; tone: Tone } => {
  const actor = record.actor
  if (actor.kind === 'plugin') {
    return { text: `⚙ ${actor.name}`, tone: 'permission' }
  }
  if (actor.kind === 'agent') {
    const name = actor.name !== '' ? actor.name : agentLabelOf(agents, record.agentId ?? '')
    return { text: `⤷ ${oneLine(name !== '' ? name : `sub-agent ${(record.agentId ?? '').slice(0, 6)}`.trim(), 40)}`, tone: 'merged' }
  }
  return { text: 'Claude', tone: 'claude' }
}

/**
 * What a row's second line says of the call: a shell command's outline (its
 * programs, variables and loops), which fits where the whole command does
 * not; the call's own title for other tools. The opened card shows it whole.
 */
export const callLine = (record: CommandRecord): string => {
  const outline = record.tool === 'Bash' ? commandOutline(record.title) : ''
  return outline !== '' ? outline : record.title
}

/** The colours programs are drawn in, readable on a dark and a light pane. */
export const PROGRAM_COLORS: readonly string[] = ['#58a6ff', '#3fb950', '#bc8cff', '#f0883e', '#39c5cf', '#ff7b72', '#e3b341', '#db61a2', '#79c0ff', '#56d364']

/** Programs with a colour of their own; any other takes one by its name, the same in every row. */
const KNOWN_COLORS: ReadonlyMap<string, string> = new Map([
  ['cd', '#58a6ff'],
  ['git', '#3fb950'],
  ['tail', '#bc8cff'],
  ['wc', '#f0883e'],
  ['head', '#39c5cf'],
  ['grep', '#ff7b72'],
  ['cat', '#e3b341'],
  ['ls', '#79c0ff'],
  ['echo', '#56d364'],
  ['sed', '#db61a2'],
])

/** A variable a command sets, and a loop it makes, are drawn in colours of their own. */
export const VARIABLE_COLOR = '#e3b341'
export const LOOP_COLOR = '#db61a2'

/** A program's colour: its own where it has one, else one of PROGRAM_COLORS picked by its name (the interpreter's, for `python3 x.py`). */
export const programColor = (text: string): string => {
  const name = text.split(' ')[0] ?? text
  const known = KNOWN_COLORS.get(name)
  if (known !== undefined) {
    return known
  }
  let hash = 0
  for (const char of name) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  }
  return PROGRAM_COLORS[hash % PROGRAM_COLORS.length] ?? PROGRAM_COLORS[0] ?? ''
}

/** An outline part's run: a program bold in its colour, a variable and a loop in theirs. */
const partRun = (part: OutlinePart): LineRun =>
  part.kind === 'variable'
    ? { text: part.text, color: VARIABLE_COLOR, bold: false }
    : part.kind === 'loop'
      ? { text: part.text, color: LOOP_COLOR, bold: false }
      : { text: part.text, color: programColor(part.text), bold: true }

/** A call's line as coloured runs: a shell command's outline, each part in its colour with dim dots between; another tool's title, dim. */
export const callRuns = (record: CommandRecord): LineRun[] => {
  const parts = record.tool === 'Bash' ? outlineParts(record.title) : []
  if (parts.length === 0) {
    return [{ text: oneLine(record.title, 400), color: '', bold: false }]
  }
  const runs = parts.flatMap((part, index) => [...(index > 0 ? [{ text: ' · ', color: '', bold: false }] : []), partRun(part)])
  const more = callLine(record).endsWith(' · …') ? [{ text: ' · …', color: '', bold: false }] : []
  return [...runs, ...more]
}

/** A row's second line: the call, outlined in colour, then where its output went, dim. */
export const subtitleOf = (record: CommandRecord): LineRun[] => {
  const hint = flowHint(record)
  return hint === '' ? callRuns(record) : [...callRuns(record), { text: `   ${hint}`, color: '', bold: false }]
}

/** A call's network as a row shows it: measured, else `⇅ —`. */
export const netSeg = (record: CommandRecord): RowSegment => {
  const m = record.metrics
  const net = m.netIn + m.netOut
  return seg(`⇅ ${m.isSampled ? fmtBytes(net) : '—'}`, { color: m.isSampled ? toneNetTotal(net) : 'inactive', role: 'stat' })
}

/** A call's model and effort as a row shows them; none before its request named them. */
export const modelSegs = (model: string | undefined, effort: string | undefined): RowSegment[] =>
  model !== undefined ? [seg(oneLine(`${shortModel(model)} · ${effort ?? 'default'}`, 40), { dim: true, role: 'stat' })] : []

/**
 * A call's row, and under it its card while it is open: the Commands tab
 * lists these by prompt, the Agents tab by the agent that made them.
 */
export const commandRow = (record: CommandRecord, data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box } = ui
  const isOpen = data.ui.expandedCommand === record.id
  const frame = Math.floor(data.now / 1000)
  const m = record.metrics
  const net = m.netIn + m.netOut
  const ms = elapsedMs(record, data.now)
  const actor = actorText(record, data.agents)
  const segments: RowSegment[] = [
    seg(statusGlyph(record.status, frame), { color: statusTone(record.status), bold: true }),
    seg(accessLetter(record.access), { color: accessTone(record.access), bold: true }),
    seg(fmtClock(record.startedAt, data.now), { dim: true, role: 'stat' }),
    seg(fmtDuration(ms), { color: toneDuration(ms), width: 7, role: 'stat' }),
    seg(actor.text, { color: actor.tone, bold: true }),
    ...(record.tool !== 'Bash' ? [seg(clip(record.tool.startsWith('mcp__') ? record.tool.slice(5) : record.tool, 24), { color: 'suggestion' })] : []),
    titleSeg(record.summary, isOpen, TITLE_COLOR),
    ...(record.tool === 'Bash' ? [seg(energyText(m), { color: toneEnergy(energySum(m)), role: 'stat' })] : []),
    netSeg(record),
    ...tokenSegs(record.spend),
    ...(record.tool === 'Bash'
      ? [
          seg(`▣ ${m.isSampled || m.peakMem > 0 ? fmtMemory(m.peakMem, data.memTotal) : '—'}`, {
            color: m.isSampled ? toneMem(m.peakMem) : 'inactive',
            width: MEMORY_CELLS,
            role: 'stat',
          }),
        ]
      : []),
    ...modelSegs(record.model, record.effort),
  ]
  return callCard(ui, data, record.id, record.status, [
    rowLine(ui, data, `cmd:${record.id}`, { kind: 'cmd', id: record.id, path: '' }, segments, () => act.toggleCommand(record.id), isOpen, subtitleOf(record)),
    ...(isOpen ? [commandDetail(record, data, ui, act)] : []),
  ])
}

/** The calls in scope summed by access class (how many, and the time they took), how many run and how many failed; then the filters. */
const summaryCard = (data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Input } = ui
  const scoped = data.commands.filter(record => data.ui.commandScope === 'all' || record.tool === 'Bash')
  const classes = byAccess(scoped, data.now)
  const live = scoped.filter(isLive).length
  const failed = scoped.filter(record => record.status === 'error').length
  const accessOptions: { value: AccessFilter; label: string }[] = [
    { value: 'all', label: 'Any' },
    { value: 'read', label: 'Read' },
    { value: 'write', label: 'Write' },
    { value: 'execute', label: 'Execute' },
  ]
  return card(ui, data, COMMANDS_SUMMARY_KEY, [
    figureRow(ui, data, [
      ...ACCESSES.map(access => figure(ui, data, accessWord(access), `${classes[access].count} · ${fmtDuration(classes[access].totalMs)}`, accessTone(access))),
      figure(ui, data, 'Live', String(live), live > 0 ? 'warning' : 'subtle'),
      figure(ui, data, 'Failed', String(failed), failed > 0 ? 'error' : 'subtle'),
    ]),
    <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap} rowGap={data.space.row}>
      {sessionPicker(data, ui, act, 'commands') /* --- session history --- */}
      {picker(ui, 'scope', 'Show', data.ui.commandScope, [
        { value: 'bash', label: 'Bash commands' },
        { value: 'all', label: 'All tool calls' },
      ], value => act.setScope(value))}
      {picker(ui, 'access', 'Access', data.ui.accessFilter, accessOptions, value => act.setAccessFilter(value))}
      {picker(ui, 'status', 'Status', data.ui.statusFilter, [
        { value: 'all', label: 'Any' },
        { value: 'running', label: 'Running' },
        { value: 'failed', label: 'Failed / denied' },
      ], value => act.setStatusFilter(value))}
      {Input !== undefined && (
        <Input
          key="filter"
          label="Filter"
          placeholder="text in the command"
          value={data.ui.filterText}
          submitLabel="filter"
          onInput={value => act.setFilterText(value)}
          onSubmit={value => act.setFilterText(value)}
        />
      )}
    </Box>,
  ])
}

const isGroupOpen = (group: CommandGroup, data: PaneData): boolean => !data.ui.collapsedGroups.includes(group.id)

/** A prompt group's header row: when, the prompt's title, its calls, how many run and failed, how long and what they cost; a click closes or opens it. */
const groupHeader = (group: CommandGroup, data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const running = group.records.filter(isLive).length
  const failed = group.records.filter(record => record.status === 'error' || record.status === 'denied').length
  const usd = group.records.reduce((total, record) => total + (record.spend?.usd ?? 0), 0)
  const firstAt = Math.min(...group.records.map(record => record.startedAt))
  const lastAt = Math.max(...group.records.map(record => record.endedAt ?? data.now))
  const count = group.records.length
  const net = callsNetwork(group.records)
  const segments: RowSegment[] = [
    seg(fmtClock(group.at, data.now), { dim: true, role: 'stat' }),
    seg(group.title, { color: 'claude', bold: true, grow: true, role: 'title' }),
    seg(`${count} call${count === 1 ? '' : 's'}`, { color: 'suggestion', role: 'stat' }),
    ...(running > 0 ? [seg(`${running} running`, { color: 'warning', role: 'stat' })] : []),
    ...(failed > 0 ? [seg(`✗ ${failed}`, { color: 'error', role: 'stat' })] : []),
    seg(fmtDuration(Math.max(0, lastAt - firstAt)), { dim: true, role: 'stat' }),
    seg(callsNetText(net), { color: net.measured > 0 ? toneNetTotal(net.netIn + net.netOut) : 'inactive', role: 'stat' }),
    ...(usd > 0 ? [seg(`≈ ${fmtUsd(usd)}`, { color: toneUsd(usd), role: 'stat' })] : []),
  ]
  const prompt = group.prompt
  return rowLine(
    ui,
    data,
    `grp:${keyOf(group.id === '' ? 'none' : group.id)}`,
    { kind: 'group', id: group.id, path: '' },
    segments,
    () => act.toggleGroup(group.id),
    isGroupOpen(group, data),
    prompt !== undefined ? `“${oneLine(prompt.text, 220)}”` : '',
  )
}

/** One prompt's calls as a card: its header row, its jump while open, then the rows that fit, a line apart; edged as running while any runs. */
const groupCard = (group: CommandGroup, header: RenderElement, rows: readonly RenderElement[], data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Button } = ui
  const prompt = group.prompt
  return card(
    ui,
    data,
    groupCardKey(group.id),
    [
      header,
      ...(isGroupOpen(group, data) && prompt !== undefined
        ? [
            <Box flexDirection="row" columnGap={data.space.gap}>
              <Button key={`gojump:${keyOf(prompt.id)}`} label={jumpLabel(data.surface)} dimColor onPress={press => act.jumpToPrompt(prompt.id, press)} />
            </Box>,
          ]
        : []),
      ...(rows.length > 0
        ? [
            <Box key={groupCallsKey(group.id)} flexDirection="column" rowGap={commandGap(data.space)}>
              {rows}
            </Box>,
          ]
        : []),
    ],
    { tone: group.records.some(isLive) ? 'warning' : undefined },
  )
}

/** One line of the list as drawn: a group's header (no record), or one of its calls. */
type ListItem = { group: CommandGroup; record?: CommandRecord; element: RenderElement }

/** About what a group's card adds to its header row: the card itself and its jump. */
const GROUP_SHARE = shareOf({ nodes: 12, depth: 0, chars: 600 })

/** How many more calls Show more asks for (register.tsx `showMore`). */
export const MORE_STEP = 50

/** A list of calls as the pane draws it: grouped by prompt, the headers and open groups' rows, fitted. */
type FittedCalls = { groups: CommandGroup[]; items: ListItem[]; kept: ListItem[] }

/** The headers and open groups' rows of these calls, newest first, as many as the pane can draw: the open call, and its group, always. */
const fitCalls = (wanted: readonly CommandRecord[], data: PaneData, ui: Ui, act: Actions): FittedCalls => {
  const groups = groupCommands(wanted, data.prompts, data.tasks)
  const items: ListItem[] = groups.flatMap(group => [
    { group, element: groupHeader(group, data, ui, act) },
    ...(isGroupOpen(group, data) ? group.records.map(record => ({ group, record, element: commandRow(record, data, ui, act) })) : []),
  ])
  const open = data.ui.expandedCommand
  const openGroup = groups.find(group => group.records.some(record => record.id === open))
  const kept = fitList(
    items,
    item => listShareOf(item.element) + (item.record === undefined ? GROUP_SHARE : 0),
    item => (item.record === undefined ? item.group === openGroup : item.record.id === open),
    1,
  )
  return { groups, items, kept }
}

/** How many calls a fitted list shows: an open group's drawn rows, and a closed one's under its header. */
const shownCalls = (kept: readonly ListItem[], data: PaneData): number =>
  kept.reduce((total, item) => total + (item.record !== undefined ? 1 : isGroupOpen(item.group, data) ? 0 : item.group.records.length), 0)

/**
 * How the list ends: a note that the pane is full (it cut the list, or the
 * calls it hides would add none once fitted), Show more with what it adds,
 * or nothing when it hides none.
 */
export const listEnd = (isCut: boolean, hidden: number, more: number): 'full' | 'more' | 'none' => (isCut || (hidden > 0 && more <= 0) ? 'full' : hidden > 0 ? 'more' : 'none')

export const commandsTab = (data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Text, Button } = ui
  const rows = visibleCommands(data)
  const wanted = rows.slice(0, data.ui.listLimit)
  const { groups, items, kept } = fitCalls(wanted, data, ui, act)
  const isCut = kept.length < items.length
  // What Show more would add once the pane has fitted it, so its label promises no more than that.
  const more = isCut || rows.length <= wanted.length ? 0 : shownCalls(fitCalls(rows.slice(0, data.ui.listLimit + MORE_STEP), data, ui, act).kept, data) - shownCalls(kept, data)
  const end = listEnd(isCut, rows.length - wanted.length, more)
  const cards = groups.flatMap(group => {
    const header = kept.find(item => item.group === group && item.record === undefined)
    const calls = kept.filter(item => item.group === group && item.record !== undefined).map(item => item.element)
    return header === undefined ? [] : [groupCard(group, header.element, calls, data, ui, act)]
  })
  return cardStack(ui, data, [
    ...sessionBanner(data, ui, act, 'commands'), // --- session history ---
    summaryCard(data, ui, act),
    ...(wanted.length === 0
      ? [<Text dimColor>{data.commands.length === 0 ? 'No commands yet. They appear here live as Claude runs them.' : 'Nothing matches.'}</Text>]
      : cards),
    ...(end === 'full'
      ? [<Text dimColor>{`The newest ${isCut ? kept.slice(0, keptRun(kept, items)).filter(item => item.record !== undefined).length : shownCalls(kept, data)} calls fill the pane; the filters above find older ones.`}</Text>]
      : end === 'more'
        ? [<Button key="more" label={`Show ${more} more of ${rows.length - wanted.length}`} onPress={() => act.showMore()} />]
        : []),
  ])
}
