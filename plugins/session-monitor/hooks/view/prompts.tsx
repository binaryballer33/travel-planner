// Prompts: every prompt you sent in this session as a card, newest first: its
// title and words, when it was sent and ended, how long it took, what its
// work came to (calls, tokens, price, context, the 5-hour and weekly windows,
// energy, files), and a button that brings its message into view in the
// conversation. Below, the prompts of earlier sessions in this project.
// Overview's latest prompts open their card here: a click on a title scrolls
// the tab to it and edges it in the accent until the next click.
//
// A long session has hundreds of prompts, and the desktop app draws nothing
// new of a tree that large (lib/fit.ts): the tab lists them a page at a time,
// the newest first, Older and Newer moving a page, each page held to the
// list budget (the card open or marked always on it). The earlier sessions'
// prompts are paged the same way, in a share of their own.
//
// The jump is a Button on purpose: the engine scrolls its transcript only for
// a press of the person's own (a click on a drawn region is that region's
// code), and only the terminal's fullscreen transcript at all. In the desktop
// app the button copies the prompt's opening for the app's Find (⌘F).

import type { RenderElement } from 'claude-code'

import type { PromptRecord, StoredPrompt, WindowUse } from '../../types'
import { fmtBytes, fmtClock, fmtCpuSeconds, fmtDuration, fmtEnergy, fmtInOut, fmtUsd, keyOf, oneLine, shortModel, toneDuration, toneEnergy, toneNetTotal, toneUsd, type Tone } from '../lib/format'
import { callsNetText, contextText, isFolded, promptAgents, promptFacts, runTokens, windowLead, windowPoints, windowText, type PromptFacts } from '../lib/prompts'
import { sessionBars } from './sessions' // --- session history ---
import { commandGap, commandRow } from './commands'
import { shareText, windowShare } from '../lib/spend'
import { fitList, keptRun, listShareOf } from '../lib/fit'
import { newerFromOf, pageOf, pager } from './paging'
import { CARD_BACKGROUND, costBreakdown, figure, findAccessCard, jumpLabel, section, sectionCard, TITLE_COLOR, type Actions, type PaneData, type Ui } from './kit'

/** How many of this session's prompts a page lists; Older and Newer move a page. */
export const PROMPTS_PAGE = 10
/** How many prompts of the project's other sessions a page lists. */
export const EARLIER_PAGE = 5
/** The most of the list budget the earlier sessions' page takes: this session's prompts have the rest. */
export const EARLIER_SHARE = 0.25
/** The most of the list budget an expanded card's own calls take: the newest of them that fit. */
export const PROMPT_CALLS_SHARE = 0.35
/** The keys of the paging buttons: this session's prompts, then the earlier sessions'. */
export const PROMPTS_NEWER_KEY = 'prompts:newer'
export const PROMPTS_OLDER_KEY = 'prompts:older'
export const EARLIER_NEWER_KEY = 'earlier:newer'
export const EARLIER_OLDER_KEY = 'earlier:older'
/** How much of a prompt a closed card shows. */
export const EXCERPT_CHARS = 280
/** The most of a prompt an open card shows; Copy prompt copies all of it. */
export const OPEN_TEXT_CHARS = 20_000

/** Prompts as the tab lists them: the newest first. */
export const newestFirst = <T extends { at: number }>(prompts: readonly T[]): T[] => [...prompts].sort((a, b) => b.at - a.at)

/** Where the page starts that shows the prompt at `index` of newestFirst: the first page for one of the newest, else at it. */
export const pageFromOf = (index: number): number => (index < PROMPTS_PAGE ? 0 : index)

/** A Prompts card's key: short and control-free whatever the id. */
export const promptKey = (id: string): string => `prm:${keyOf(id)}`

/** The key of the card a page starts with, `from` into `prompts` newest first: where Older and Newer scroll the pane. */
export const pageStartKey = (prompts: readonly { id: string; at: number }[], from: number): string | undefined => {
  const first = newestFirst(prompts)[from]
  return first === undefined ? undefined : promptKey(first.id)
}

const ORIGIN_WORDS: Readonly<Record<string, string>> = { composer: 'typed', bridge: 'phone or web', sdk: 'the app' }

