// Shared fixtures for the pane tests: the world beneath the plugin (clock,
// store, git, the sampler, battery, files, turns), the tool-call helper, a
// scripted session to start from, and row clicks. Not a test file itself.

import type { On, ProcessRunResult, ToolCallResult, TurnUsage } from 'claude-code'
import { expect, mock, type Engine } from 'claude-code/testing'
// --- ui polish ---
import type { ElementQuery, FoundElement } from 'claude-code/testing'

import { OPEN_BAR } from '../hooks/view/row'
import { TAB_BAR_KEY } from '../hooks/view/tab-bar'
// --- ui polish ---
// --- session history ---
import type { TranscriptAgent, TranscriptSession, TranscriptSummary } from '../hooks/lib/transcripts'
// --- end session history ---

export const PLUGIN = 'session-monitor'
export const NOW = 1_760_000_000_000
export const SHA = 'c'.repeat(40)
export const PARENT = 'b'.repeat(40)
export const COMMAND = 'curl -sO https://example.com/data.zip'
// --- agents ---
/** The Agent call this description makes launches sub-agent AGENT_ID; a Workflow call launches WORKFLOW_RUN. */
export const AGENT_TASK = 'Scan the repo'
export const AGENT_ID = 'ag-scan'
export const WORKFLOW_TASK = 'task-wf1'
export const WORKFLOW_RUN = 'wf_run1'
// --- end agents ---

export const ok = (stdout: string): ProcessRunResult => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
export const fail = (): ProcessRunResult => ({ exitCode: 1, stdout: '', stderr: 'no', isStdoutTruncated: false, isStderrTruncated: false })

export const STATUS = [`# branch.oid ${'a'.repeat(40)}`, '# branch.head main', '1 .M N... 100644 100644 100644 aaa bbb src/app.py', '? notes.md', ''].join('\0')
export const LOG =
  `\u001e${[SHA, 'ccccccc', PARENT, 'Ada', 'ada@example.com', String(NOW / 1000 - 60), String(NOW / 1000 - 60), 'HEAD -> main', 'feat: add the thing', 'Why it matters.'].join('\u001f')}\u001d\n\n` +
  ':100644 100644 a b M\tsrc/app.py\n5\t2\tsrc/app.py\n'
export const DIFF = 'diff --git a/src/app.py b/src/app.py\n--- a/src/app.py\n+++ b/src/app.py\n@@ -1,2 +1,2 @@\n-old line\n+new line\n same\n'
/** What `git log` and `git diff` answer in the world: LOG and DIFF unless a test sets bigger ones; reset by `world`. */
export const gitScript: { log: string; diff: string } = { log: LOG, diff: DIFF }

/** How many results each WebSearch answers with, each a page of its own: 0 for the two fixed ones. */
export const searchScript: { hits: number } = { hits: 0 }

/** The websites a scripted search's results spread over. */
const SEARCH_SITES = ['www.cboe.com', 'www.investopedia.com', 'www.reddit.com', 'github.com', 'docs.python.org', 'stackoverflow.com', 'www.optionsplaybook.com', 'www.tastylive.com', 'medium.com', 'arxiv.org']

/** git as the mod calls it: `git -c core.quotePath=false --no-pager <args>`. */
export const git = (argv: readonly string[]): ProcessRunResult => {
  const args = argv.slice(4)
  const command = args[0]
  if (command === 'rev-parse') {
    return args[1] === '--show-toplevel' ? ok('/repo\n') : fail()
  }
  if (command === 'status') {
    return ok(STATUS)
  }
  if (command === 'log') {
    return ok(gitScript.log)
  }
  if (command === 'diff' && args.includes('--shortstat')) {
    return ok(' 1 file changed\n')
  }
  if (command === 'diff' && args.includes('--numstat')) {
    return ok(args.includes('--no-index') ? '4\t0\t\0/dev/null\0notes.md\0' : '3\t1\tsrc/app.py\0')
  }
  if (command === 'diff') {
    return ok(gitScript.diff)
  }
  return fail()
}

export const seconds = (ms: number): number => ms / 1000

