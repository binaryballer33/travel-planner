import { describe, expect, test, type Engine, type Plugin } from 'claude-code/testing'
import { TAB_BAR_KEY } from '../hooks/view/tab-bar'

import {
  blankAgent,
  ORPHAN_QUIET_MS,
  phaseText,
  recordAgentRequest,
  recordAgentStep,
  recordAgentToolCall,
  recordAgentToolEnd,
  recordAgentTurn,
  settleOrphans,
  statusNote,
} from '../hooks/lib/agents'
import { startRecord } from '../hooks/lib/commands'
import { flowHint, flowSentence, linkCalls, markRead, usesOf } from '../hooks/lib/flow'
import { emptyLive } from '../hooks/lib/commands'
import { agentKey } from '../hooks/view/agents'
import { rowBoxKey } from '../hooks/view/kit'
import { pulseKey, quickLabels, statusLine } from '../hooks/view/pane'
import type { CommandRecord, LiveMetrics, Pulse, SamplerStatus, SystemMetrics } from '../types'
import { call, clickRow, GLOB_OUTPUT, laterTicks, NOW, PANE, RAM, run, seconds, stepReply, textsIn, TICK, world, tabButton } from './world'

const done = (id: string, tool: string, input: Record<string, unknown>, endedAt: number): CommandRecord => ({
  ...startRecord(id, tool, input, endedAt - 10, undefined, 'engine'),
  status: 'ok',
  endedAt,
})

describe('flow', () => {
  test('a later call reuses the bits of an output it repeats, not the ones the earlier call already held', () => {
    const output = 'hooks/lib/flow.ts:12: export const usesOf = …\nhooks/lib/spend.ts:3: import'
    expect(usesOf(output, '{"file_path":"hooks/lib/flow.ts"}', 'grep -rn usesOf hooks')).toEqual(['hooks/lib/flow.ts'])
    // The pattern the grep searched for is in its matches; repeating it is no reuse.
    expect(usesOf(output, '{"pattern":"usesOf"}', 'grep -rn usesOf hooks')).toEqual([])
    expect(usesOf('line 1346 of register.tsx', "sed -n '1346,1380p' register.tsx", 'grep -n finish')).toEqual(['register.tsx', '1346'])
  })

  test('reading outputs, then linking the calls that came of them, both ways', () => {
    const glob = done('g', 'Glob', { pattern: '**/*.ts' }, NOW)
    const read = { ...startRecord('r', 'Read', { file_path: 'hooks/lib/flow.ts' }, NOW + 2_000, undefined, 'engine') }
    let list = markRead([glob], new Set(['g']), { at: NOW + 1_500, said: 'Two files; reading the first.', asked: ['Read'] })
    list = linkCalls([...list, read], 'r', [{ id: 'g', uses: ['hooks/lib/flow.ts'] }])
    const [first, second] = list
    expect(first?.flow).toMatchObject({ readAt: NOW + 1_500, said: 'Two files; reading the first.', asked: ['Read'], isLast: false })
    expect(first?.flow?.next).toEqual([{ id: 'r', tool: 'Read', summary: 'Reads flow.ts', uses: ['hooks/lib/flow.ts'] }])
    expect(second?.flow?.after).toEqual([{ id: 'g', tool: 'Glob', summary: 'Finds files matching **/*.ts', uses: ['hooks/lib/flow.ts'] }])
    expect(flowHint(first ?? glob)).toBe('→ Reads flow.ts (used its output)')
    expect(flowSentence(first ?? glob)).toBe(
      'Claude read its output 1.5 s after it finished and then ran “Reads flow.ts”; “Reads flow.ts” reused “hooks/lib/flow.ts” from it.',
    )
    expect(flowSentence(second ?? read)).toBe(
      'Claude made it after reading the output of “Finds files matching **/*.ts”, reusing “hooks/lib/flow.ts” from it. It is still running.',
    )
  })

  test('an output Claude answered from, one not read yet, and a plugin’s', () => {
    const last = markRead([done('a', 'Read', { file_path: 'x.py' }, NOW)], new Set(['a']), { at: NOW + 300, said: '', asked: [] })[0]
    expect(last === undefined ? '' : flowSentence(last)).toBe('Claude read its output 300 ms after it finished and answered without another call.')
    expect(last === undefined ? '' : flowHint(last)).toBe('→ Claude answered')
    expect(flowSentence(done('b', 'Read', { file_path: 'x.py' }, NOW))).toBe('Claude has not read its output yet.')
    const plugin = { ...done('c', 'Read', { file_path: 'x.py' }, NOW), actor: { kind: 'plugin' as const, name: 'p' } }
    expect(flowSentence(plugin)).toBe('A plugin made it, so no model request reads its output.')
  })
})