/** How a prompt stands: working, done, interrupted, ended by an error or refused, or waiting for its turn. */
export const statusOf = (prompt: PromptRecord, facts: PromptFacts): { text: string; tone: Tone } => {
  if (facts.isRunning) {
    return { text: '● Running', tone: 'warning' }
  }
  const reason = prompt.run?.endReason
  if (reason === 'aborted') {
    return { text: '■ Interrupted', tone: 'warning' }
  }
  if (reason === 'error') {
    return { text: '✗ Ended by an error', tone: 'error' }
  }
  if (reason === 'refusal') {
    return { text: '⊘ Refused', tone: 'error' }
  }
  if (prompt.taskId === undefined) {
    return { text: '○ Queued', tone: 'subtle' }
  }
  return { text: '✓ Done', tone: 'success' }
}

/** The prompt's words: a closed card's excerpt, folded onto few lines, or all of them. */
const excerptOf = (text: string, isOpen: boolean): string => {
  if (isOpen) {
    return text.length > OPEN_TEXT_CHARS ? `${text.slice(0, OPEN_TEXT_CHARS)}… (${text.length - OPEN_TEXT_CHARS} more characters; Copy prompt copies them all)` : text
  }
  const folded = text.replace(/\s+/g, ' ').trim()
  return folded.length > EXCERPT_CHARS ? `${folded.slice(0, EXCERPT_CHARS - 1)}…` : folded
}

/**
 * A prompt's title: bold, in the blue a command's title is drawn in, on every
 * surface. Not a markdown heading: one draws larger on the desktop but takes
 * no colour, and only a link draws blue there, a link with nowhere to lead.
 */
const promptTitle = (ui: Ui, title: string): RenderElement => {
  const { Text } = ui
  return (
    <Text bold color={TITLE_COLOR}>
      {oneLine(title, 200)}
    </Text>
  )
}

/** What a card calls each rate-limit window it shows. */
const WINDOW_NAMES: Readonly<Record<string, string>> = { five_hour: '5-hour window', seven_day: 'Weekly window' }

/** For a run that rose less than a step of the 5-hour window, its cost at the rate the session learned: `≈ 0.042%`. */
const estimateOf = (use: WindowUse, usd: number, data: PaneData): string | undefined => {
  if (use.kind !== 'five_hour' || data.spend === null) {
    return undefined
  }
  const share = windowShare(usd, use.resetsAt, data.spend)
  return share === undefined ? undefined : shareText(share)
}

/** A run's rise in a window, toned once it is several points. */
const toneWindow = (use: WindowUse): Tone | undefined => {
  const points = windowPoints(use)
  return points >= 10 ? 'error' : points >= 3 ? 'warning' : undefined
}

/** The prompt's price: its run's requests, else (kept before runs were) its calls' shares. */
const usdOf = (prompt: PromptRecord, facts: PromptFacts): number => (prompt.run !== undefined && prompt.run.usd > 0 ? prompt.run.usd : facts.callUsd)

/** Where it came from, and, typed while a turn ran, that the turn took it in. */
const fromText = (prompt: PromptRecord): string => `${ORIGIN_WORDS[prompt.origin] ?? prompt.origin}${isFolded(prompt) ? ' · into a running turn' : ''}`