export const TICK = {
  type: 'tick',
  t: seconds(NOW + 1_000),
  groups: [
    { id: 'claude', kind: 'claude', label: 'Claude engine', pid: 10, procs: 1, startedAt: seconds(NOW - 60_000), mem: 300e6, peakMem: 320e6, cpuPct: 4, watts: 0.4, netInBps: 2_000, netOutBps: 9_000, tot: { cpuS: 30, energyJ: 25, netIn: 400_000, netOut: 1_600_000, netActiveS: 20 } },
    { id: 'p:20:1', kind: 'service', label: 'npm exec @gitkraken/gk mcp', pid: 20, procs: 4, startedAt: seconds(NOW - 60_000), mem: 120e6, peakMem: 121e6, tot: { cpuS: 1, energyJ: 1.5, netIn: 3_000, netOut: 2_000, netActiveS: 1 } },
    { id: 'monitor', kind: 'monitor', label: 'Session Monitor', pid: 30, procs: 1, startedAt: seconds(NOW - 60_000), mem: 19e6, peakMem: 19e6, cpuPct: 2, tot: { cpuS: 0.2, energyJ: 0.1 } },
  ],
  ended: [
    { id: 'p:40:2', kind: 'bash', label: COMMAND, cmd: COMMAND, pid: 40, procs: 0, startedAt: seconds(NOW + 5), endedAt: seconds(NOW + 600), mem: 0, peakMem: 9e6, tot: { cpuS: 0.3, energyJ: 1.5, energyEstJ: 0.1, netIn: 12_400_000, netOut: 30_000, diskW: 12_400_000, netActiveS: 6.5 } },
  ],
  session: { cpuS: 31.5, energyJ: 28, energyEstJ: 0.1, netIn: 12_803_000, netOut: 1_632_000, diskR: 0, diskW: 12_400_000, netActiveS: 27.5, mem: 439e6, cpuPct: 6, watts: 0.5, netInBps: 2_100_000, netOutBps: 9_000 },
  reaped: { cpuS: 0, energyEstJ: 0 },
  system: { netInBps: 2_500_000, netOutBps: 20_000, netIn: 20e6, netOut: 2e6, cpuPct: 23.4, memUsed: 10.5e9, memTotal: 16 * 1024 ** 3, latencyMs: 38.2 },
  jPerCpuS: 1.2,
}

// --- sources by task ---
export const TASK_PAGE = 'https://news.example.net/post'
export const TASK_AGENT = 'check the guide'
// --- end sources by task ---

/** Each tool's answer, as the engine records it. */
export const answer = (args: { tool: string; [key: string]: unknown }, files: Set<string>): ToolCallResult => {
  // --- sources by task ---
  // A fetch of TASK_PAGE answers with that page; the Agent call TASK_AGENT describes launches sub-agent `a2`.
  if (args.tool === 'WebFetch' && args.url === TASK_PAGE) {
    return { result: { url: TASK_PAGE, code: 200, bytes: 2_048, durationMs: 120 }, text: 'news', isReadOnly: true }
  }
  if (args.tool === 'Agent' && args.description === TASK_AGENT) {
    return { result: { status: 'async_launched', agentId: 'a2', description: TASK_AGENT, prompt: String(args.prompt), outputFile: '/tmp/a2' }, text: 'launched' }
  }
  // --- end sources by task ---
  switch (args.tool) {
    case 'Bash':
      return { result: { stdout: 'downloaded data.zip', stderr: '' }, text: 'downloaded data.zip\n12.4 MB' }
    case 'Read':
      return { result: { type: 'text' }, text: 'print("hi")', isReadOnly: true }
    case 'Write':
      files.add(String(args.file_path))
      return { result: { type: 'create' }, text: 'written' }
    case 'WebFetch':
      return { result: { url: 'https://docs.example.com/guide', code: 200, codeText: 'OK', bytes: 5_120, durationMs: 340, result: 'summary' }, text: 'summary', isReadOnly: true }
    case 'WebSearch':
      if (searchScript.hits > 0) {
        const query = String(args.query)
        const slug = query.replace(/[^a-z0-9]+/gi, '-')
        const content = Array.from({ length: searchScript.hits }, (_, at) => ({ title: `${query}: result ${at + 1}`, url: `https://${SEARCH_SITES[at % SEARCH_SITES.length] ?? 'example.com'}/${slug}/${at}` }))
        return { result: { query, results: [{ tool_use_id: 's', content }], durationSeconds: 1.5 }, text: 'results', isReadOnly: true }
      }
      return {
        result: {
          query: 'spy options',
          results: [{ tool_use_id: 's', content: [{ title: 'Options basics', url: 'https://learn.example.org/options' }, { title: 'SPY', url: 'https://docs.example.com/spy' }] }],
          durationSeconds: 1.5,
        },
        text: 'results',
        isReadOnly: true,
      }
    // --- agents ---
    case 'Agent':
      if (args.description === AGENT_TASK) {
        return { result: { status: 'async_launched', agentId: AGENT_ID, description: AGENT_TASK, prompt: String(args.prompt), outputFile: '/tmp/agent.out' }, text: 'launched' }
      }
      return { result: { ok: true }, text: 'ok' }
    case 'Workflow':
      return { result: { status: 'async_launched', taskId: WORKFLOW_TASK, runId: WORKFLOW_RUN, workflowName: 'review-pr' }, text: 'launched' }
    // --- end agents ---
    case 'Glob':
      return { result: { ok: true }, text: GLOB_OUTPUT, isReadOnly: true }
    case 'Artifact':
      return { result: { ok: true }, text: `Published ${ARTIFACT_URL}` }
    default:
      return { result: { ok: true }, text: 'ok' }
  }
}