describe('agent phases', () => {
  test('waiting on the model, running a tool, between steps, answered, ended', () => {
    let list = recordAgentRequest([blankAgent('a', 'subagent', 0)], 'a', 1_000)
    expect(list[0]?.phase).toEqual({ kind: 'request', since: 1_000, detail: 'request 1' })
    expect(phaseText(list[0] ?? blankAgent('a', 'subagent', 0), 4_000)).toBe('Waiting for the model to answer its request 1 (3s).')
    list = recordAgentStep(list, 'a', { model: 'm', effort: 'high', usage: null, toolNames: ['Bash'], answer: 'Let me look.', stopReason: 'tool_use' }, 2_000)
    expect(list[0]).toMatchObject({ lastAnswer: 'Let me look.', stopReason: 'tool_use', phase: { kind: 'between', detail: 'asked to run Bash' } })
    list = recordAgentToolCall(list, 'a', 2_100, 'Lists files')
    expect(phaseText(list[0] ?? blankAgent('a', 'subagent', 0), 2_600)).toBe('Running a tool: Lists files (1s).')
    list = recordAgentToolEnd(list, 'a', 'Bash', 'denied', 2_200)
    expect(phaseText(list[0] ?? blankAgent('a', 'subagent', 0), 5_200)).toBe('Its last step ended: Bash was denied; its next request is due (3s ago).')
    list = recordAgentStep(list, 'a', { model: 'm', effort: 'high', usage: null, toolNames: [], answer: 'Done.', stopReason: 'end_turn' }, 3_000)
    expect(list[0]?.phase).toMatchObject({ kind: 'answered', detail: 'stopped: end_turn' })
    list = recordAgentTurn(list, 'a', { reason: 'answer', durationMs: 2_000 }, 3_100)
    expect(list[0]).toMatchObject({ status: 'completed', phase: { kind: 'ended', detail: 'answered' } })
  })

  test('an agent Claude Code started itself is marked done once quiet, and comes back with anything new', () => {
    const start = recordAgentToolEnd(recordAgentToolCall([], 'x', 1_000, 'Prints text'), 'x', 'Bash', 'error', 1_010)
    const record = start[0] ?? blankAgent('x', 'subagent', 0)
    expect(statusNote(record, 2_000)).toMatch(/^Claude Code started this agent itself/)
    expect(settleOrphans(start, 1_010 + ORPHAN_QUIET_MS - 1)[0]?.status).toBe('running')
    const settled = settleOrphans(start, 1_010 + ORPHAN_QUIET_MS)
    expect(settled[0]).toMatchObject({ status: 'completed', endedAt: 1_010, isEndAssumed: true })
    expect(statusNote(settled[0] ?? record, 100_000)).toMatch(/^Marked done by the monitor/)
    // One waiting on the model, or spawned by an Agent call, is left alone.
    expect(settleOrphans(recordAgentRequest(start, 'x', 1_010), 1_010 + ORPHAN_QUIET_MS)[0]?.status).toBe('running')
    expect(settleOrphans([{ ...record, toolUseId: 'toolu_1' }], 1_010 + ORPHAN_QUIET_MS)[0]?.status).toBe('running')
    const back = recordAgentToolCall(settled, 'x', 200_000, 'Prints text')
    expect(back[0]).toMatchObject({ status: 'running', isEndAssumed: undefined, endedAt: undefined, toolCalls: 2 })
  })
})