/** The card's figures: times first, then what the work came to. */
const figures = (prompt: PromptRecord, facts: PromptFacts, data: PaneData, ui: Ui): RenderElement[] => {
  const run = prompt.run
  const usd = usdOf(prompt, facts)
  const tokens = runTokens(run)
  const use = facts.use
  const context = contextText(run)
  const shown: RenderElement[] = [
    figure(ui, data, 'Sent', fmtClock(prompt.at, data.now)),
    figure(ui, data, 'Ended', facts.isRunning ? 'still running' : facts.endedAt !== undefined ? fmtClock(facts.endedAt, data.now) : '—', facts.isRunning ? 'warning' : undefined),
    figure(ui, data, 'Duration', facts.durationMs !== undefined ? fmtDuration(facts.durationMs) : '—', facts.durationMs !== undefined ? toneDuration(facts.durationMs) : undefined),
  ]
  if (run !== undefined && run.workMs > 0) {
    shown.push(figure(ui, data, 'Claude worked', `${fmtDuration(run.workMs)}${run.turns > 1 ? ` · ${run.turns} turns` : ''}`))
  }
  shown.push(
    figure(
      ui,
      data,
      'Network of its calls',
      facts.net.measured > 0 ? `${callsNetText(facts.net)} · ↓ ${fmtBytes(facts.net.netIn)} ↑ ${fmtBytes(facts.net.netOut)}` : facts.calls === 0 ? 'no calls' : '— (none of its calls was a shell command)',
      facts.net.measured > 0 ? toneNetTotal(facts.net.netIn + facts.net.netOut) : 'subtle',
    ),
    figure(ui, data, 'Tool calls', facts.calls === 0 ? 'none' : `${facts.calls}${facts.failed > 0 ? ` · ✗ ${facts.failed}` : ''}${facts.running > 0 ? ` · ${facts.running} running` : ''}`, facts.failed > 0 ? 'error' : 'suggestion'),
  )
  if (usd > 0) {
    shown.push(figure(ui, data, run !== undefined && run.usd > 0 ? 'Cost' : 'Cost of its calls', `≈ ${fmtUsd(usd)}`, toneUsd(usd)))
  }
  if (tokens !== undefined && run !== undefined) {
    shown.push(figure(ui, data, 'Tokens', fmtInOut(tokens.input, tokens.cached, tokens.output)), figure(ui, data, 'Requests', String(run.requests)))
  }
  if (context !== undefined) {
    shown.push(figure(ui, data, 'Context', context))
  }
  for (const one of run?.windows ?? []) {
    const name = WINDOW_NAMES[one.kind]
    if (name !== undefined) {
      shown.push(figure(ui, data, name, windowText(one, usd, estimateOf(one, usd, data)), toneWindow(one)))
    }
  }
  if (run?.model !== undefined) {
    shown.push(figure(ui, data, 'Model', shortModel(run.model), 'claude'))
  }
  if (use !== undefined) {
    shown.push(
      figure(ui, data, 'Energy', fmtEnergy(use.energyJ).replace(/ \(.*\)$/, ''), toneEnergy(use.energyJ)),
      figure(ui, data, 'CPU time', fmtCpuSeconds(use.cpuS)),
      figure(ui, data, 'Network, whole session', `↓ ${fmtBytes(use.netIn)} ↑ ${fmtBytes(use.netOut)}`),
    )
  }
  if (facts.files > 0) {
    shown.push(figure(ui, data, 'Files changed', String(facts.files), 'warning'))
  }
  shown.push(figure(ui, data, 'From', fromText(prompt)))
  return shown
}

/** An expanded prompt card's cost broken down by the kind of token. */
export const promptPartsKey = (id: string): string => `pparts:${keyOf(id)}`

/** A prompt card's Agents section: how many agents it used, and their names one under another. */
export const promptAgentsKey = (id: string): string => `pagents:${keyOf(id)}`

/** How many of its agents' names a prompt card lists; the Agents tab has them all. */
const MAX_AGENT_NAMES = 25

/**
 * The agents the prompt used: how many, then each one's name on a line of
 * its own (a workflow's under the workflow, with its kind beside it); none
 * when it used none.
 */
const agentsSection = (prompt: PromptRecord, data: PaneData, ui: Ui): RenderElement[] => {
  const { Box, Text } = ui
  const used = promptAgents(prompt, data.agents, data.commands)
  if (used.total === 0 && used.lines.length === 0) {
    return []
  }
  const workflows = used.lines.filter(line => line.kind === 'workflow').length
  const shown = used.lines.slice(0, MAX_AGENT_NAMES)
  return [
    <Box key={promptAgentsKey(prompt.id)} flexDirection="column">
      <Text>
        <Text bold>Agents </Text>
        <Text color="merged" bold>
          {used.total}
        </Text>
        {workflows > 0 && <Text dimColor>{` · ${workflows} workflow${workflows === 1 ? '' : 's'}`}</Text>}
      </Text>
      {shown.map(line => (
        <Box flexDirection="row" columnGap={data.space.gap} marginLeft={line.depth * 2}>
          <Text color={line.kind === 'workflow' ? 'merged' : 'subtle'}>{line.kind === 'workflow' ? '⎇' : '·'}</Text>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text bold={line.kind === 'workflow'}>{oneLine(line.label, 120)}</Text>
          </Box>
          <Text dimColor>{line.kind === 'workflow' ? `workflow${line.agents !== undefined ? ` · ${line.agents} agent${line.agents === 1 ? '' : 's'}` : ''}` : oneLine(line.kind, 24)}</Text>
        </Box>
      ))}
      {used.lines.length > shown.length && <Text dimColor>{`… and ${used.lines.length - shown.length} more; the Agents tab lists them all`}</Text>}
    </Box>,
  ]
}