/** What each model request reports using (null: no usage), and the 5-hour limit the session reads; reset by `world`. */
export const stepUsage: { value: TurnUsage | null } = { value: null }
/** What each model request answers: its text, and the tools it asks for. */
export const stepReply: { answer: string; toolUses: { name: string; input: unknown }[] } = { answer: '', toolUses: [] }
export const GLOB_OUTPUT = 'hooks/lib/flow.ts\nhooks/lib/spend.ts'
/** What the small model answers when the monitor asks it to title a prompt, and every prompt it was asked. */
export const summaryModel: { reply: string; asked: string[] } = { reply: 'Fix the flaky login test', asked: [] }
export const SESSION_ID = 'session-1111'
/** The plugin's `$.store`, in memory: a test seeds it before the session starts and reads what was kept. */
export const memoryStore = new Map<string, unknown>()
export const limits: { percentUsed: number; resetsAt?: string } = { percentUsed: 40 }
export const ARTIFACT_URL = 'https://claude.ai/code/artifact/0f9e8d7c-1111-2222-3333-444455556666'

/** Ticks the sampler sends after TICK, a second apart; set by a test before the session starts, reset by `world`. */
export const laterTicks: { value: Record<string, unknown>[] } = { value: [] }

/** The Mac's RAM as `sysctl -n hw.memsize` answers in the world: 16 GB. */
export const RAM = 16 * 1024 ** 3
/** What the plugin copied to the clipboard, oldest first; reset by `world`. */
export const clipboard: { texts: string[] } = { texts: [] }
/** The `osascript` runs a Find pressed, and what they answer (by default it fails, as without Accessibility access); reset by `world`. */
export const keystrokes: { runs: string[][]; answer: ProcessRunResult } = { runs: [], answer: fail() }

/** The `/config` Model row the engine lists, the values set on it, and the `/effort` levels run; reset by `world`. */
export const settingsWorld: { model: string; isLocked: boolean; sets: string[]; efforts: string[] } = { model: 'opus', isLocked: false, sets: [], efforts: [] }
export const MODEL_OPTIONS = ['default', 'sonnet', 'opus', 'haiku', 'fable', 'opus[1m]']

/** The lines the plugin wrote to the debug log (`$.ui.log`), in order; reset by `world`. */
export const debugLines: string[] = []

/** The width each open of the pane asked for (undefined where it asked none), oldest first; reset by `world`. */
export const paneOpens: (number | undefined)[] = []

// --- session history ---
/**
 * What sampler/transcripts.py answers: the project's sessions for `list`, a
 * session by its id for `read` (a missing one fails), the agents asked for
 * that it has for `agents` (`failsAgents`: it fails); reset by `world`.
 */
export const transcripts: {
  list: TranscriptSummary[]
  sessions: Map<string, TranscriptSession>
  agents: Map<string, TranscriptAgent>
  failsAgents: boolean
  /** The `cache` answer, as the reader prints it; undefined: it fails. */
  cache: unknown
  runs: string[][]
} = {
  list: [],
  sessions: new Map(),
  agents: new Map(),
  failsAgents: false,
  cache: undefined,
  runs: [],
}

