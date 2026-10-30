// The prompts you sent: each with a short summary (the first sentence at
// once, a model's few words when they come), the task its work is filed
// under, its row in the conversation, and what its work came to (its turns,
// requests, tokens, price, context, the rate-limit windows and the machine's
// counters around it); which prompt a spawned agent serves; the project's
// history across sessions; and the Commands tab's groups, one per prompt. Pure.

import type {
  CostBreakdown,
  AgentRecord,
  CommandRecord,
  FindAccess,
  FindApp,
  PromptRecord,
  PromptRun,
  PromptTokens,
  RateLimitView,
  StoredPrompt,
  TaskLabel,
  Totals,
  TurnEnd,
  WindowUse,
} from '../../types'
import { isLive } from './agents'
import { fmtBytes, fmtPct, fmtTokens, oneLine } from './format'
import { addParts, type Usage } from './spend'

/** How much of a prompt is kept, and how many prompts a session and a project keep. */
export const PROMPT_CHARS = 4_000
export const MAX_PROMPTS = 300
export const MAX_STORED_PROMPTS = 500
const SUMMARY_CHARS = 72

/** Origins that are you: typed, from the phone or web, or the SDK host's own turn (the desktop app's). */
const USER_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk'])

export const isUserOrigin = (kind: string): boolean => USER_ORIGINS.has(kind)

/** The store key of a project's prompts: by its repository's main working tree, so every worktree shares one. */
export const storeKey = (root: string): string => `prompts:${root}`

/** Whitespace folded, for telling one prompt's text from another's. */
export const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * A summary at once, before any model answers: the first sentence (or line),
 * past a leading greeting, cut to a short title.
 */
export const quickSummary = (text: string): string => {
  const flat = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .split('\n')
    .map(line => line.replace(/^\s*([-*•]|\d+[.)])\s+/, '').trim())
    .filter(line => line !== '')
    .join(' ')
  const sentence = (/^.*?[.!?](?=\s|$)/.exec(flat)?.[0] ?? flat).replace(/^(please|can you|could you|hey|hi|ok|okay)[,\s]+/i, '')
  const title = sentence.charAt(0).toUpperCase() + sentence.slice(1)
  return oneLine(title === '' ? '(empty prompt)' : title, SUMMARY_CHARS)
}

export const SUMMARY_SYSTEM =
  'You title a request someone sent to a coding assistant. Reply with only the title: 3 to 8 words, ' +
  'sentence case, no quotes, no trailing period, naming what they asked for.'

/** The request for a model's summary: the prompt's opening, which is what a title needs. */
export const summaryPrompt = (text: string): string => `Request:\n${text.slice(0, 3_000)}\n\nTitle:`