/** A live view the sampler measured: the whole Mac at 23% CPU and 61% memory, 1.2 MB/s down. */
const measured = (system: Partial<SystemMetrics> = {}, status: SamplerStatus = 'running'): LiveMetrics => ({
  ...emptyLive(NOW),
  status,
  system: { netInBps: 1_200_000, netOutBps: 40_000, netIn: 5e6, netOut: 1e6, cpuPct: 23.4, memUsed: 39.3e9, memTotal: 64e9, latencyMs: 38.2, ...system },
})

describe('the status line', () => {
  test('the whole Mac and nothing else: CPU, memory, the network both ways, the latency', () => {
    expect(statusLine(measured())).toBe('CPU 23% · Mem 61% · ↓ 1.20 MB/s ↑ 40.0 kB/s · ping 38 ms')
  })

  test('without a latency (the probe failed, or has not answered yet) the line ends at the network', () => {
    expect(statusLine(measured({ latencyMs: undefined }))).toBe('CPU 23% · Mem 61% · ↓ 1.20 MB/s ↑ 40.0 kB/s')
  })

  test('a quiet CPU, a connect on the Mac itself and a slow one', () => {
    expect(statusLine(measured({ cpuPct: 4.24, latencyMs: 0.4 }))).toBe('CPU 4.2% · Mem 61% · ↓ 1.20 MB/s ↑ 40.0 kB/s · ping <1 ms')
    expect(statusLine(measured({ latencyMs: 1_234 }))).toBe('CPU 23% · Mem 61% · ↓ 1.20 MB/s ↑ 40.0 kB/s · ping 1.2 s')
  })

  test('before anything is measured every figure is a dash, and a figure not measured yet stays one', () => {
    expect(statusLine(emptyLive(NOW))).toBe('CPU — · Mem — · ↓ — ↑ —')
    // The first tick: no CPU share yet (it takes two readings), no probe back.
    expect(statusLine(measured({ cpuPct: undefined, latencyMs: undefined, netInBps: 0, netOutBps: 0 }))).toBe('CPU — · Mem 61% · ↓ 0 B/s ↑ 0 B/s')
    // An older sampler measures the network alone.
    expect(statusLine(measured({ cpuPct: undefined, memUsed: undefined, memTotal: undefined, latencyMs: undefined }))).toBe('CPU — · Mem — · ↓ 1.20 MB/s ↑ 40.0 kB/s')
  })

  test("a stopped sampler's last figures are not shown as live", () => {
    expect(statusLine(measured({}, 'error'))).toBe('CPU — · Mem — · ↓ — ↑ —')
    expect(statusLine(measured({}, 'starting'))).toBe('CPU — · Mem — · ↓ — ↑ —')
  })
})

describe('quick stats', () => {
  test('the strip’s labels', () => {
    const pulse: Pulse = { t: 1, status: 'running', netIn: 0, netOut: 0, commands: 12, running: 1, failed: 2, files: 4, sources: 9, changed: 3, plus: 40, minus: 5, prompts: 1, commits: 2, agents: 3, agentsLive: 1 }
    expect(quickLabels(pulse)).toEqual({
      overview: 'Overview',
      prompts: '1 prompt',
      commands: '12 cmds · 1 running · ✗2',
      agents: '3 agents · 1 live',
      files: '±3 files (+40 −5)',
      explorer: 'Explorer',
      commits: '2 commits',
      sources: '9 sources',
    })
    expect(quickLabels({ ...pulse, agents: 1, agentsLive: 0, prompts: 0 })).toMatchObject({ agents: '1 agent', prompts: '0 prompts' })
  })

  test('a summary is new only when what the header shows changes, not for every byte or second', () => {
    const pulse: Pulse = { t: 1, status: 'running', netIn: 1_601_234, netOut: 24_301_000, costUsd: 166.431, contextPct: 34.2, commands: 12, running: 0, failed: 0, files: 4, sources: 9 }
    const same = pulseKey(pulse)
    // A later second, a few more bytes, a fraction of a cent: the header reads the same.
    expect(pulseKey({ ...pulse, t: 99, netIn: 1_601_900, netOut: 24_302_000, costUsd: 166.433, contextPct: 34.24 })).toBe(same)
    // A figure the header shows moved.
    expect(pulseKey({ ...pulse, netIn: 1_611_000 })).not.toBe(same)
    expect(pulseKey({ ...pulse, costUsd: 166.44 })).not.toBe(same)
    expect(pulseKey({ ...pulse, commands: 13 })).not.toBe(same)
    expect(pulseKey({ ...pulse, batteryPct: 75 })).not.toBe(same)
  })
})