const readerAnswer = (argv: readonly string[]): ProcessRunResult => {
  transcripts.runs.push([...argv.slice(3)])
  const [verb, , id, ...agentIds] = argv.slice(3)
  if (verb === 'list') {
    return ok(JSON.stringify(transcripts.list))
  }
  if (verb === 'cache') {
    return transcripts.cache === undefined ? fail() : ok(JSON.stringify(transcripts.cache))
  }
  if (verb === 'agents') {
    return transcripts.failsAgents ? fail() : ok(JSON.stringify({ agents: agentIds.flatMap(agentId => transcripts.agents.get(agentId) ?? []) }))
  }
  const session = id === undefined ? undefined : transcripts.sessions.get(id)
  return session === undefined ? fail() : ok(JSON.stringify(session))
}
// --- end session history ---

/** The battery as `ioreg` prints it; the test drains it between readings. */
export const pack = { percent: 50, mah: 3_500 }

export const ioreg = (): string =>
  [
    '+-o AppleSmartBattery  <class AppleSmartBattery>',
    '    {',
    `      "CurrentCapacity" = ${pack.percent}`,
    `      "AppleRawCurrentCapacity" = ${pack.mah}`,
    '      "AppleRawMaxCapacity" = 7000',
    '      "Voltage" = 11000',
    '      "Amperage" = 18446744073709550716',
    '      "IsCharging" = No',
    '      "ExternalConnected" = No',
    '      "TimeRemaining" = 120',
    '    }',
  ].join('\n')

/** Everything beneath the plugin: clock, store, git, the sampler, the files, the session and the surface. */
export const world = (on: On, toasts: string[] = []): ReturnType<typeof mock.clock> => {
  const clock = mock.clock(on, { now: NOW })
  const files = new Set(['/Library/Developer/CommandLineTools/usr/bin/python3', '/repo/src/app.py'])
  pack.percent = 50
  pack.mah = 3_500
  stepUsage.value = null
  stepReply.answer = ''
  stepReply.toolUses = []
  memoryStore.clear()
  summaryModel.reply = 'Fix the flaky login test'
  summaryModel.asked = []
  limits.percentUsed = 40
  limits.resetsAt = undefined
  weekly.percentUsed = undefined
  weekly.resetsAt = undefined
  laterTicks.value = []
  clipboard.texts = []
  keystrokes.runs = []
  keystrokes.answer = fail()
  transcripts.list = []
  paneOpens.length = 0
  debugLines.length = 0
  on('ui.log', ($, e) => {
    debugLines.push(e.text)
    return { value: undefined }
  })
  gitScript.log = LOG
  searchScript.hits = 0
  gitScript.diff = DIFF
  settingsWorld.model = 'opus'
  settingsWorld.isLocked = false
  settingsWorld.sets = []
  settingsWorld.efforts = []
  on('config.list', () => ({ value: [{ key: 'model', label: 'Model', kind: 'choice' as const, value: settingsWorld.model, options: MODEL_OPTIONS, provider: { plugin: 'engine', tier: 'core' as const }, isLocked: settingsWorld.isLocked }] }))
  on('config.set', ($, e) => {
    settingsWorld.sets.push(String(e.value))
    settingsWorld.model = String(e.value)
    return { value: e.value }
  })
  on('command.run', { command: 'model' }, ($, e) => {
    settingsWorld.sets.push(e.args)
    settingsWorld.model = e.args
    return { text: `Set model to ${e.args}` }
  })
  on('command.run', { command: 'effort' }, ($, e) => {
    settingsWorld.efforts.push(e.args)
    return { text: `Set effort level to ${e.args}` }
  })
  transcripts.sessions = new Map()
  transcripts.agents = new Map()
  transcripts.failsAgents = false
  transcripts.cache = undefined
  transcripts.runs = []
  on('store.get', ($, e) => ({ value: memoryStore.get(e.key) }))
  on('store.set', ($, e) => {
    memoryStore.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    memoryStore.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...memoryStore.keys()] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', ($, e) => {
    if (e.argv[2]?.endsWith('sampler/transcripts.py') === true) {
      return { value: readerAnswer(e.argv) }
    }
    if (e.argv[0] === 'osascript') {
      keystrokes.runs.push([...e.argv])
      return { value: keystrokes.answer }
    }
    return { value: e.argv[0] === 'ioreg' ? ok(ioreg()) : e.argv[0] === 'sysctl' ? ok(`${RAM}\n`) : git(e.argv) }
  })
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 10, mtimeMs: NOW - 5_000, isLink: false } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: stepReply.answer,
      toolUses: [...stepReply.toolUses],
      stopReason: stepReply.toolUses.length > 0 ? ('tool_use' as const) : ('end_turn' as const),
      usage: stepUsage.value,
    }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: `${JSON.stringify({ type: 'hello', root: 10, self: 30, ncpu: 8, t: seconds(NOW) })}\n` }
    await clock.sleep(1_000)
    yield { stream: 'stdout' as const, text: `${JSON.stringify(TICK)}\n` }
    for (const later of laterTicks.value) {
      await clock.sleep(1_000)
      yield { stream: 'stdout' as const, text: `${JSON.stringify(later)}\n` }
    }
    await clock.sleep(1e9)
    return { value: { code: 0, signal: null } }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => ({ value: e.path === '/outside/notes.md' ? '# Notes\nfirst line' : '' }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW - 3_600_000,
      context: { tokens: 50_000, window: 200_000, percent: 25 },
      rateLimits: [{ kind: 'five_hour', percentUsed: limits.percentUsed, ...(limits.resetsAt !== undefined ? { resetsAt: limits.resetsAt } : {}) }, ...weeklyLimit()],
      cost: { usd: 1.23 },
    },
  }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: SESSION_ID }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.repo', () => ({ value: { root: '/repo', remote: null, internal: false, name: null } }))
  on('model.complete', ($, e) => {
    summaryModel.asked.push(e.prompt)
    const usage = { input_tokens: 40, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { value: { isAnswered: true as const, text: summaryModel.reply, usage } }
  })
  on('session.turns', () => ({ value: 7 }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    paneOpens.push(e.columns)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    clipboard.texts.push(e.text)
    return { value: { isCopied: true as const } }
  })
  on('tool.call', ($, e) => answer(e, files))
  return clock
}