/** A model's reply as a title: its first line, quotes, labels and trailing stops gone; undefined when nothing is left. */
export const cleanSummary = (reply: string): string | undefined => {
  const line = (reply.split('\n').find(one => one.trim() !== '') ?? '')
    .replace(/^\s*(title|summary)\s*:\s*/i, '')
    .replace(/^["'“‘`*]+|["'”’`*.]+$/g, '')
    .trim()
  return line === '' ? undefined : oneLine(line, SUMMARY_CHARS)
}

/** Prompts short enough to be their own title need no model. */
export const needsModelSummary = (text: string): boolean => normalize(text).length > SUMMARY_CHARS

export const addPrompt = (list: readonly PromptRecord[], record: PromptRecord): PromptRecord[] =>
  [...list.filter(one => one.id !== record.id), record].slice(-MAX_PROMPTS)

/** The turn a prompt started: the newest prompt with that text and no task yet takes it. */
export const linkTask = (list: readonly PromptRecord[], text: string, taskId: string): PromptRecord[] => {
  const wanted = normalize(text)
  const index = findLastIndex(list, one => one.taskId === undefined && normalize(one.text) === wanted)
  return index < 0 ? [...list] : list.map((one, at) => (at === index ? { ...one, taskId } : one))
}

/** Its row in the conversation: the oldest prompt with that text and no row yet takes it (rows of the same text draw in order). */
export const linkRequest = (list: readonly PromptRecord[], text: string, requestId: string): PromptRecord[] => {
  if (list.some(one => one.requestId === requestId)) {
    return [...list]
  }
  const wanted = normalize(text)
  // A row may show the prompt as typed, the record as it reached the model (pastes expanded): either opening the other matches.
  const matches = (one: PromptRecord): boolean => {
    const mine = normalize(one.text)
    return mine === wanted || (wanted.length >= 20 && (mine.startsWith(wanted.slice(0, 200)) || wanted.startsWith(mine.slice(0, 200))))
  }
  const index = list.findIndex(one => one.requestId === undefined && matches(one))
  return index < 0 ? [...list] : list.map((one, at) => (at === index ? { ...one, requestId } : one))
}

export const setSummary = (list: readonly PromptRecord[], id: string, summary: string): PromptRecord[] =>
  list.map(one => (one.id === id ? { ...one, summary, isModelSummary: true } : one))

const findLastIndex = <T>(list: readonly T[], test: (item: T) => boolean): number => {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const item = list[index]
    if (item !== undefined && test(item)) {
      return index
    }
  }
  return -1
}

/** A prompt as the project keeps it. */
export const storedOf = (record: PromptRecord, sessionId: string): StoredPrompt => ({
  id: record.id,
  text: record.text.slice(0, 2_000),
  summary: record.summary,
  at: record.at,
  sessionId,
})

/** Adds or replaces a prompt in the project's history, newest last, capped. */
export const mergeStored = (list: readonly StoredPrompt[], entry: StoredPrompt): StoredPrompt[] =>
  [...list.filter(one => one.id !== entry.id), entry].sort((a, b) => a.at - b.at).slice(-MAX_STORED_PROMPTS)

/** The project's history as read from the store, dropping what does not parse. */
export const readStored = (value: unknown): StoredPrompt[] => {
  if (!Array.isArray(value)) {
    return []
  }
  const parsed: StoredPrompt[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const one: Record<string, unknown> = { ...item }
    if (typeof one.id === 'string' && typeof one.text === 'string' && typeof one.summary === 'string' && typeof one.at === 'number' && typeof one.sessionId === 'string') {
      parsed.push({ id: one.id, text: one.text, summary: one.summary, at: one.at, sessionId: one.sessionId })
    }
  }
  return parsed.slice(-MAX_STORED_PROMPTS)
}

/**
 * What a jump to a prompt scrolls to, in turn: its own message row, else the
 * first tool call its work made in the main conversation (a sub-agent's or a
 * plugin's call is not in it).
 */
export const jumpTargets = (prompt: PromptRecord, calls: readonly CommandRecord[]): string[] => {
  const firstCall =
    prompt.taskId === undefined
      ? undefined
      : [...calls]
          .filter(call => call.promptId === prompt.taskId && call.actor.kind === 'claude' && call.agentId === undefined)
          .sort((a, b) => a.startedAt - b.startedAt)[0]
  return [prompt.requestId, firstCall?.id].filter((one): one is string => one !== undefined)
}

/** The app whose Find the keystrokes drive; they are sent only while it is in front. */
export const FIND_APP = 'Claude'

/**
 * `osascript` arguments that press ⌘F in the desktop app, replace the Find
 * box's text with the clipboard (⌘A, ⌘V) and press Return. Nothing is pressed
 * unless FIND_APP is the frontmost app, so keys never land elsewhere; the
 * script prints `pressed` or `not-front`.
 */
export const findKeystrokes = (): string[] => [
  'osascript',
  '-e',
  [
    'tell application "System Events"',
    `  if name of first application process whose frontmost is true is not "${FIND_APP}" then return "not-front"`,
    '  keystroke "f" using command down',
    '  delay 0.25',
    '  keystroke "a" using command down',
    '  keystroke "v" using command down',
    '  delay 0.1',
    '  key code 36',
    'end tell',
    'return "pressed"',
  ].join('\n'),
]

/**
 * The app to allow when macOS could not name it: the engine the desktop app
 * runs, a bundle of its own (`com.anthropic.claude-code`). Claude starts it
 * through its `disclaimer` helper, so macOS holds the engine, not Claude,
 * responsible for the `osascript` it runs.
 */
export const ENGINE_APP = 'Claude Code'

/** System Settings at Privacy & Security → Accessibility. */
export const ACCESSIBILITY_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'

/**
 * `osascript` arguments that ask macOS whether Find may press its keys, and
 * for which app: the one it holds responsible for this `osascript`, named as
 * Privacy & Security lists it. Nothing is pressed. Asking (`isAsking`) also
 * has macOS list that app under Accessibility, switched off, and perhaps show
 * its own prompt; only you switch it on. Prints `{ trusted, app, name }`.
 */
export const findAccessProbe = (isAsking: boolean): string[] => [
  'osascript',
  '-l',
  'JavaScript',
  '-e',
  [
    "ObjC.import('ApplicationServices')",
    'let pid = 0',
    'try {',
    "  ObjC.bindFunction('getpid', ['int', []])",
    "  ObjC.bindFunction('responsibility_get_pid_responsible_for_pid', ['int', ['int']])",
    '  pid = $.responsibility_get_pid_responsible_for_pid($.getpid())',
    '} catch (error) {',
    '  pid = 0',
    '}',
    "let exe = ''",
    'if (pid > 0) {',
    '  try {',
    '    const shell = Application.currentApplication()',
    '    shell.includeStandardAdditions = true',
    "    exe = shell.doShellScript('ps -o comm= -p ' + pid)",
    '  } catch (error) {',
    "    exe = ''",
    '  }',
    '}',
    "const at = exe.indexOf('.app/')",
    "const app = at < 0 ? '' : exe.slice(0, at + 4)",
    "let name = ''",
    "if (app !== '') {",
    '  const bundle = $.NSBundle.bundleWithPath(app)',
    '  if (!bundle.isNil()) {',
    "    name = ObjC.unwrap(bundle.objectForInfoDictionaryKey('CFBundleDisplayName')) || ObjC.unwrap(bundle.objectForInfoDictionaryKey('CFBundleName')) || ''",
    '  }',
    '}',
    `JSON.stringify({ trusted: $.AXIsProcessTrustedWithOptions($({ AXTrustedCheckOptionPrompt: ${isAsking} })) === true, app: app, name: name })`,
  ].join('\n'),
]

/** An app bundle's name from its path, when its Info.plist names none: `/x/Foo.app` is Foo. */
const bundleName = (path: string): string => (path.split('/').at(-1) ?? '').replace(/\.app$/, '')

/** What findAccessProbe printed: whether Find may press keys, and for which app; undefined for anything else. */
export const readFindAccess = (stdout: string): FindAccess | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined
  }
  const fields: Record<string, unknown> = { ...parsed }
  if (typeof fields.trusted !== 'boolean') {
    return undefined
  }
  const path = typeof fields.app === 'string' ? fields.app.trim() : ''
  const name = typeof fields.name === 'string' && fields.name.trim() !== '' ? fields.name.trim() : bundleName(path)
  return { isAllowed: fields.trusted, app: path === '' || name === '' ? null : { name, path } }
}

/** Why System Events refused Find's keys: the app may not use Accessibility, or may not control System Events (Automation). */
export type FindRefusal = 'accessibility' | 'automation'

/**
 * Which permission a failed findKeystrokes run lacked, from its error:
 * System Events says `osascript is not allowed to send keystrokes. (1002)`,
 * or `… not allowed assistive access`, naming `osascript` while macOS judges
 * the app responsible for it; `Not authorized to send Apple events to System
 * Events. (-1743)` is Automation. Undefined for any other failure.
 */
export const findRefusal = (error: string): FindRefusal | undefined => {
  if (/-1743|not authori[sz]ed to send apple events/i.test(error)) {
    return 'automation'
  }
  return /not allowed|assistive|keystrokes is disabled|\(1002\)|-25211|-1719/i.test(error) ? 'accessibility' : undefined
}