/** One prompt of this session as a card. */
const promptCard = (prompt: PromptRecord, number: number, data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Text, Button } = ui
  const key = keyOf(prompt.id)
  const isOpen = data.ui.openPrompt === prompt.id
  const facts = promptFacts(prompt, data.commands, data.now, data.agents)
  const status = statusOf(prompt, facts)
  const taskId = prompt.taskId
  const isTerminal = data.surface === 'terminal'
  // Opened from Overview: edged in the accent until the next click.
  const isMarked = data.ui.markedPrompt === prompt.id
  return (
    <Box
      key={promptKey(prompt.id)}
      flexDirection="column"
      borderStyle="round"
      borderColor={isMarked ? 'claude' : facts.isRunning ? 'warning' : 'subtle'}
      backgroundColor={isTerminal ? undefined : CARD_BACKGROUND}
      paddingX={isTerminal ? 1 : 3}
      paddingY={isTerminal ? 0 : 1}
      rowGap={1}
    >
      <Box flexDirection="row" columnGap={data.space.gap} alignItems="center">
        <Text dimColor bold>
          #{number}
        </Text>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          {promptTitle(ui, prompt.summary)}
        </Box>
        <Text color={status.tone} bold>
          {status.text}
        </Text>
      </Box>
      <Text dimColor italic>
        “{excerptOf(prompt.text, isOpen)}”
      </Text>
      <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap} rowGap={1}>
        {figures(prompt, facts, data, ui)}
      </Box>
      {isOpen && prompt.run?.parts !== undefined && costBreakdown(ui, data, promptPartsKey(prompt.id), prompt.run.parts, `its ${prompt.run.requests} request${prompt.run.requests === 1 ? '' : 's'}, sub-agents’ included`)}
      {agentsSection(prompt, data, ui)}
      {facts.tools.length > 0 && (
        <Text>
          <Text dimColor>Tools </Text>
          {facts.tools.slice(0, 8).map((one, index) => (
            <Text>
              {index > 0 && <Text dimColor> · </Text>}
              <Text color="suggestion">{one.tool}</Text>
              <Text dimColor> ×{one.count}</Text>
            </Text>
          ))}
          {facts.tools.length > 8 && <Text dimColor> · and {facts.tools.length - 8} more</Text>}
        </Text>
      )}
      <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap - 1} rowGap={data.space.row}>
        <Button key={`pjump:${key}`} label={jumpLabel(data.surface)} variant="primary" onPress={press => act.jumpToPrompt(prompt.id, press)} />
        {taskId !== undefined && facts.calls > 0 && <Button key={`pcmds:${key}`} label="Show its commands" onPress={() => act.showPromptCommands(taskId)} />}
        <Button key={`pcopy:${key}`} label="Copy prompt" onPress={press => act.copy(prompt.text, press)} />
        {ui.TitleLink !== undefined ? (
          // A region where the surface draws one, so a click reaches it across the tab's redraws.
          ui.TitleLink(`pfull:${key}`, { press: { kind: 'expand', id: prompt.id }, text: isOpen ? '▾ Collapse' : '▸ Expand', color: 'subtle', bold: false })
        ) : (
          <Button key={`pfull:${key}`} label={isOpen ? 'Collapse' : 'Expand'} dimColor onPress={() => act.toggleOpenPrompt(prompt.id)} />
        )}
      </Box>
      {isOpen && taskId !== undefined && promptCalls(taskId, data, ui, act)}
    </Box>
  )
}

/** How many of its calls an expanded prompt lists: the newest; the rest are a click away in Commands. */
export const PROMPT_CALLS_SHOWN = 40

/** An expanded prompt's calls block's key. */
export const promptCallsKey = (id: string): string => `pcalls:${keyOf(id)}`