/** A plugin above the monitor that repeats each status line it sets as a toast, which the world records. */
const STATUS_SPY: Plugin = {
  name: 'status-spy',
  tier: 'prepend',
  register: on => {
    on('ui.status', async ($, e, next) => {
      $.ui.toast(`status: ${e.text ?? '(cleared)'}`)
      return next(e)
    })
  },
}

/** The spy's status lines, oldest first. */
const statuses = (toasts: readonly string[]): string[] => toasts.filter(text => text.startsWith('status: ')).map(text => text.slice('status: '.length))

/** As STATUS_SPY, beneath a sampler that sends one tick and exits, as a crashed one would. */
const STOPPING_SAMPLER: Plugin = {
  name: 'stopping-sampler',
  tier: 'prepend',
  register: on => {
    on('process.spawn', async function* () {
      const system = { netInBps: 1_000, netOutBps: 500, netIn: 0, netOut: 0, cpuPct: 50, memUsed: 8e9, memTotal: 16e9 }
      yield { stream: 'stdout' as const, text: `${JSON.stringify({ type: 'hello', root: 10, self: 30, ncpu: 8, t: 1_760_000_000 })}\n` }
      yield { stream: 'stdout' as const, text: `${JSON.stringify({ type: 'tick', t: 1_760_000_001, groups: [], ended: [], session: {}, reaped: {}, system, jPerCpuS: 1 })}\n` }
      yield { stream: 'stderr' as const, text: 'Traceback: boom\n' }
      return { value: { code: 1, signal: null } }
    })
    on('ui.status', async ($, e, next) => {
      $.ui.toast(`status: ${e.text ?? '(cleared)'}`)
      return next(e)
    })
  },
}

const BAND = {
  plugin: 'session-monitor',
  surface: 'terminal' as const,
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
}

const begin = async ($: Engine, clock: ReturnType<typeof world>): Promise<void> => {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.turn.start({ text: 'find the flow file', turnId: 't1' })
}

const step = async ($: Engine, turnId: string, index: number): Promise<void> => {
  for await (const chunk of $.turn.step({ turnId, index, model: 'claude-opus-5-5', effort: 'high', messageCount: 3 })) {
    expect(chunk).toBeDefined()
  }
}