/** What a Find says when its keys could not be pressed: what to press, and what to allow, for which app, to have the button press them. */
export const findFallbackText = (snippet: string, refusal: FindRefusal | undefined, app: string): string => {
  const asked = `Copied “${oneLine(snippet, 60)}”. Press ⌘F, then ⌘V, to find this prompt in the conversation.`
  if (refusal === 'automation') {
    return `${asked} To have the button press them, allow “${app}” to control System Events in System Settings → Privacy & Security → Automation.`
  }
  return refusal === 'accessibility' ? `${asked} To have the button press them, switch on “${app}” in System Settings → Privacy & Security → Accessibility.` : asked
}

/** What Allow says once System Settings is open: which app to switch on, and how to add it when it is not listed. */
export const allowKeysText = (app: FindApp | null, isPathCopied: boolean): string => {
  const add = isPathCopied ? 'press +, then ⌘⇧G, paste its path (copied) and choose Open' : 'press + and choose it'
  return `Switch on “${app?.name ?? ENGINE_APP}” in the Accessibility list (macOS may ask first). Not listed? ${add}. Find in conversation presses ⌘F for you once it is on.`
}

/** What the monitor says once macOS lets Find press its keys. */
export const allowedKeysText = (app: FindApp | null): string =>
  `“${app?.name ?? ENGINE_APP}” may press keys now: ⌕ Find in conversation types the search in the app's Find for you.`

/** A jump to one of this session's prompts: its title, for a toast, what to scroll to in turn, and what Find (⌘F) looks for. */
export type JumpPlan = { summary: string; targets: string[]; snippet: string }

/** How much of a prompt's opening Find is given: enough to be unique, short enough to match as the conversation draws it. */
const SNIPPET_CHARS = 60

/** A prompt's opening as the app's Find (⌘F) can match it in the conversation: its first line, cut at a word near SNIPPET_CHARS. */
export const findSnippet = (text: string): string => {
  const line = (text.split('\n').find(one => one.trim() !== '') ?? '').replace(/\s+/g, ' ').trim()
  if (line.length <= SNIPPET_CHARS) {
    return line
  }
  const cut = line.slice(0, SNIPPET_CHARS)
  const space = cut.lastIndexOf(' ')
  return space > SNIPPET_CHARS / 2 ? cut.slice(0, space) : cut
}

/**
 * What a jump to the prompt `id` scrolls to, from what a drawing knew and the
 * conversation rows seen since (`[requestId, text]`, not yet written to the
 * state): undefined for a prompt this session does not hold.
 */
export const jumpPlan = (
  known: readonly PromptRecord[],
  rows: readonly (readonly [string, string])[],
  calls: readonly CommandRecord[],
  id: string,
): JumpPlan | undefined => {
  const linked = rows.reduce((list, [requestId, text]) => linkRequest(list, text, requestId), [...known])
  const prompt = linked.find(one => one.id === id)
  return prompt === undefined ? undefined : { summary: prompt.summary, targets: jumpTargets(prompt, calls), snippet: findSnippet(prompt.text) }
}

/** What a group of commands is called when no prompt of this session explains it. */
export const NO_PROMPT = 'Before any prompt'

/** One prompt's commands, for the Commands tab. */
export type CommandGroup = {
  /** The prompt's task id, or `''` for calls made outside any prompt. */
  id: string
  title: string
  /** When the prompt was sent (or its first call, when that is unknown). */
  at: number
  records: CommandRecord[]
  prompt?: PromptRecord
}

/**
 * The commands (newest first, as listed) cut into one group per prompt, the
 * newest prompt first: named by its summary, else by its task's label.
 */
export const groupCommands = (records: readonly CommandRecord[], prompts: readonly PromptRecord[], tasks: readonly TaskLabel[]): CommandGroup[] => {
  const groups = new Map<string, CommandGroup>()
  for (const record of records) {
    const id = record.promptId ?? ''
    const group = groups.get(id)
    if (group !== undefined) {
      group.records.push(record)
      group.at = Math.min(group.at, record.startedAt)
      continue
    }
    const prompt = prompts.find(one => one.taskId === id)
    const task = tasks.find(one => one.id === id)
    groups.set(id, {
      id,
      title: prompt?.summary ?? (task !== undefined ? quickSummary(task.label) : id === '' ? NO_PROMPT : 'Earlier prompt'),
      at: prompt?.at ?? task?.startedAt ?? record.startedAt,
      records: [record],
      prompt,
    })
  }
  return [...groups.values()].sort((a, b) => b.at - a.at)
}

// ------------------------------------------------------------------------- //
// A prompt's run: its turns, requests and the machine's counters around it
// ------------------------------------------------------------------------- //

export const ZERO_TOKENS: PromptTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** Tokens in (of them cached, read from the prompt cache) and out. */
export type InOut = { input: number; cached: number; output: number }

/** What a run's requests reported, in and out; undefined before one has. */
export const runTokens = (run: PromptRun | undefined): InOut | undefined =>
  run === undefined || run.requests === 0 ? undefined : { input: run.tokens.input + run.tokens.cacheRead + run.tokens.cacheWrite, cached: run.tokens.cacheRead, output: run.tokens.output }

/** How many agents a run lists. */
const MAX_RUN_AGENTS = 50

/** A run as its first turn begins, the session's counters as they stand (absent while the sampler is not running). */
export const newRun = (totals: Totals | undefined): PromptRun => ({
  turns: 1,
  workMs: 0,
  requests: 0,
  tokens: { ...ZERO_TOKENS },
  usd: 0,
  agents: [],
  ...(totals !== undefined ? { startTotals: { ...totals } } : {}),
})

/** The newest prompt whose work is filed under `taskId`, its run changed; the list as it was when none is. */
const withRun = (list: readonly PromptRecord[], taskId: string | undefined, change: (run: PromptRun | undefined) => PromptRun): PromptRecord[] => {
  const index = taskId === undefined ? -1 : findLastIndex(list, one => one.taskId === taskId)
  return index < 0 ? [...list] : list.map((one, at) => (at === index ? { ...one, run: change(one.run) } : one))
}