/** An expanded prompt's own calls, the newest first, each a card that opens in place as in Commands: as many as fit. */
const promptCalls = (taskId: string, data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Text } = ui
  const calls = data.commands.filter(call => call.promptId === taskId).sort((a, b) => b.startedAt - a.startedAt)
  const rows = calls.slice(0, PROMPT_CALLS_SHOWN).map(call => ({ call, element: commandRow(call, data, ui, act) }))
  const shown = fitList(rows, row => listShareOf(row.element), row => row.call.id === data.ui.expandedCommand, PROMPT_CALLS_SHARE)
  return (
    <Box key={promptCallsKey(taskId)} flexDirection="column" rowGap={commandGap(data.space)}>
      <Text bold>
        Its calls <Text dimColor>· {calls.length === 0 ? 'none' : `${calls.length}, the newest first`}</Text>
      </Text>
      {shown.map(row => row.element)}
      {calls.length > shown.length && <Text dimColor>{`The newest ${keptRun(shown, rows)} are shown; Show its commands lists them all.`}</Text>}
    </Box>
  )
}

/** A prompt of another session: its words and when, to copy; its conversation is not this one, so no jump. */
const earlierCard = (prompt: StoredPrompt, data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Text, Button } = ui
  const key = keyOf(prompt.id)
  const isOpen = data.ui.openPrompt === prompt.id
  const isTerminal = data.surface === 'terminal'
  const isLong = prompt.text.replace(/\s+/g, ' ').trim().length > EXCERPT_CHARS || prompt.text.trim().includes('\n')
  return (
    <Box
      key={promptKey(prompt.id)}
      flexDirection="column"
      borderStyle="round"
      borderColor="subtle"
      borderDimColor
      paddingX={isTerminal ? 1 : 3}
      paddingY={isTerminal ? 0 : 1}
      rowGap={isTerminal ? 0 : 1}
    >
      <Box flexDirection="row" columnGap={data.space.gap} alignItems="center">
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          {promptTitle(ui, prompt.summary)}
        </Box>
        <Text dimColor>
          {fmtClock(prompt.at, data.now)} · session {prompt.sessionId.slice(0, 8)}
        </Text>
      </Box>
      <Text dimColor italic>
        “{excerptOf(prompt.text, isOpen)}”
      </Text>
      <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap - 1} rowGap={data.space.row}>
        <Button key={`pcopy:${key}`} label="Copy prompt" dimColor onPress={press => act.copy(prompt.text, press)} />
        {isLong && <Button key={`pfull:${key}`} label={isOpen ? 'Show less' : 'Show full prompt'} dimColor onPress={() => act.toggleOpenPrompt(prompt.id)} />}
      </Box>
    </Box>
  )
}

/** The session's prompts summed: how many, the time and price their work came to, and their calls. */
const totalsRow = (mine: readonly PromptRecord[], data: PaneData, ui: Ui): RenderElement => {
  const { Box } = ui
  const facts = mine.map(prompt => ({ prompt, facts: promptFacts(prompt, data.commands, data.now, data.agents) }))
  const workMs = facts.reduce((total, one) => total + (one.prompt.run?.workMs ?? 0), 0)
  const usd = facts.reduce((total, one) => total + usdOf(one.prompt, one.facts), 0)
  const calls = facts.reduce((total, one) => total + one.facts.calls, 0)
  const energy = facts.reduce((total, one) => total + (one.facts.use?.energyJ ?? 0), 0)
  const runs = mine.flatMap(prompt => {
    const tokens = runTokens(prompt.run)
    return tokens === undefined ? [] : [tokens]
  })
  const tokens = runs.reduce((total, one) => ({ input: total.input + one.input, cached: total.cached + one.cached, output: total.output + one.output }), { input: 0, cached: 0, output: 0 })
  const running = facts.filter(one => one.facts.isRunning).length
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap + 2} rowGap={data.space.row}>
      {figure(ui, data, 'Prompts', `${mine.length}${running > 0 ? ` · ${running} running` : ''}`, running > 0 ? 'warning' : 'claude')}
      {workMs > 0 && figure(ui, data, 'Claude worked', fmtDuration(workMs))}
      {figure(ui, data, 'Tool calls', String(calls), 'suggestion')}
      {usd > 0 && figure(ui, data, 'Cost', `≈ ${fmtUsd(usd)}`, toneUsd(usd))}
      {runs.length > 0 && figure(ui, data, 'Tokens', fmtInOut(tokens.input, tokens.cached, tokens.output))}
      {energy > 0 && figure(ui, data, 'Energy', fmtEnergy(energy).replace(/ \(.*\)$/, ''), toneEnergy(energy))}
    </Box>
  )
}