describe('the pane', () => {
  test('the strip above the prompt counts commands, changed files and sources; a press opens that tab', { timeoutMs: 30_000 }, async ($, on) => {
    // The engine's own band, drawn when the mod passes.
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box' as const, props: { key: 'engine-band' } }))
    const clock = world(on)
    await begin($, clock)
    await call($, { tool: 'Read', file_path: '/repo/src/app.py' })
    await clock.advance(11_000)
    await clock.settle()
    const band = await $.ui.mount(BAND)
    // Prompts, commands, agents, files, the explorer, commits, sources: each a button to its tab.
    const order = (await band.findAll({ type: 'Button' })).map(button => button.key ?? '')
    expect(order).toEqual(['qs:overview', 'qs:prompts', 'qs:agents', 'qs:commands', 'qs:commits', 'qs:files', 'qs:explorer', 'qs:sources'])
    expect((await band.find({ key: 'qs:explorer' }))?.props.label).toBe('Explorer')
    expect((await band.find({ key: 'qs:overview' }))?.props.label).toBe('Overview')
    expect((await band.find({ key: 'qs:prompts' }))?.props.label).toBe('1 prompt')
    expect((await band.find({ key: 'qs:agents' }))?.props.label).toBe('0 agents')
    expect((await band.find({ key: 'qs:commits' }))?.props.label).toMatch(/^\d+ commits?$/)
    expect((await band.find({ key: 'qs:commands' }))?.props.label).toBe('1 cmds')
    expect((await band.find({ key: 'qs:files' }))?.props.label).toMatch(/^±\d+ files/)
    expect((await band.find({ key: 'qs:sources' }))?.props.label).toBe('0 sources')
    await band.press({ key: 'qs:files' })
    await clock.settle()
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await tabButton(pane, 'files'))?.props.variant).toBe('primary')
    for (const tab of ['prompts', 'agents', 'commits', 'commands', 'explorer', 'overview'] as const) {
      await clock.advance(1_000)
      await band.press({ key: `qs:${tab}` })
      await clock.settle()
      expect((await tabButton(pane, tab))?.props.variant).toBe('primary')
    }
    // `/monitor bar off` hides it, and a survey takes the band.
    await $.command.run({ command: 'session-monitor', args: 'bar off', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
    expect(await (await $.ui.mount(BAND)).find({ key: 'qs:files' })).toBeUndefined()
    await $.command.run({ command: 'session-monitor', args: 'bar on', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
    expect(await (await $.ui.mount(BAND)).find({ key: 'qs:files' })).toBeDefined()
    expect(await (await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true } })).find({ key: 'qs:files' })).toBeUndefined()
  })

  test('scrolled down, the tabs scroll away with the pane: no copy of them follows', { timeoutMs: 30_000 }, async ($, on) => {
    const clock = world(on)
    await begin($, clock)
    const scrolled = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, scroll: { offset: 30, bodyRows: 60 } } })
    expect(await scrolled.find({ key: 'sticky-tabs' })).toBeUndefined()
    // One tab bar (in the desktop app a Client region), one Commands button in it.
    expect(await scrolled.findAll({ type: 'Client', key: TAB_BAR_KEY })).toHaveLength(1)
    expect(await scrolled.findAll({ key: 'tab:commands', in: TAB_BAR_KEY })).toHaveLength(1)
    expect((await scrolled.findAll({ type: 'Box' })).some(box => box.props?.position === 'absolute')).toBe(false)
    await clock.advance(1_000)
    await scrolled.unmount()
  })

  test("a command's details tell its flow: what led to it, when Claude read it, and what came next", { timeoutMs: 30_000 }, async ($, on) => {
    const clock = world(on)
    await begin($, clock)
    stepReply.toolUses = [{ name: 'Glob', input: { pattern: '**/*.ts' } }]
    await step($, 't1', 0)
    await call($, { tool: 'Glob', pattern: '**/*.ts', tool_use_id: 'toolu_glob' })
    await clock.advance(1_000)
    stepReply.answer = 'Two files; reading the flow one.'
    stepReply.toolUses = [{ name: 'Read', input: { file_path: 'hooks/lib/flow.ts' } }]
    await step($, 't1', 1)
    await call($, { tool: 'Read', file_path: 'hooks/lib/flow.ts', tool_use_id: 'toolu_read' })
    await clock.settle()
    expect(GLOB_OUTPUT).toContain('hooks/lib/flow.ts')

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:commands' })
    // The row's second line, plain text under its region, says where its output went.
    expect((await textsIn(ui, rowBoxKey('cmd:toolu_glob'))).some(text => /→ Reads flow\.ts \(used its output\)/.test(text))).toBe(true)
    await clickRow(ui, 'cmd:toolu_glob')
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: 'Flow' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Claude read its output 1\.0 s after it finished and then ran “Reads flow\.ts”/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '“Two files; reading the flow one.”' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' · reused “hooks/lib/flow.ts”' })).toBeDefined()
    // Open goes to the next call, which says what led to it.
    const open = (await ui.findAll({ type: 'Button' })).find(button => button.key?.startsWith('flow:') === true)
    await ui.press({ key: open?.key ?? '' })
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: /^Claude made it after reading the output of “Finds files matching \*\*\/\*\.ts”, reusing “hooks\/lib\/flow\.ts”/ })).toBeDefined()
    // Memory: measured or said why not.
    expect(await ui.find({ type: 'Text', text: 'inside Claude’s own process' })).toBeDefined()
  })

  test('an agent Claude Code started itself: what it is doing, why it shows running, and done once quiet', { timeoutMs: 30_000 }, async ($, on) => {
    on('agent.list', () => ({ value: [] }))
    on('classic.Stop', () => ({}))
    const clock = world(on)
    await begin($, clock)
    await call($, { tool: 'Bash', command: 'echo "suggestion mode: no tool needed"', description: 'Prints text', agentId: 'a558307f', tool_use_id: 'toolu_echo' })
    await clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:agents' })
    await clickRow(ui, agentKey('a558307f'))
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: /^Its last step ended: Bash finished; its next request is due/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Claude Code started this agent itself/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Claude Code itself' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'no' })).toBeDefined()
    // Each tool call is a row as Commands draws it, saying how it ended; a click opens what it returned, here.
    expect((await ui.find({ in: 'cmd:toolu_echo', type: 'Text', text: '✓' }))?.props.color).toBe('success')
    await clickRow(ui, 'cmd:toolu_echo')
    await clock.settle()
    expect(await ui.find({ type: 'Code', text: /downloaded data\.zip/ })).toBeDefined()

    await clock.advance(ORPHAN_QUIET_MS + 3_000)
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: 'Done (end not reported)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Marked done by the monitor/ })).toBeDefined()
  })

  test("the strip's memory shows its share of the RAM: the sampler's figure, else sysctl's", { timeoutMs: 30_000 }, async ($, on) => {
    const clock = world(on)
    // The sampler's next ticks: one that measures twice the RAM, then two from an older sampler that measures none.
    const { memTotal, ...older } = TICK.system
    expect(memTotal).toBe(RAM)
    laterTicks.value = [
      { ...TICK, t: seconds(NOW + 2_000), system: { ...TICK.system, memTotal: 2 * RAM } },
      { ...TICK, t: seconds(NOW + 3_000), system: older },
      { ...TICK, t: seconds(NOW + 4_000), system: older },
    ]
    await begin($, clock)
    await clock.advance(1_000)
    await clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    // The session's 439 MB of the 16 GB the sampler measured.
    expect(await ui.find({ type: 'Text', text: 'Mem 439 MB (2.6%)' })).toBeDefined()
    await clock.advance(1_000)
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: 'Mem 439 MB (1.3%)' })).toBeDefined()
    // Without the sampler's figure: the RAM `sysctl hw.memsize` reported at the start.
    await clock.advance(2_000)
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: 'Mem 439 MB (2.6%)' })).toBeDefined()
  })

  test('the status line follows the whole Mac tick by tick, and clears when the monitor is paused', { timeoutMs: 30_000, plugins: [STATUS_SPY] }, async ($, on) => {
    const toasts: string[] = []
    const clock = world(on, toasts)
    // The second tick: the CPU quieter, and the latency probe failing.
    const { latencyMs, ...unprobed } = TICK.system
    expect(latencyMs).toBe(38.2)
    laterTicks.value = [{ ...TICK, t: seconds(NOW + 2_000), system: { ...unprobed, cpuPct: 4.24 } }]
    await begin($, clock)
    await clock.advance(2_000)
    await clock.settle()
    expect(statuses(toasts)).toEqual(['CPU 23% · Mem 61% · ↓ 2.50 MB/s ↑ 20.0 kB/s · ping 38 ms', 'CPU 4.2% · Mem 61% · ↓ 2.50 MB/s ↑ 20.0 kB/s'])
    await run($, 'session-monitor', 'off')
    expect(statuses(toasts).at(-1)).toBe('(cleared)')
  })

  test('when the sampler stops, the status line shows dashes until it is back', { timeoutMs: 30_000, plugins: [STOPPING_SAMPLER] }, async ($, on) => {
    const toasts: string[] = []
    const clock = world(on, toasts)
    await begin($, clock)
    await clock.settle()
    const live = 'CPU 50% · Mem 50% · ↓ 1.00 kB/s ↑ 500 B/s'
    const dashes = 'CPU — · Mem — · ↓ — ↑ —'
    expect(statuses(toasts)).toEqual([live, dashes])
    // The monitor starts it again 3 s later: its tick is live again, until it stops again.
    await clock.advance(3_000)
    await clock.settle()
    expect(statuses(toasts)).toEqual([live, dashes, live, dashes])
  })
})