/** A run's windows after a reading, when there was one; as they were otherwise. */
const withReadings = (windows: readonly WindowUse[] | undefined, readings: readonly RateLimitView[], now: number): { windows?: WindowUse[] } =>
  readings.length === 0 ? (windows === undefined ? {} : { windows: [...windows] }) : { windows: noteWindows(windows, readings, now) }

/**
 * A turn of the prompt began: its run starts, or (a continuation) runs again;
 * the rate-limit windows are read at its start.
 */
export const beginTurn = (
  list: readonly PromptRecord[],
  taskId: string | undefined,
  totals: Totals | undefined,
  readings: readonly RateLimitView[] = [],
  now = 0,
): PromptRecord[] =>
  withRun(list, taskId, run =>
    run === undefined
      ? { ...newRun(totals), ...withReadings(undefined, readings, now) }
      : { ...run, turns: run.turns + 1, endedAt: undefined, endReason: undefined, ...withReadings(run.windows, readings, now) },
  )

/** The context a request carried: its input, whether read from the cache, written to it, or neither. */
export const contextOf = (usage: Usage): number => usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens

/** A request of the prompt's own loop (not a sub-agent's): the context window it ran in, when the session said. */
export type OwnRequest = { contextWindow?: number }

/**
 * A model request made for the prompt (its own loop's or a sub-agent's): its
 * tokens, and its list price when the model has one. One of its own loop's
 * (`own`) also says how much context the prompt carried.
 */
export const addRequest = (
  list: readonly PromptRecord[],
  taskId: string | undefined,
  usage: Usage,
  usd: number | undefined,
  model: string,
  own?: OwnRequest,
  parts?: CostBreakdown,
): PromptRecord[] =>
  withRun(list, taskId, run => {
    const current = run ?? newRun(undefined)
    const size = contextOf(usage)
    return {
      ...current,
      ...(parts === undefined ? {} : { parts: addParts(current.parts, parts) }),
      requests: current.requests + 1,
      tokens: {
        input: current.tokens.input + usage.input_tokens,
        output: current.tokens.output + usage.output_tokens,
        cacheRead: current.tokens.cacheRead + usage.cache_read_input_tokens,
        cacheWrite: current.tokens.cacheWrite + usage.cache_creation_input_tokens,
      },
      usd: current.usd + (usd ?? 0),
      model,
      ...(own === undefined ? {} : { contextFirst: current.contextFirst ?? size, contextLast: size, contextWindow: own.contextWindow ?? current.contextWindow }),
    }
  })

/** An agent spawned for the prompt whose work is filed under `taskId`: its run lists it. */
export const addAgent = (list: readonly PromptRecord[], taskId: string | undefined, agentId: string): PromptRecord[] =>
  withRun(list, taskId, run => {
    const current = run ?? newRun(undefined)
    const agents = current.agents ?? []
    return agents.includes(agentId) ? current : { ...current, agents: [...agents, agentId].slice(-MAX_RUN_AGENTS) }
  })

/** How a turn ended, and the rate-limit windows as the session read them then (none when unread). */
export type TurnEnded = { at: number; durationMs: number; reason: TurnEnd; totals: Totals | undefined; readings?: readonly RateLimitView[] }

/** The session's counters and rate-limit windows at a moment. */
export type Reading = { at: number; totals: Totals | undefined; readings: readonly RateLimitView[] }

/**
 * Work of the prompt went on past its turn (an agent spawned for it ended):
 * its run takes the session's counters and windows as they stand. A run whose
 * turn still goes is left to that turn's end.
 */
export const extendRun = (list: readonly PromptRecord[], taskId: string, later: Reading): PromptRecord[] =>
  list.map(one => {
    const run = one.run
    if (one.taskId !== taskId || run === undefined || run.endedAt === undefined) {
      return one
    }
    const endTotals = later.totals !== undefined && run.startTotals !== undefined ? { endTotals: { ...later.totals } } : {}
    return { ...one, run: { ...run, ...endTotals, ...withReadings(run.windows, later.readings, later.at) } }
  })

/** A turn of the prompt ended: when and how, how long it ran, and the session's counters and windows then. */
export const endTurn = (list: readonly PromptRecord[], taskId: string | undefined, end: TurnEnded): PromptRecord[] =>
  withRun(list, taskId, run => {
    const current = run ?? newRun(undefined)
    return {
      ...current,
      workMs: current.workMs + Math.max(0, end.durationMs),
      endedAt: end.at,
      endReason: end.reason,
      ...(end.totals !== undefined && current.startTotals !== undefined ? { endTotals: { ...end.totals } } : {}),
      ...withReadings(current.windows, end.readings ?? [], end.at),
    }
  })

/** Runs whose end was never seen (the monitor reloaded mid-turn), closed as a new prompt begins; that prompt's own run is left. */
export const closeOpenRuns = (list: readonly PromptRecord[], exceptTaskId: string | undefined, at: number): PromptRecord[] =>
  list.map(one =>
    one.run !== undefined && one.run.endedAt === undefined && one.taskId !== exceptTaskId ? { ...one, run: { ...one.run, endedAt: Math.max(one.at, at) } } : one,
  )

/** The tools that change files: a prompt's calls with them are the files it changed. */
const FILE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
/** The tools that start agents. */
const AGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task', 'Workflow'])

/** One line of a prompt's agents: a workflow (with how many of its agents it lists) or an agent, under its workflow when it has one. */
export type PromptAgentLine = { id: string; label: string; kind: string; depth: number; agents?: number }

/** A prompt's agents: how many, and their names, each workflow's under it. */
export type PromptAgents = { total: number; lines: PromptAgentLine[] }

/**
 * The agents a prompt used, oldest first: those spawned for it (its run's),
 * each workflow's under the workflow, which is no agent itself; for a prompt
 * kept before runs listed them (a past session's), its Agent and Workflow
 * calls, named as they were asked.
 */