/** A card the tab draws whatever else it leaves out: the one open, or the one a click on Overview marked. */
const isPinned = (id: string, data: PaneData): boolean => id === data.ui.openPrompt || id === data.ui.markedPrompt

export const promptsTab = (data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Text } = ui
  const mine = newestFirst(data.prompts)
  const ids = new Set(mine.map(one => one.id))
  const earlier = newestFirst(data.projectPrompts.filter(one => one.sessionId !== data.sessionId && !ids.has(one.id)))
  const cardGap = data.surface === 'terminal' ? 1 : 2
  const hasWindows = mine.some(one => (one.run?.windows ?? []).length > 0)
  // The earlier sessions' page in its own share, so this session's never crowds it out; this session's page in the rest.
  const pinned = (id: string): boolean => isPinned(id, data)
  const drawEarlier = (prompt: StoredPrompt): RenderElement => earlierCard(prompt, data, ui, act)
  const older = pageOf(earlier, data.ui.earlierFrom ?? 0, EARLIER_PAGE, drawEarlier, pinned, EARLIER_SHARE)
  const olderShare = older.cards.reduce((total, card) => total + card.share, 0)
  const drawMine = (prompt: PromptRecord, index: number): RenderElement => promptCard(prompt, mine.length - index, data, ui, act)
  const own = pageOf(mine, data.ui.promptsFrom ?? 0, PROMPTS_PAGE, drawMine, pinned, 1 - olderShare)
  return (
    <Box flexDirection="column" gap={data.space.section}>
      {findAccessCard(data, ui, act)}
      {mine.length > 0 && totalsRow(mine, data, ui)}
      {sessionBars(data, ui, act, 'prompts') /* --- session history --- */}
      {section(
        ui,
        'This session',
        mine.length === 0 ? '' : `${mine.length} prompt${mine.length === 1 ? '' : 's'}, the newest first · ${jumpLabel(data.surface)} brings one into view`,
        mine.length === 0
          ? [<Text dimColor>No prompts yet. Each one you send appears here as a card, titled in a few words.</Text>]
          : [
              ...(hasWindows
                ? [
                    <Text dimColor>
                      Context: the size of a prompt's own latest request, and how much it grew. 5-hour and weekly window: how far each rose while
                      it ran; other sessions running then move them too.
                    </Text>,
                  ]
                : []),
              <Box flexDirection="column" rowGap={cardGap} marginTop={data.space.row}>
                {own.cards.map(card => card.element)}
              </Box>,
              ...pager(mine.length, own, newerFromOf(mine, own, PROMPTS_PAGE, drawMine, pinned, 1 - olderShare), { newer: PROMPTS_NEWER_KEY, older: PROMPTS_OLDER_KEY }, true, from => act.pagePrompts(from), data, ui),
            ],
      )}
      {section(
        ui,
        'Earlier in this project',
        earlier.length === 0 ? '' : `${earlier.length} from other sessions, the newest first`,
        earlier.length === 0
          ? [<Text dimColor>None yet: prompts from this project's other sessions appear here once those sessions run with the monitor.</Text>]
          : [
              <Box flexDirection="column" rowGap={cardGap} marginTop={data.space.row}>
                {older.cards.map(card => card.element)}
              </Box>,
              ...pager(earlier.length, older, newerFromOf(earlier, older, EARLIER_PAGE, drawEarlier, pinned, EARLIER_SHARE), { newer: EARLIER_NEWER_KEY, older: EARLIER_OLDER_KEY }, false, from => act.pageEarlier(from), data, ui),
            ],
      )}
    </Box>
  )
}

/** Overview's Prompts card's key. */
export const OVERVIEW_PROMPTS_CARD = 'card:ov:prompts'

/** How many of the latest prompts Overview shows. */
export const OVERVIEW_PROMPTS = 2

/** An Overview prompt card's key. */
export const overviewPromptKey = (id: string): string => `ovp:${keyOf(id)}`

/** The key of an Overview prompt card's title, which opens the prompt's card on the Prompts tab. */
export const overviewTitleKey = (id: string): string => `ovt:${keyOf(id)}`

/** Whether a key is an Overview prompt card's title. */
export const isOverviewTitleKey = (key: string): boolean => key.startsWith('ovt:')