export type ToolArgs = { tool: string; [argument: string]: unknown }

/**
 * Calls a tool as the model would. `$.tool.call` is typed over every tool's
 * input, the connected MCP servers' included (hundreds here), which is deeper
 * than the checker instantiates; the test calls it through this plain shape.
 */
export const call = async ($: Engine, args: ToolArgs): Promise<ToolCallResult> => {
  const invoke = $.tool.call as unknown as (input: ToolArgs) => Promise<ToolCallResult>
  return invoke(args)
}

export const run = async ($: Engine, command: string, args: string): Promise<string> =>
  (await $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })).text ?? ''

export const PANE = {
  plugin: PLUGIN,
  component: 'Pane' as const,
  requestId: 'session-monitor',
  props: {
    title: 'Session Monitor',
    isFocused: false,
    bodyColumns: 120,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
}

export const start = async ($: Engine, clock: ReturnType<typeof mock.clock>): Promise<void> => {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.turn.start({ text: 'fetch the data', turnId: 't1' })
  await clock.settle()
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 3 })) {
    expect(chunk).toBeDefined()
  }
  await clock.settle()
  await call($, { tool: 'Read', file_path: '/repo/src/app.py' })
  await call($, { tool: 'Write', file_path: '/outside/notes.md', content: '# Notes' })
  await call($, { tool: 'WebSearch', query: 'spy options', mode: 'standard' })
  await call($, { tool: 'WebFetch', url: 'https://docs.example.com/guide', prompt: 'summarize' })
  await call($, { tool: 'Bash', command: COMMAND, description: 'Fetch the data' })
  await clock.advance(1_000)
  await clock.advance(1_000)
  await clock.settle()
  // 10 mAh at 11 V is 396 J drained; the session's work came to 28.1 J of it.
  pack.percent = 49
  pack.mah = 3_490
  await $.turn.complete({ answer: 'done', durationMs: 2_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  await clock.advance(10_000)
  await clock.settle()
}

export type Clickable = {
  pointer: (event: { type: 'down' | 'up'; x: number; y: number; button: 'left'; in: string }) => Promise<void>
}

/** A click on a row's region: on the title, past the badges and times. */
export const clickRow = async (ui: Clickable, key: string, x = 40): Promise<void> => {
  await ui.pointer({ type: 'down', x, y: 0, button: 'left', in: key })
  await ui.pointer({ type: 'up', x, y: 0, button: 'left', in: key })
}

// --- ui polish ---
export type Hoverable = {
  pointer: (event: { type: 'enter' | 'leave' | 'move'; x: number; y: number; in: string }) => Promise<void>
}

/** The pointer moving onto a row's region (`enter`) or off it (`leave`). */
export const hoverRow = async (ui: Hoverable, key: string, type: 'enter' | 'leave' | 'move'): Promise<void> => {
  await ui.pointer({ type, x: 30, y: 0, in: key })
}

export type Findable = { find: (query: ElementQuery) => Promise<FoundElement | undefined> }

/** Whether a row draws open: no arrow or word any more, an accent bar leads it. */
export const isOpenRow = async (ui: Findable, key: string): Promise<boolean> =>
  (await ui.find({ in: key, type: 'Text', text: OPEN_BAR })) !== undefined
// --- ui polish ---

export type FindsAll = { findAll: (query: ElementQuery) => Promise<FoundElement[]> }

/** What an open file or diff draws: the engine's Code (the terminal), the SVG code view (elsewhere), or nothing. */
export type ShownCode = { kind: 'code' | 'view' | 'none'; text: string; format?: unknown; svg: string }

/** The SVG code view's documents: the Svg elements set in the editor's monospace font. */
const CODE_FONT = 'font-family="ui-monospace'

export const shownCode = async (ui: FindsAll): Promise<ShownCode> => {
  const code = (await ui.findAll({ type: 'Code' }))[0]
  if (code !== undefined) {
    return { kind: 'code', text: String(code.props.source ?? ''), format: code.props.format, svg: '' }
  }
  const svg = (await ui.findAll({ type: 'Svg' }))
    .map(found => String(found.props.source ?? ''))
    .filter(source => source.includes(CODE_FONT))
    .join('')
  if (svg === '') {
    return { kind: 'none', text: '', svg: '' }
  }
  // The text the view draws, tags gone, its no-break spaces read as spaces.
  const text = svg
    .replace(/<[^>]*>/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
  return { kind: 'view', text, svg }
}

export type Drawable = { drawn: () => Promise<unknown> }

/** A tab's button: in the pane's own tree, or in the desktop app's tab bar, a Client (view/tab-bar.tsx). */
export const tabButton = async (ui: Findable, tab: string): Promise<FoundElement | undefined> =>
  (await ui.find({ key: `tab:${tab}` })) ??
  ((await ui.find({ type: 'Client', key: TAB_BAR_KEY })) === undefined ? undefined : await ui.find({ key: `tab:${tab}`, in: TAB_BAR_KEY }))

const isNode = (value: unknown): value is { type?: unknown; props?: unknown; children?: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value)

const propsOf = (node: { props?: unknown }): Record<string, unknown> => (typeof node.props === 'object' && node.props !== null ? { ...node.props } : {})

const childrenOf = (node: { children?: unknown }): unknown[] => (Array.isArray(node.children) ? node.children : [])

/** A Text's whole string, its nested Texts' included. */
const fullText = (node: unknown): string =>
  typeof node === 'string' ? node : isNode(node) ? childrenOf(node).map(fullText).join('') : ''

/** The first element of a tree keyed `key`, depth first. */
const keyedNode = (node: unknown, key: string): unknown => {
  if (!isNode(node)) {
    return undefined
  }
  if (propsOf(node).key === key) {
    return node
  }
  for (const child of childrenOf(node)) {
    const found = keyedNode(child, key)
    if (found !== undefined) {
      return found
    }
  }
  return undefined
}

/** Every Text's string and Markdown's text in a tree, in document order; a Button's label as `[label]`. */
const textsOf = (node: unknown, out: string[]): string[] => {
  if (!isNode(node)) {
    return out
  }
  if (node.type === 'Text') {
    out.push(fullText(node))
    return out
  }
  const props = propsOf(node)
  if (node.type === 'Markdown' && typeof props.text === 'string') {
    out.push(props.text)
  }
  if (node.type === 'Button' && typeof props.label === 'string') {
    out.push(`[${props.label}]`)
  }
  for (const child of childrenOf(node)) {
    textsOf(child, out)
  }
  return out
}

/** The texts drawn inside the element keyed `key` (a card's Box), in order; empty when none is drawn. */
export const textsIn = async (ui: Drawable, key: string): Promise<string[]> => {
  const node = keyedNode(await ui.drawn(), key)
  return node === undefined ? [] : textsOf(node, [])
}

/** The keys of the drawn elements whose key starts with `prefix`, in document order. */
export const keysOf = async (ui: Drawable, prefix: string): Promise<string[]> => {
  const keys: string[] = []
  const walk = (node: unknown): void => {
    if (!isNode(node)) {
      return
    }
    const key = propsOf(node).key
    if (typeof key === 'string' && key.startsWith(prefix)) {
      keys.push(key)
    }
    childrenOf(node).forEach(walk)
  }
  walk(await ui.drawn())
  return keys
}

/**
 * The kit draws no conversation: a scroll to one of its rows rejects as
 * having nothing to answer it. A jump that asked for one ends in this toast,
 * which is how a test sees that a press asked.
 */
export const scrollAsked = (summary: string): string => `Could not scroll to “${summary}”: no implementation for ui.scroll.`

/** The toast a jump ends in where the conversation cannot be scrolled (the desktop): the prompt's opening copied for ⌘F. */
export const findAsked = (snippet: string): string => `Copied “${snippet}”. Press ⌘F, then ⌘V, to find this prompt in the conversation.`

/** The keys of the elements drawn inside the element keyed `key` (a card's Box) that start with `prefix`, in document order. */
export const keysIn = async (ui: Drawable, key: string, prefix: string): Promise<string[]> => {
  const keys: string[] = []
  const walk = (node: unknown): void => {
    if (!isNode(node)) {
      return
    }
    const own = propsOf(node).key
    if (typeof own === 'string' && own.startsWith(prefix)) {
      keys.push(own)
    }
    childrenOf(node).forEach(walk)
  }
  walk(keyedNode(await ui.drawn(), key))
  return keys
}

// --- prompts ---
/** The weekly (`seven_day`) window `session.usage` answers beside the 5-hour one: none until a test sets its percent; reset by `world`. */
export const weekly: { percentUsed?: number; resetsAt?: string } = {}

/** The weekly window's entry in `session.usage`'s rate limits, when a test set one. */
export const weeklyLimit = (): { kind: string; percentUsed: number; resetsAt?: string }[] =>
  weekly.percentUsed === undefined ? [] : [{ kind: 'seven_day', percentUsed: weekly.percentUsed, ...(weekly.resetsAt !== undefined ? { resetsAt: weekly.resetsAt } : {}) }]

/**
 * The engine's answers beneath the prompt events the plugin watches: a
 * submission enters as typed, an injected text is read as written, a
 * measurement echoes what moved.
 */
export const promptEvents = (on: On): void => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  on('session.measure', ($, e) => ({ changed: [...e.changed] }))
}
// --- end prompts ---

// --- overview prompts ---
/**
 * The kit scrolls no pane either: a click on an Overview prompt's title opens
 * the Prompts tab, then tries a few times to scroll to the prompt's card as
 * the tab is drawn, and ends in this toast, which is how a test sees it asked.
 */
export const cardScrollAsked = (summary: string): string => `Could not scroll to “${summary}” on the Prompts tab: no implementation for ui.scroll.`
// --- end overview prompts ---

/** A row drawn under `key`: its own props, and its child Boxes' props. */
export type DrawnRow = { props: Record<string, unknown>; boxes: Record<string, unknown>[] }

/** Every Box laid out as a row under `key`, with the Boxes it holds. */
export const rowsIn = async (ui: Drawable, key: string): Promise<DrawnRow[]> => {
  const rows: DrawnRow[] = []
  const walk = (node: unknown): void => {
    if (!isNode(node)) {
      return
    }
    const props = propsOf(node)
    if (node.type === 'Box' && props.flexDirection === 'row') {
      rows.push({ props, boxes: childrenOf(node).filter(child => isNode(child) && child.type === 'Box').map(child => propsOf(isNode(child) ? child : {})) })
    }
    childrenOf(node).forEach(walk)
  }
  walk(keyedNode(await ui.drawn(), key))
  return rows
}

/** The debug line Older or Newer ends in when the kit, which scrolls no pane, leaves the new page's first card (keyed `key`) unreached. */
export const pageScrollAsked = (key: string): string => `Could not scroll the pane to ${key}: no implementation for ui.scroll.`

/** What a region drawn by view/title-link.tsx says: its `text` prop. */
export const regionText = async (ui: Findable, key: string): Promise<unknown> => {
  const region = await ui.find({ key })
  const props = region?.props.props
  return typeof props === 'object' && props !== null && 'text' in props ? props.text : undefined
}