export const promptAgents = (prompt: PromptRecord, agents: readonly AgentRecord[], calls: readonly CommandRecord[]): PromptAgents => {
  const ids = prompt.run?.agents
  if (ids === undefined) {
    const asked = prompt.taskId === undefined ? [] : calls.filter(call => call.promptId === prompt.taskId && AGENT_TOOLS.has(call.tool) && call.agentId === undefined)
    const lines = [...asked].sort((a, b) => a.startedAt - b.startedAt).map((call): PromptAgentLine => ({ id: call.id, label: call.summary || call.title, kind: call.tool === 'Workflow' ? 'workflow' : 'agent', depth: 0 }))
    return { total: lines.filter(line => line.kind !== 'workflow').length, lines }
  }
  const mine = agents.filter(one => ids.includes(one.id)).sort((a, b) => a.startedAt - b.startedAt)
  const parents = new Map(agents.filter(one => one.kind === 'workflow').map(one => [one.id, one]))
  const lines: PromptAgentLine[] = []
  const placed = new Set<string>()
  for (const agent of mine) {
    const workflow = agent.parentId === undefined ? undefined : parents.get(agent.parentId)
    if (workflow !== undefined && !placed.has(workflow.id)) {
      placed.add(workflow.id)
      const its = mine.filter(one => one.parentId === workflow.id)
      lines.push({ id: workflow.id, label: workflow.label, kind: 'workflow', depth: 0, agents: its.length })
      lines.push(...its.map((one): PromptAgentLine => ({ id: one.id, label: one.label, kind: one.type === '' ? 'agent' : one.type, depth: 1 })))
    } else if (workflow === undefined) {
      lines.push({ id: agent.id, label: agent.label, kind: agent.type === '' ? 'agent' : agent.type, depth: 0 })
    }
  }
  // Agents not in the session's list yet count, though they cannot be named.
  return { total: Math.max(ids.length, mine.length), lines }
}

/** What the machine spent while the prompt ran, from its run's counters; absent unless both ends were read and none went back. */
export type PromptUse = { energyJ: number; cpuS: number; netIn: number; netOut: number; diskR: number; diskW: number }

export const useOf = (run: PromptRun | undefined): PromptUse | undefined => {
  const start = run?.startTotals
  const end = run?.endTotals
  if (start === undefined || end === undefined) {
    return undefined
  }
  const use: PromptUse = {
    energyJ: end.energyJ + end.energyEstJ - (start.energyJ + start.energyEstJ),
    cpuS: end.cpuS - start.cpuS,
    netIn: end.netIn - start.netIn,
    netOut: end.netOut - start.netOut,
    diskR: end.diskR - start.diskR,
    diskW: end.diskW - start.diskW,
  }
  // A counter that went back (the sampler restarted) says nothing.
  return Object.values(use).some(value => value < 0) ? undefined : use
}

/** Everything a prompt's card shows, from its record, its calls and its agents. */
export type PromptFacts = {
  calls: number
  failed: number
  running: number
  /** The tools its calls used, the most used first. */
  tools: { tool: string; count: number }[]
  /** Files its calls wrote or edited. */
  files: number
  /** The agents spawned for it; for a prompt kept before those were, the agents and workflows its calls started. */
  agents: number
  /** When its first call started and its last ended. */
  firstCallAt?: number
  lastCallAt?: number
  /** Its calls' running time, summed. */
  callMs: number
  /** Its calls' shares of the requests that read them, for a prompt priced before runs were kept. */
  callUsd: number
  isRunning: boolean
  /** When its work ended; absent while it runs. */
  endedAt?: number
  /** From sent to its end, or to now while it runs; absent when its end is not known. */
  durationMs?: number
  use?: PromptUse
  /** Its calls' network, summed: down, up, and how many of its calls the sampler measured (Bash calls); the rest run inside Claude Code. */
  net: CallsNetwork
}

/** Network summed over calls: bytes down and up, and how many of the calls were measured. */
export type CallsNetwork = { netIn: number; netOut: number; measured: number }

/** Summed network as a row shows it, `⇅ 12 MB`; `⇅ —` where none of the calls was measured. */
export const callsNetText = (net: CallsNetwork): string => `⇅ ${net.measured > 0 ? fmtBytes(net.netIn + net.netOut) : '—'}`

/** An agent's network: its own calls' summed, or for a background shell, its command's. */
export const agentNetwork = (record: AgentRecord, calls: readonly CommandRecord[]): CallsNetwork =>
  callsNetwork(calls.filter(call => call.agentId === record.id || (record.kind === 'shell' && call.id === record.toolUseId)))

/** The network of `calls`, summed over those the sampler measured. */
export const callsNetwork = (calls: readonly CommandRecord[]): CallsNetwork =>
  calls.reduce(
    (total, call) =>
      call.metrics.isSampled
        ? { netIn: total.netIn + call.metrics.netIn, netOut: total.netOut + call.metrics.netOut, measured: total.measured + 1 }
        : total,
    { netIn: 0, netOut: 0, measured: 0 },
  )

/** The agents of `agents` spawned for the prompt. */
const agentsOf = (prompt: PromptRecord, agents: readonly AgentRecord[]): AgentRecord[] => {
  const ids = prompt.run?.agents ?? []
  return ids.length === 0 ? [] : agents.filter(agent => ids.includes(agent.id))
}

/** Whether the prompt's work goes on: its turn (or the turn it was folded into) runs, or an agent spawned for it works. */
export const isAtWork = (prompt: PromptRecord, agents: readonly AgentRecord[]): boolean =>
  prompt.run !== undefined && (prompt.run.endedAt === undefined || agentsOf(prompt, agents).some(agent => isLive(agent.status)))

/**
 * What a prompt's card shows. Its work goes on while its turn runs or an
 * agent spawned for it works, and ends at the last of them: its turn's end,
 * its calls' (a call with no end counts from its start) and its agents'.
 */