/**
 * An Overview prompt card's title, in the blue a command's title is drawn in;
 * a click on it opens the prompt's card on the Prompts tab. One clickable
 * region where the surface draws a `Client` (terminal, desktop), underlined
 * under the pointer; elsewhere a plain button.
 */
const overviewTitle = (prompt: PromptRecord, ui: Ui, act: Actions): RenderElement => {
  const { Button } = ui
  const key = overviewTitleKey(prompt.id)
  const text = oneLine(prompt.summary, 200)
  if (ui.TitleLink !== undefined) {
    return ui.TitleLink(key, { press: { kind: 'prompt', id: prompt.id }, text, color: TITLE_COLOR, bold: true })
  }
  return <Button key={key} label={text} plain onPress={() => act.revealPrompt(prompt.id)} />
}

/** Overview's Prompts: your latest prompts as small cards, each with its jump; a title opens its card on the Prompts tab. */
export const latestPromptsSection = (data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Text, Button } = ui
  const latest = [...data.prompts].sort((a, b) => b.at - a.at).slice(0, OVERVIEW_PROMPTS)
  const isTerminal = data.surface === 'terminal'
  const cards = latest.map(prompt => {
    const facts = promptFacts(prompt, data.commands, data.now, data.agents)
    const status = statusOf(prompt, facts)
    const usd = usdOf(prompt, facts)
    const tokens = runTokens(prompt.run)
    const five = prompt.run?.windows?.find(one => one.kind === 'five_hour')
    const key = keyOf(prompt.id)
    return (
      <Box
        key={overviewPromptKey(prompt.id)}
        flexDirection="column"
        borderStyle="round"
        borderColor={facts.isRunning ? 'warning' : 'subtle'}
        backgroundColor={isTerminal ? undefined : CARD_BACKGROUND}
        paddingX={isTerminal ? 1 : 2}
        paddingY={0}
      >
        <Box flexDirection="row" columnGap={data.space.gap} alignItems="center">
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            {overviewTitle(prompt, ui, act)}
          </Box>
          <Text color={status.tone}>{status.text}</Text>
        </Box>
        <Box flexDirection="row" columnGap={data.space.gap} alignItems="center">
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text>
              <Text dimColor>{fmtClock(prompt.at, data.now)}</Text>
              {facts.durationMs !== undefined && <Text dimColor> · {fmtDuration(facts.durationMs)}</Text>}
              <Text color="suggestion"> · {facts.calls === 0 ? 'no calls' : `${facts.calls} call${facts.calls === 1 ? '' : 's'}`}</Text>
              {facts.failed > 0 && <Text color="error"> · ✗ {facts.failed}</Text>}
              {facts.calls > 0 && <Text color={facts.net.measured > 0 ? toneNetTotal(facts.net.netIn + facts.net.netOut) : undefined} dimColor={facts.net.measured === 0}> · {callsNetText(facts.net)}</Text>}
              {usd > 0 && <Text color={toneUsd(usd)}> · ≈ {fmtUsd(usd)}</Text>}
              {tokens !== undefined && <Text dimColor> · {fmtInOut(tokens.input, tokens.cached, tokens.output, false)}</Text>}
              {five !== undefined && <Text color={toneWindow(five)}> · 5h {windowLead(five, usd, estimateOf(five, usd, data))}</Text>}
            </Text>
          </Box>
          <Button key={`ovjump:${key}`} label={jumpLabel(data.surface, true)} onPress={press => act.jumpToPrompt(prompt.id, press)} />
        </Box>
      </Box>
    )
  })
  return sectionCard(ui, data, OVERVIEW_PROMPTS_CARD, 'Prompts', data.prompts.length === 0 ? '' : `the latest ${Math.min(OVERVIEW_PROMPTS, data.prompts.length)} · a title opens its card · ${jumpLabel(data.surface, true)} brings one into view`, [
    ...(cards.length === 0
      ? [<Text dimColor>No prompts yet. The latest you send show here, titled in a few words.</Text>]
      : [
          <Box flexDirection="column" rowGap={isTerminal ? 0 : 1} marginTop={data.space.row}>
            {cards}
          </Box>,
        ]),
    <Box flexDirection="row" columnGap={data.space.gap} marginTop={data.space.row}>
      <Button key="ov:prompts" label={`All prompts (${data.prompts.length})`} dimColor onPress={() => act.setTab('prompts')} />
    </Box>,
  ])
}