export const promptFacts = (prompt: PromptRecord, calls: readonly CommandRecord[], now: number, agents: readonly AgentRecord[] = []): PromptFacts => {
  const mine = prompt.taskId === undefined ? [] : calls.filter(call => call.promptId === prompt.taskId)
  const counts = new Map<string, number>()
  for (const call of mine) {
    const tool = call.tool.startsWith('mcp__') ? call.tool.slice(5).replace('__', ' · ') : call.tool
    counts.set(tool, (counts.get(tool) ?? 0) + 1)
  }
  const files = new Set(mine.filter(call => FILE_TOOLS.has(call.tool) && call.filePath !== undefined && call.status === 'ok').map(call => call.filePath))
  const firstCallAt = mine.length === 0 ? undefined : Math.min(...mine.map(call => call.startedAt))
  const lastCallAt = mine.length === 0 ? undefined : Math.max(...mine.map(call => call.endedAt ?? now))
  const run = prompt.run
  const isRunning = isAtWork(prompt, agents)
  const lastWork = (ended: number): number =>
    Math.max(ended, ...mine.map(call => call.endedAt ?? call.startedAt), ...agentsOf(prompt, agents).map(agent => agent.endedAt ?? agent.lastActivityAt))
  // A prompt kept before runs were: its last call's end stands in for its own.
  const endedAt = isRunning ? undefined : run?.endedAt !== undefined ? lastWork(run.endedAt) : lastCallAt
  return {
    calls: mine.length,
    failed: mine.filter(call => call.status === 'error' || call.status === 'denied').length,
    running: mine.filter(call => call.status === 'running' || call.status === 'background').length,
    tools: [...counts].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool)),
    files: files.size,
    agents: run?.agents !== undefined ? run.agents.length : mine.filter(call => AGENT_TOOLS.has(call.tool)).length,
    firstCallAt,
    lastCallAt,
    callMs: mine.reduce((total, call) => total + Math.max(0, (call.endedAt ?? now) - call.startedAt), 0),
    callUsd: mine.reduce((total, call) => total + (call.spend?.usd ?? 0), 0),
    isRunning,
    endedAt,
    durationMs: isRunning ? Math.max(0, now - prompt.at) : endedAt !== undefined ? Math.max(0, endedAt - prompt.at) : undefined,
    use: useOf(run),
    net: callsNetwork(mine),
  }
}

// ------------------------------------------------------------------------- //
// Context and the rate-limit windows: what a prompt's run took of each
// ------------------------------------------------------------------------- //

/**
 * A run's context for its card, `197k (20% of 1M) · +12k`: its own loop's
 * latest request's, its share of the context window, and how much it grew
 * since the first; undefined before its first.
 */
export const contextText = (run: PromptRun | undefined): string | undefined => {
  const last = run?.contextLast
  if (run === undefined || last === undefined) {
    return undefined
  }
  const window = run.contextWindow ?? 0
  const share = window > 0 ? ` (${fmtPct((last / window) * 100)} of ${fmtTokens(window)})` : ''
  const grew = last - (run.contextFirst ?? last)
  return `${fmtTokens(last)}${share} · ${grew < 0 ? '−' : '+'}${fmtTokens(Math.abs(grew))}`
}

/** The rate-limit windows a prompt's card shows, as the session names them. */
export const WINDOW_KINDS: readonly string[] = ['five_hour', 'seven_day']

/** A fall in a window's percent larger than this is a reset whose times were not reported. */
const RESET_FALL = 1

/**
 * Whether a reading is of a window after the one kept: the kept one's reset
 * time has passed and the reading names another, or its percent fell.
 */
const isNewWindow = (kept: WindowUse, reading: RateLimitView, now: number): boolean => {
  const resetsAt = kept.resetsAt === undefined ? Number.NaN : Date.parse(kept.resetsAt)
  const hasPassed = Number.isFinite(resetsAt) && resetsAt <= now && reading.resetsAt !== undefined && reading.resetsAt !== kept.resetsAt
  return hasPassed || reading.percentUsed < kept.lastPct - RESET_FALL
}

/** The points of a window a run used: in the windows that reset meanwhile, and in this one since its count began. */
export const windowPoints = (use: WindowUse): number => use.earlierPoints + Math.max(0, use.lastPct - use.startPct)

/**
 * A run's windows after a reading of the session's. A window that reset in
 * between keeps the points the run used before and counts again from 0; a
 * kind the reading lacks is kept as it was.
 */
export const noteWindows = (windows: readonly WindowUse[] | undefined, readings: readonly RateLimitView[], now: number): WindowUse[] => {
  const kept = [...(windows ?? [])]
  for (const kind of WINDOW_KINDS) {
    const reading = readings.find(one => one.kind === kind)
    if (reading === undefined || !Number.isFinite(reading.percentUsed)) {
      continue
    }
    const pct = reading.percentUsed
    const index = kept.findIndex(one => one.kind === kind)
    const current = kept[index]
    if (current === undefined) {
      kept.push({ kind, firstPct: pct, startPct: pct, lastPct: pct, resetsAt: reading.resetsAt, earlierPoints: 0, resets: 0 })
    } else if (isNewWindow(current, reading, now)) {
      kept[index] = { ...current, startPct: 0, lastPct: pct, resetsAt: reading.resetsAt, earlierPoints: windowPoints(current), resets: current.resets + 1 }
    } else {
      kept[index] = { ...current, lastPct: pct, resetsAt: reading.resetsAt ?? current.resetsAt }
    }
  }
  return kept
}

/** The windows read again for the prompts `isOpen` names: the ones at work. */
export const noteOpenWindows = (list: readonly PromptRecord[], isOpen: (prompt: PromptRecord) => boolean, readings: readonly RateLimitView[], now: number): PromptRecord[] =>
  list.map(one => (one.run !== undefined && readings.length > 0 && isOpen(one) ? { ...one, run: { ...one.run, windows: noteWindows(one.run.windows, readings, now) } } : one))

/** The smallest rise a window reports: a tenth of a point, or a point where it reported whole points. */
const stepOf = (use: WindowUse): number => (Number.isInteger(use.firstPct) && Number.isInteger(use.lastPct) ? 1 : 0.1)

/** A rise below this is none: what is left of a tenth's rounding. */
const NO_RISE = 0.05

const pctText = (pct: number): string => `${pct.toFixed(1)}%`

/**
 * The points a run took of a window, in short: `+1.2%`. Under a step while
 * the run cost something, an estimate from its cost when there is one
 * (`≈ 0.04%`), else that it rose less than a step (`< 0.1%`).
 */
export const windowLead = (use: WindowUse, usd: number, estimate?: string): string => {
  const points = windowPoints(use)
  if (points >= NO_RISE) {
    return `+${points.toFixed(1)}%`
  }
  return usd > 0 ? (estimate ?? `< ${stepOf(use)}%`) : '+0.0%'
}

/** What a run took of a window, for its card: `+1.2% (24.8% → 26.0%)`, a reset between them said. */
export const windowText = (use: WindowUse, usd: number, estimate?: string): string =>
  `${windowLead(use, usd, estimate)} (${pctText(use.firstPct)} → ${use.resets > 0 ? 'reset → ' : ''}${pctText(use.lastPct)})`

// ------------------------------------------------------------------------- //
// Prompts typed during a turn: folded into it, or a turn of their own
// ------------------------------------------------------------------------- //

/** The task a prompt folded into a running turn files its work under. */
export const deliveredTaskId = (promptId: string): string => `in-turn:${promptId}`

/** Whether the prompt was folded into a running turn, with no turn of its own. */
export const isFolded = (prompt: PromptRecord): boolean => prompt.taskId !== undefined && prompt.taskId === deliveredTaskId(prompt.id)

/** How much of a prompt's opening a text must hold to carry it. */
const CARRIED_CHARS = 200
/** A prompt shorter than this is carried only by a text that is little more than it. */
const SHORT_PROMPT = 40
/** How much the engine's framing may add around a short prompt. */
const FRAMING_CHARS = 400

/** Whether `text` holds `phrase` as whole words. */
const holdsPhrase = (text: string, phrase: string): boolean => {
  const isWordChar = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}]/u.test(char)
  for (let at = text.indexOf(phrase); at >= 0; at = text.indexOf(phrase, at + 1)) {
    if (!isWordChar(text[at - 1]) && !isWordChar(text[at + phrase.length])) {
      return true
    }
  }
  return false
}

/**
 * Whether a text the engine injected for the model carries a prompt: it holds
 * the prompt's opening as written (whitespace and case aside). A short prompt
 * counts only in a text that is little more than it, so a few common words
 * inside a longer notice do not.
 */
export const carriesPrompt = (carrier: string, prompt: string): boolean => {
  const head = normalize(prompt).toLowerCase().slice(0, CARRIED_CHARS)
  const text = normalize(carrier).toLowerCase()
  if (head === '' || !holdsPhrase(text, head)) {
    return false
  }
  return head.length >= SHORT_PROMPT || text.length <= head.length + FRAMING_CHARS
}

/** The prompts still waiting for their turn that an injected text carries: the oldest of each text. */
export const carriedPrompts = (list: readonly PromptRecord[], carrier: string): PromptRecord[] => {
  const seen = new Set<string>()
  const carried: PromptRecord[] = []
  for (const one of [...list].sort((a, b) => a.at - b.at)) {
    const text = normalize(one.text)
    if (one.taskId === undefined && !seen.has(text) && carriesPrompt(carrier, one.text)) {
      seen.add(text)
      carried.push(one)
    }
  }
  return carried
}

/** A running turn took prompts in: which turn (when known), when, and the session's counters and windows then. */
export type Delivery = { into: string | undefined; at: number; totals: Totals | undefined; readings: readonly RateLimitView[] }

/**
 * Prompts a running turn took in: each gets a task of its own, so the work
 * done for it can be filed under it, and its run begins with no turn of its
 * own; the turn's end closes the run. One with a task already is left be.
 */
export const deliverPrompts = (list: readonly PromptRecord[], ids: ReadonlySet<string>, delivery: Delivery): PromptRecord[] =>
  list.map(one =>
    ids.has(one.id) && one.taskId === undefined
      ? {
          ...one,
          taskId: deliveredTaskId(one.id),
          deliveredAt: delivery.at,
          ...(delivery.into !== undefined ? { deliveredInto: delivery.into } : {}),
          run: { ...newRun(delivery.totals), turns: 0, ...withReadings(undefined, delivery.readings, delivery.at) },
        }
      : one,
  )

/** A prompt typed during a turn began a turn of its own: when the model was given it. */
export const markDelivered = (list: readonly PromptRecord[], taskId: string, at: number): PromptRecord[] =>
  list.map(one => (one.taskId === taskId && one.deliveredAt === undefined ? { ...one, deliveredAt: at } : one))

/**
 * The running turn `turnId` ended: the runs of the prompts folded into it
 * end with it (an agent spawned for one may work on), the session's counters
 * and windows read then.
 */
export const endFolded = (list: readonly PromptRecord[], turnId: string, end: TurnEnded): PromptRecord[] =>
  list.map(one => {
    const run = one.run
    if (run === undefined || run.endedAt !== undefined || !isFolded(one) || (one.deliveredInto !== undefined && one.deliveredInto !== turnId)) {
      return one
    }
    return {
      ...one,
      run: {
        ...run,
        endedAt: end.at,
        endReason: end.reason,
        ...(end.totals !== undefined && run.startTotals !== undefined ? { endTotals: { ...end.totals } } : {}),
        ...withReadings(run.windows, end.readings ?? [], end.at),
      },
    }
  })

// ------------------------------------------------------------------------- //
// Which prompt a spawned agent serves
// ------------------------------------------------------------------------- //

/** Words too common to tell one request from another. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'her', 'was', 'one', 'our', 'out', 'has', 'him', 'his', 'how',
  'its', 'let', 'may', 'now', 'see', 'she', 'too', 'use', 'way', 'who', 'did', 'get', 'got', 'had', 'yes', 'yet', 'also', 'into',
  'that', 'this', 'with', 'from', 'have', 'they', 'them', 'then', 'than', 'there', 'their', 'these', 'those', 'what', 'when',
  'where', 'which', 'while', 'will', 'would', 'should', 'could', 'just', 'like', 'make', 'need', 'want', 'were', 'been', 'being',
  'some', 'such', 'only', 'other', 'each', 'very', 'more', 'most', 'much', 'many', 'about', 'after', 'before', 'over', 'under',
  'again', 'here', 'your', 'yours', 'mine', 'does', 'doing', 'done', 'please', 'thanks', 'okay', 'user', 'asked', 'asks', 'wants',
  'request', 'task', 'agent', 'claude',
])

/** A plural's or a tense's ending cut, so `copying` and `copy` read alike. */
const stem = (word: string): string =>
  word.length > 5 && word.endsWith('ing')
    ? word.slice(0, -3)
    : word.length > 4 && word.endsWith('ed')
      ? word.slice(0, -2)
      : word.length > 3 && word.endsWith('s') && !word.endsWith('ss')
        ? word.slice(0, -1)
        : word

/** The words matching reads: lowercase runs of letters and digits, three or more long, the commonest left out, endings cut. */
export const tellingWords = (text: string): string[] =>
  (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => word.length >= 3 && !STOP_WORDS.has(word)).map(stem)

/** Three telling words in a row: the phrases a quote repeats. */
const phrasesOf = (words: readonly string[]): Set<string> => {
  const phrases = new Set<string>()
  for (let at = 0; at + 2 < words.length; at += 1) {
    phrases.add(`${words[at] ?? ''} ${words[at + 1] ?? ''} ${words[at + 2] ?? ''}`)
  }
  return phrases
}

/** How much of a prompt a text repeats: its phrases (three telling words in a row) and its telling words. */
export type Overlap = { phrases: number; words: number }

export const overlapOf = (prompt: string, text: string): Overlap => {
  const mine = tellingWords(prompt.slice(0, PROMPT_CHARS))
  const theirs = tellingWords(text)
  const theirPhrases = phrasesOf(theirs)
  const theirWords = new Set(theirs)
  return {
    phrases: [...phrasesOf(mine)].filter(phrase => theirPhrases.has(phrase)).length,
    words: [...new Set(mine)].filter(word => theirWords.has(word)).length,
  }
}

/** How strongly a text quotes a prompt: a repeated phrase counts as two words. */
export const quoteScore = (overlap: Overlap): number => overlap.phrases * 2 + overlap.words

/** The least score that says a spawn quotes a prompt, and how far it must lead the next prompt's. */
export const QUOTE_MIN = 4
export const QUOTE_LEAD = 1.5

/** When the model was given the prompt: its own turn began, or a running turn took it in; undefined while it waits. */
const deliveredTime = (prompt: PromptRecord): number | undefined => (prompt.taskId === undefined ? undefined : (prompt.deliveredAt ?? prompt.at))

/** The prompt the model was given last. */
const latestDelivered = (list: readonly PromptRecord[]): PromptRecord | undefined => {
  let latest: PromptRecord | undefined
  for (const one of list) {
    const at = deliveredTime(one)
    if (at !== undefined && (latest === undefined || at >= (deliveredTime(latest) ?? 0))) {
      latest = one
    }
  }
  return latest
}

/**
 * The prompt a spawned agent serves, from its prompt and description
 * (`words`). Of the turn's prompt and those sent since (folded into the turn,
 * or still waiting), the one its words quote best, when that clearly leads;
 * else the one the model was given last. In a turn that is no prompt of yours
 * (a notification's), any prompt it clearly quotes, else none. Undefined
 * when none is found: the caller keeps the turn's. One still waiting that a
 * spawn quotes was given to the model after all: the caller marks it so.
 */
export const spawnOwner = (list: readonly PromptRecord[], turnTaskId: string | undefined, words: string): PromptRecord | undefined => {
  const turnPrompt = turnTaskId === undefined ? undefined : list[findLastIndex(list, one => one.taskId === turnTaskId)]
  const candidates = list.filter(one => turnPrompt === undefined || one.at >= turnPrompt.at)
  const scored = candidates
    .map(prompt => ({ prompt, score: quoteScore(overlapOf(prompt.text, words)) }))
    .sort((a, b) => b.score - a.score || b.prompt.at - a.prompt.at)
  const [best, next] = scored
  if (best !== undefined && best.score >= QUOTE_MIN && best.score >= QUOTE_LEAD * (next?.score ?? 0)) {
    return best.prompt
  }
  return turnPrompt === undefined ? undefined : latestDelivered(candidates)
}

/** Which prompt each agent serves, as the runs list them: `[agentId, taskId]`, for a module that (re)loaded. */
export const agentPromptsOf = (list: readonly PromptRecord[]): [string, string][] =>
  list.flatMap(one => {
    const taskId = one.taskId
    return taskId === undefined ? [] : (one.run?.agents ?? []).map((agentId): [string, string] => [agentId, taskId])
  })

/** Whether a prompt of these words still waits for its turn (typed during a turn, not yet taken in). */
export const isWaiting = (list: readonly PromptRecord[], text: string): boolean => {
  const wanted = normalize(text)
  return list.some(one => one.taskId === undefined && normalize(one.text) === wanted)
}

/** An agent's calls recorded before its prompt was known, filed under it; the list as it was when none moves. */
export const refileAgentCalls = (calls: readonly CommandRecord[], agentId: string, taskId: string): CommandRecord[] =>
  calls.some(call => call.agentId === agentId && call.promptId !== taskId)
    ? calls.map(call => (call.agentId === agentId && call.promptId !== taskId ? { ...call, promptId: taskId } : call))
    : [...calls]
