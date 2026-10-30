import type { AgentInfo, AgentSpawnInput, TurnUsage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import type { AgentHistory, AgentRecord, CommandRecord } from '../types'
import {
  agentCounts,
  agentLabelOf,
  allCallsOf,
  ancestorsOf,
  blankAgent,
  childrenOf,
  callsOf,
  capAgents,
  effectiveStatus,
  launchWorkflow,
  layoutAgents,
  listsCall,
  mergeAgentList,
  ownersOf,
  parseWorkflowMeta,
  readAgentResult,
  readWorkflowResult,
  reconcileTasks,
  recordAgentStep,
  recordAgentToolCall,
  recordAgentTurn,
  recordSpawn,
  settleAgentCall,
  settleWorkflow,
  shellRecords,
  stopTask,
  visibleRows,
  WORKFLOW_QUIET_MS,
  type SpawnFacts,
} from '../hooks/lib/agents'
import { startRecord, finishRecord, MAX_COMMANDS } from '../hooks/lib/commands'
import { agentNetwork } from '../hooks/lib/prompts'
import { keyOf } from '../hooks/lib/format'
import { AGENT_CALLS_PAGE, agentCardKey, agentFoldKey, agentKey, agentKidsKey, agentNewerKey, agentOlderKey, AGENTS_FINISHED_KEY, AGENTS_RUNNING_KEY, AGENTS_SUMMARY_KEY, unseenText } from '../hooks/view/agents'
import { commandCardKey } from '../hooks/view/commands'
import { agentCardKeyOf, agentItemKey, CALL_BACKGROUND, CALL_EDGE, PARENT_BACKGROUND, rowBoxKey } from '../hooks/view/kit'
import { AGENT_ID, AGENT_TASK, call, clickRow, isOpenRow, keysIn, keysOf, NOW, PANE, SESSION_ID, start, textsIn, transcripts, WORKFLOW_RUN, world, tabButton } from './world'

const T0 = 1_760_000_000_000

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0): TurnUsage => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  model: 'claude-haiku-4-5',
})

const info = (id: string, status: AgentInfo['status'], extra: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  description: `task ${id}`,
  type: 'Explore',
  status,
  ...extra,
})

const spawn = (agentId: string, extra: Partial<SpawnFacts> = {}): SpawnFacts => ({
  agentId,
  toolUseId: `toolu_${agentId}`,
  description: `Explore ${agentId}`,
  subagentType: 'Explore',
  model: 'claude-haiku-4-5',
  isBackground: true,
  isTeammate: false,
  ...extra,
})

const byId = (list: readonly AgentRecord[], id: string): AgentRecord => {
  const found = list.find(one => one.id === id)
  if (found === undefined) {
    throw new Error(`no record ${id}`)
  }
  return found
}

/** A parent's fold, a region: what it says. */
const foldLabel = async (ui: { find: (query: { key: string }) => Promise<{ props: Record<string, unknown> } | undefined> }, id: string): Promise<unknown> => {
  const region = await ui.find({ key: agentFoldKey(id) })
  const props = region?.props.props
  return typeof props === 'object' && props !== null && 'text' in props ? props.text : undefined
}

describe('agent.list snapshots', () => {
  test('add agents, take their status and names, and keep ones the list dropped', () => {
    let list = mergeAgentList([], [info('a1', 'running'), info('t1', 'idle', { type: 'teammate', name: 'scout', teammateId: 'scout@team' })], T0)
    expect(byId(list, 'a1')).toMatchObject({ kind: 'subagent', label: 'task a1', type: 'Explore', status: 'running', wasListed: true })
    expect(byId(list, 't1')).toMatchObject({ kind: 'teammate', label: 'scout', status: 'idle', teammateId: 'scout@team' })
    list = mergeAgentList(list, [info('a1', 'completed'), info('t1', 'idle', { type: 'teammate' })], T0 + 5_000)
    expect(byId(list, 'a1')).toMatchObject({ status: 'completed', endedAt: T0 + 5_000 })
    // Dropped from the list once ended: kept, still completed.
    list = mergeAgentList(list, [], T0 + 9_000)
    expect(byId(list, 'a1')).toMatchObject({ status: 'completed', endedAt: T0 + 5_000 })
    // A teammate that left the list has ended.
    expect(byId(list, 't1')).toMatchObject({ status: 'completed', endedAt: T0 + 9_000 })
  })

  test('a snapshot trailing the turn that ended an agent does not bring it back', () => {
    let list = mergeAgentList([], [info('a1', 'running')], T0)
    list = recordAgentTurn(list, 'a1', { reason: 'answer', durationMs: 4_000 }, T0 + 4_000)
    list = mergeAgentList(list, [info('a1', 'running')], T0 + 4_500)
    expect(byId(list, 'a1').status).toBe('completed')
    // A step means its loop runs again (a message resumed it).
    list = recordAgentStep(list, 'a1', { model: 'claude-haiku-4-5', effort: 'low', usage: null }, T0 + 6_000)
    expect(byId(list, 'a1')).toMatchObject({ status: 'running', endedAt: undefined })
  })
})

describe('steps, turns and tool calls', () => {
  test('count requests and tokens per agent, the latest request sizing it', () => {
    let list = recordAgentStep([], 'a1', { model: 'claude-haiku-4-5', effort: 'low', usage: usage(100, 50, 10_000, 2_000) }, T0)
    list = recordAgentStep(list, 'a1', { model: 'claude-haiku-4-5', effort: 'low', usage: usage(200, 80, 12_000, 0) }, T0 + 1_000)
    list = recordAgentToolCall(list, 'a1', T0 + 1_500)
    const record = byId(list, 'a1')
    expect(record).toMatchObject({ requests: 2, toolCalls: 1, model: 'claude-haiku-4-5', effort: 'low', status: 'running' })
    expect(record.tokensIn).toBe(100 + 10_000 + 2_000 + 200 + 12_000)
    expect(record.tokensOut).toBe(130)
    expect(record.contextTokens).toBe(12_280)
    expect(record.lastActivityAt).toBe(T0 + 1_500)
  })

  test('a turn ends a sub-agent by its reason, leaves a teammate idle, and fills tokens steps did not carry', () => {
    let list = recordAgentStep([], 'a1', { model: 'm', effort: 'high', usage: null }, T0)
    list = recordAgentTurn(list, 'a1', { reason: 'answer', durationMs: 3_000, usage: usage(500, 40) }, T0 + 3_000)
    expect(byId(list, 'a1')).toMatchObject({ status: 'completed', endedAt: T0 + 3_000, turns: 1, activeMs: 3_000, tokensIn: 500, tokensOut: 40 })
    list = recordAgentTurn(list, 'a2', { reason: 'error', durationMs: 10 }, T0)
    list = recordAgentTurn(list, 'a3', { reason: 'aborted', durationMs: 10 }, T0)
    expect(byId(list, 'a2').status).toBe('failed')
    expect(byId(list, 'a3').status).toBe('killed')
    list = mergeAgentList(list, [info('t1', 'running', { type: 'teammate' })], T0)
    list = recordAgentTurn(list, 't1', { reason: 'answer', durationMs: 1_000 }, T0 + 1_000)
    expect(byId(list, 't1')).toMatchObject({ status: 'idle', endedAt: undefined })
  })
})

describe('spawns and launches', () => {
  test('a spawn names the agent and nests it under the agent that spawned it', () => {
    const list = recordSpawn([], spawn('a1', { name: 'reader', parentAgentId: 'p1' }), T0)
    expect(byId(list, 'a1')).toMatchObject({ kind: 'subagent', label: 'reader', type: 'Explore', parentId: 'p1', model: 'claude-haiku-4-5', isBackground: true, toolUseId: 'toolu_a1' })
    expect(recordSpawn([], spawn('t1', { isTeammate: true }), T0)[0]?.kind).toBe('teammate')
    // What a command row calls the agent its call ran in; '' until something names it.
    expect(agentLabelOf(list, 'a1')).toBe('reader')
    expect(agentLabelOf(recordAgentToolCall([], 'zz', T0), 'zz')).toBe('')
    expect(agentLabelOf(list, 'nobody')).toBe('')
  })

  test("a workflow's agents nest under its row, made by the launch or by the first spawn", () => {
    const script = "export const meta = { name: 'review-pr', description: \"Review the PR's diff\", phases: [{ title: 'Read' }, { title: 'Judge' }] }\nawait agent('x')"
    let list = launchWorkflow([], { toolUseId: 'toolu_wf', script }, T0)
    expect(byId(list, 'toolu_wf')).toMatchObject({ kind: 'workflow', label: 'review-pr', description: "Review the PR's diff", phases: ['Read', 'Judge'], status: 'pending' })
    list = settleWorkflow(list, 'toolu_wf', readWorkflowResult({ status: 'async_launched', taskId: 'task9', runId: 'wf_1', workflowName: 'review-pr' }, false), T0 + 100)
    expect(byId(list, 'toolu_wf')).toMatchObject({ status: 'running', taskId: 'task9', runId: 'wf_1' })
    list = recordSpawn(list, spawn('w1', { toolUseId: 'toolu_wf', workflow: { runId: 'wf_1', agentIndex: 1 } }), T0 + 200)
    expect(byId(list, 'w1')).toMatchObject({ kind: 'workflow-agent', parentId: 'toolu_wf' })
    // A spawn whose launch was not seen files its workflow by the call's id.
    const orphan = recordSpawn([], spawn('w2', { toolUseId: 'toolu_other', workflow: { runId: 'wf_2', agentIndex: 1 } }), T0)
    expect(byId(orphan, 'toolu_other')).toMatchObject({ kind: 'workflow', runId: 'wf_2', status: 'running' })
    expect(byId(orphan, 'w2').parentId).toBe('toolu_other')
  })

  test('agents filed under a run before its call answered move to the call', () => {
    let list = recordSpawn([], spawn('w1', { toolUseId: '', workflow: { runId: 'wf_3', agentIndex: 1 } }), T0)
    expect(byId(list, 'w1').parentId).toBe('wf_3')
    list = settleWorkflow(list, 'toolu_wf3', { isError: false, runId: 'wf_3', taskId: 'task3' }, T0 + 50)
    expect(list.some(one => one.id === 'wf_3')).toBe(false)
    expect(byId(list, 'w1').parentId).toBe('toolu_wf3')
    expect(byId(list, 'toolu_wf3').startedAt).toBe(T0)
  })

  test('a workflow that fails to start, and the meta of a script', () => {
    const list = settleWorkflow(launchWorkflow([], { toolUseId: 'toolu_bad', name: 'deploy' }, T0), 'toolu_bad', readWorkflowResult({ status: 'async_launched', taskId: '', error: 'SyntaxError' }, false), T0 + 10)
    expect(byId(list, 'toolu_bad')).toMatchObject({ status: 'failed', label: 'deploy', description: 'SyntaxError' })
    expect(parseWorkflowMeta("export const meta = { name: `scan`, phases: ['Find', 'Fix'] }")).toEqual({ name: 'scan', description: undefined, phases: ['Find', 'Fix'] })
    expect(parseWorkflowMeta('no meta here')).toEqual({ phases: [] })
  })

  test("an Agent call's answer: finished in the foreground, launched in the background, a teammate, remote", () => {
    const call = { toolUseId: 'toolu_a', description: 'Scan repo', subagentType: 'Explore', isError: false }
    let list = recordSpawn([], spawn('a1', { toolUseId: 'toolu_a' }), T0)
    list = settleAgentCall(list, call, readAgentResult({ status: 'completed', agentId: 'a1', totalTokens: 45_000, totalToolUseCount: 12, totalDurationMs: 9_000 }), T0 + 9_000)
    expect(byId(list, 'a1')).toMatchObject({ status: 'completed', contextTokens: 45_000, toolCalls: 12, endedAt: T0 + 9_000 })
    list = settleAgentCall(list, { ...call, toolUseId: 'toolu_b' }, readAgentResult({ status: 'async_launched', agentId: 'b1', description: 'Scan repo', prompt: 'p', outputFile: '/tmp/x' }), T0)
    expect(byId(list, 'b1')).toMatchObject({ status: 'running', isBackground: true, label: 'Scan repo', type: 'Explore' })
    list = settleAgentCall(list, { ...call, toolUseId: 'toolu_c' }, readAgentResult({ status: 'teammate_spawned', agentId: 'c1', agent_id: 'c1', teammate_id: 'scout@t', name: 'scout', prompt: 'p' }), T0)
    expect(byId(list, 'c1')).toMatchObject({ kind: 'teammate', label: 'scout', teammateId: 'scout@t' })
    list = settleAgentCall(list, { ...call, toolUseId: 'toolu_d' }, readAgentResult({ status: 'remote_launched', taskId: 'r1', sessionUrl: 'u', description: 'Remote', prompt: 'p', outputFile: 'o' }), T0)
    expect(byId(list, 'r1')).toMatchObject({ taskId: 'r1', type: 'Explore', status: 'running' })
    // A failed call fails the agent its spawn started.
    list = recordSpawn(list, spawn('e1', { toolUseId: 'toolu_e' }), T0)
    list = settleAgentCall(list, { ...call, toolUseId: 'toolu_e', isError: true }, readAgentResult(undefined), T0 + 1)
    expect(byId(list, 'e1').status).toBe('failed')
  })
})

describe('ends, caps and rows', () => {
  test('TaskStop kills by id, task id or name; a Stop ends workflows no longer in flight and adds unknown ones', () => {
    let list = recordSpawn([], spawn('a1', { name: 'reader' }), T0)
    list = stopTask(list, 'reader', T0 + 1)
    expect(byId(list, 'a1')).toMatchObject({ status: 'killed', endedAt: T0 + 1 })
    list = settleWorkflow(launchWorkflow(list, { toolUseId: 'toolu_wf', name: 'scan' }, T0), 'toolu_wf', { isError: false, taskId: 'task1' }, T0)
    list = reconcileTasks(list, [{ id: 'task1', type: 'workflow', description: 'scan' }, { id: 'task2', type: 'workflow', description: 'Other run', name: 'other' }], T0 + 5)
    expect(byId(list, 'toolu_wf').status).toBe('running')
    expect(byId(list, 'task2')).toMatchObject({ kind: 'workflow', label: 'other', taskId: 'task2', status: 'running' })
    list = recordSpawn(list, spawn('w1', { toolUseId: 'toolu_wf', workflow: { runId: 'r1', agentIndex: 1 } }), T0 + 6)
    list = reconcileTasks(list, [{ id: 'task2', type: 'workflow', description: 'Other run' }], T0 + 9)
    expect(byId(list, 'toolu_wf')).toMatchObject({ status: 'completed', endedAt: T0 + 9 })
    // Its agents end with the run.
    expect(byId(list, 'w1')).toMatchObject({ status: 'completed', endedAt: T0 + 9 })
    // Stopping a workflow stops its agents.
    list = recordSpawn(list, spawn('w2', { toolUseId: '', workflow: { runId: 'r2', agentIndex: 1 } }), T0 + 10)
    list = stopTask(list, 'nothing', T0 + 11)
    expect(byId(list, 'w2').status).toBe('running')
    list = stopTask(list, 'r2', T0 + 11)
    expect(byId(list, 'r2').status).toBe('killed')
    expect(byId(list, 'w2')).toMatchObject({ status: 'killed', endedAt: T0 + 11 })
    list = stopTask(list, 'task2', T0 + 12)
    expect(byId(list, 'task2').status).toBe('killed')
  })

  test('a workflow whose agents all ended reads as finished once it has been quiet a while', () => {
    let list = launchWorkflow([], { toolUseId: 'wf', name: 'scan' }, T0)
    list = settleWorkflow(list, 'wf', { isError: false, taskId: 't' }, T0)
    list = recordSpawn(list, spawn('w1', { toolUseId: 'wf', workflow: { runId: 'r', agentIndex: 1 } }), T0)
    list = recordAgentTurn(list, 'w1', { reason: 'answer', durationMs: 1 }, T0 + 1_000)
    const record = byId(list, 'wf')
    expect(effectiveStatus(record, list, T0 + 2_000)).toBe('running')
    expect(effectiveStatus(record, list, T0 + 1_000 + WORKFLOW_QUIET_MS)).toBe('completed')
  })

  test('the cap keeps every working agent and the most recently ended', () => {
    const list: AgentRecord[] = [
      { ...blankAgent('old', 'subagent', T0), status: 'completed', endedAt: T0 + 1 },
      { ...blankAgent('live', 'subagent', T0), status: 'running' },
      { ...blankAgent('new', 'subagent', T0), status: 'completed', endedAt: T0 + 9 },
    ]
    expect(capAgents(list, 2).map(one => one.id)).toEqual(['live', 'new'])
  })

  test("rows nest a workflow's agents with its sums, running trees first, background shells included", () => {
    let list = settleWorkflow(launchWorkflow([], { toolUseId: 'wf', name: 'scan' }, T0), 'wf', { isError: false, taskId: 't' }, T0)
    list = recordSpawn(list, spawn('w1', { toolUseId: 'wf', workflow: { runId: 'r', agentIndex: 1 } }), T0 + 1)
    list = recordSpawn(list, spawn('w2', { toolUseId: 'wf', workflow: { runId: 'r', agentIndex: 2 } }), T0 + 2)
    list = recordAgentStep(list, 'w1', { model: 'm', effort: 'low', usage: usage(1_000, 0) }, T0 + 3)
    list = recordAgentStep(list, 'w2', { model: 'm', effort: 'low', usage: usage(2_000, 500) }, T0 + 3)
    list = recordAgentToolCall(list, 'w2', T0 + 4)
    list = recordAgentTurn(recordSpawn(list, spawn('a9'), T0 - 50), 'a9', { reason: 'answer', durationMs: 1 }, T0 + 5)
    const bg = finishRecord(startRecord('toolu_sh', 'Bash', { command: 'npm run dev', description: 'Dev server', run_in_background: true }, T0, 'w2'), { isDenied: false, isError: false, isReadOnly: false, text: '' }, T0 + 1)
    const shells = shellRecords([bg, startRecord('toolu_fg', 'Bash', { command: 'ls' }, T0)])
    expect(shells).toHaveLength(1)
    expect(shells[0]).toMatchObject({ id: 'shell:toolu_sh', kind: 'shell', label: 'Dev server', description: 'npm run dev', status: 'running', parentId: 'w2' })
    const layout = layoutAgents([...list, ...shells], T0 + 10)
    expect(layout.running.map(row => [row.record.id, row.depth])).toEqual([
      ['wf', 0],
      ['w1', 1],
      ['w2', 1],
      ['shell:toolu_sh', 2],
    ])
    expect(layout.running[0]).toMatchObject({ agents: 2, tokens: 3_500, requests: 2, toolCalls: 1 })
    expect(layout.finished.map(row => row.record.id)).toEqual(['a9'])
    expect(layout).toMatchObject({ runningRoots: 1, finishedRoots: 1 })
    expect(agentCounts(list, [bg], T0 + 10)).toEqual({ agents: 5, agentsLive: 4 })
  })
})

describe('the calls an opened row lists', () => {
  /** A workflow with two agents, a sub-agent with a background shell, and calls by each and by the main loop. */
  const fixture = (): { list: AgentRecord[]; commands: CommandRecord[] } => {
    const made = (id: string, agentId: string | undefined, at: number): CommandRecord => startRecord(id, 'Read', { file_path: `/repo/${id}.py` }, at, agentId)
    let list = settleWorkflow(launchWorkflow([], { toolUseId: 'wf', name: 'scan' }, T0), 'wf', { isError: false, taskId: 't' }, T0)
    list = recordSpawn(list, spawn('w1', { toolUseId: 'wf', workflow: { runId: 'r', agentIndex: 1 } }), T0)
    list = recordSpawn(list, spawn('w2', { toolUseId: 'wf', workflow: { runId: 'r', agentIndex: 2 } }), T0)
    list = recordSpawn(list, spawn('a1'), T0)
    const bg = finishRecord(
      startRecord('toolu_sh', 'Bash', { command: 'npm run dev', run_in_background: true }, T0 + 6, 'a1'),
      { isDenied: false, isError: false, isReadOnly: false, text: '' },
      T0 + 6,
    )
    return { list, commands: [made('c1', 'a1', T0 + 1), made('c2', 'w1', T0 + 2), made('c3', undefined, T0 + 3), made('c4', 'a1', T0 + 4), made('c5', 'w2', T0 + 5), bg] }
  }

  test("an agent's own calls, the newest first; a workflow's agents' calls; none for a background shell", () => {
    const { list, commands } = fixture()
    const ids = (id: string): string[] => callsOf(byId(list, id), list, commands).map(one => one.id)
    expect(ids('a1')).toEqual(['toolu_sh', 'c4', 'c1'])
    expect(ids('w1')).toEqual(['c2'])
    expect(ids('wf')).toEqual(['c5', 'c2'])
    const shells = shellRecords(commands)
    expect(shells.map(one => one.id)).toEqual(['shell:toolu_sh'])
    expect(shells.flatMap(one => callsOf(one, list, commands))).toEqual([])
  })

  test('a press opens a call in place only where the open row lists it', () => {
    const { list, commands } = fixture()
    expect(listsCall('a1', 'c4', list, commands)).toBe(true)
    // Another agent's call, and the main loop's.
    expect(listsCall('a1', 'c2', list, commands)).toBe(false)
    expect(listsCall('wf', 'c3', list, commands)).toBe(false)
    // A workflow lists its agents' calls.
    expect(listsCall('wf', 'c2', list, commands)).toBe(true)
    // No row open, or a background shell's: its own call opens in Commands.
    expect(listsCall(null, 'c4', list, commands)).toBe(false)
    expect(listsCall(undefined, 'c4', list, commands)).toBe(false)
    expect(listsCall('shell:toolu_sh', 'toolu_sh', list, commands)).toBe(false)
  })
})

describe('folding a parent agent’s work', () => {
  test('a parent’s children are drawn only while it is shown, nested ones only while every parent above them is; roots always', () => {
    const records = [
      { ...blankAgent('wf', 'workflow', 1) },
      { ...blankAgent('wa', 'workflow-agent', 2), parentId: 'wf' },
      { ...blankAgent('shell:x', 'shell', 3), parentId: 'wa' },
      { ...blankAgent('wb', 'workflow-agent', 4), parentId: 'wf' },
      blankAgent('solo', 'subagent', 0),
    ]
    const rows = layoutAgents(records, 10).running
    expect(rows.map(row => [row.record.id, row.depth, row.children])).toEqual([
      ['wf', 0, 2],
      ['wa', 1, 1],
      ['shell:x', 2, 0],
      ['wb', 1, 0],
      ['solo', 0, 0],
    ])
    const ids = (shown: string[]): string[] => visibleRows(rows, new Set(shown)).map(row => row.record.id)
    // Folded until shown: the roots alone.
    expect(ids([])).toEqual(['wf', 'solo'])
    expect(ids(['wf'])).toEqual(['wf', 'wa', 'wb', 'solo'])
    expect(ids(['wf', 'wa'])).toEqual(['wf', 'wa', 'shell:x', 'wb', 'solo'])
    // A nested parent shown under a folded one stays out of sight with it.
    expect(ids(['wa'])).toEqual(['wf', 'solo'])
    expect(childrenOf(records[0]!, records).map(one => one.id)).toEqual(['wa', 'wb'])
    // The parents above an agent, the nearest first: what an open one needs shown to be seen.
    expect(ancestorsOf('shell:x', records)).toEqual(['wa', 'wf'])
    expect(ancestorsOf('solo', records)).toEqual([])
    expect(ancestorsOf(null, records)).toEqual([])
    expect(ancestorsOf('loop', [{ ...blankAgent('loop', 'subagent', 0), parentId: 'loop' }])).toEqual([])
  })
})

describe("an agent's calls with those read from its transcript", () => {
  const call = (id: string, agentId: string, at: number): CommandRecord => ({ ...startRecord(id, 'Read', { file_path: `/repo/${id}` }, at, agentId), status: 'ok', endedAt: at + 1 })

  test('the calls the monitor holds, then those only the transcript does, the newest first; a workflow takes its agents’ and no other’s', () => {
    const workflow = { ...blankAgent('wf', 'workflow', 0) }
    const one = { ...blankAgent('wa', 'workflow-agent', 0), parentId: 'wf' }
    const two = { ...blankAgent('wb', 'workflow-agent', 0), parentId: 'wf' }
    const other = blankAgent('solo', 'subagent', 0)
    const agents = [workflow, one, two, other]
    const held = [call('c3', 'wa', 300), call('c4', 'wb', 400), call('c9', 'solo', 900)]
    // The transcripts' calls: two older ones, one the monitor holds too, and another agent's.
    const history: AgentHistory = { agentId: 'wf', state: 'done', calls: [call('c1', 'wa', 100), call('c2', 'wb', 200), call('c3', 'wa', 300), call('c8', 'solo', 800)] }
    expect(ownersOf(workflow, agents)).toEqual(['wa', 'wb'])
    expect(ownersOf(blankAgent('shell:x', 'shell', 0), agents)).toEqual([])
    expect(allCallsOf(workflow, agents, held, history).map(one => one.id)).toEqual(['c4', 'c3', 'c2', 'c1'])
    // Another agent's card does not take this read.
    expect(allCallsOf(other, agents, held, history).map(one => one.id)).toEqual(['c9'])
    expect(allCallsOf(workflow, agents, held, null).map(one => one.id)).toEqual(['c4', 'c3'])
    // A call only the transcript holds is the open card's, so it opens there.
    expect(listsCall('wf', 'c1', agents, held, history)).toBe(true)
    expect(listsCall('wf', 'c1', agents, held)).toBe(false)
  })
})

describe('the Agents tab', () => {
  const PROVIDER = { plugin: 'engine', tier: 'core' } as const
  const spawnInput = (fields: Pick<AgentSpawnInput, 'tool_use_id' | 'description' | 'subagentType'> & Partial<AgentSpawnInput>): AgentSpawnInput => ({
    prompt: 'do it',
    provider: PROVIDER,
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
    ...fields,
  })

  test("an agent's row, on the Agents tab and on Overview, shows its network and its model and effort", { timeoutMs: 30_000 }, async ($, on) => {
    on('agent.list', () => ({ value: [] }))
    on('agent.spawn', ($, e) => ({ model: 'claude-haiku-4-5', agentId: e.tool_use_id.replace('toolu_', 'ag-') }))
    const clock = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_x', description: 'Scan the repo', subagentType: 'Explore' }))
    await clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    for (const key of [`ov:${keyOf('ag-x')}`, agentKey('ag-x')]) {
      if (key === agentKey('ag-x')) {
        await ui.press({ key: 'tab:agents' })
      }
      const texts = (await ui.findAll({ in: key, type: 'Text' })).map(text => text.text)
      if (key.startsWith('ov:')) {
        // On Overview each agent is a card of its own, edged amber while it works.
        const box = await ui.find({ key: agentCardKeyOf('ag-x') })
        expect([box?.props.borderStyle, box?.props.borderColor]).toEqual(['round', 'warning'])
        expect(await keysIn(ui, agentCardKeyOf('ag-x'), 'ov:')).toEqual([key])
      }
      // No shell call of its own measured yet: its network says so.
      expect([key, texts.includes('⇅ —')]).toEqual([key, true])
      expect([key, texts.some(text => text.startsWith('Haiku 4.5 · '))]).toEqual([key, true])
    }
    await clock.advance(1_000)
    await ui.unmount()
  })

  test('lists running agents and a workflow with its agents nested, in cards; a click opens the details', { timeoutMs: 30_000 }, async ($, on) => {
    const roster: AgentInfo[] = [{ id: AGENT_ID, description: AGENT_TASK, type: 'Explore', status: 'running' }]
    on('agent.list', () => ({ value: [...roster] }))
    on('agent.spawn', ($, e) => ({ model: 'claude-haiku-4-5', agentId: e.workflow === undefined ? AGENT_ID : `wf-agent-${e.workflow.agentIndex}` }))
    on('classic.Stop', () => ({}))
    const clock = world(on)
    await start($, clock)

    // A background sub-agent: its spawn and Agent call, then its own requests and tool calls.
    await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_agent', description: AGENT_TASK, subagentType: 'Explore' }))
    await call($, { tool: 'Agent', description: AGENT_TASK, prompt: 'Scan it', subagent_type: 'Explore', run_in_background: true, tool_use_id: 'toolu_agent' })
    for (const index of [0, 1]) {
      for await (const chunk of $.turn.step({ turnId: 'ta', index, model: 'claude-haiku-4-5', effort: 'low', messageCount: 3, agentId: AGENT_ID })) {
        expect(chunk).toBeDefined()
      }
    }
    await call($, { tool: 'Read', file_path: '/repo/src/app.py', agentId: AGENT_ID, tool_use_id: 'toolu_read' })
    await call($, { tool: 'Grep', pattern: 'TODO', agentId: AGENT_ID, tool_use_id: 'toolu_grep' })
    await call($, { tool: 'Bash', command: 'npm run dev', description: 'Dev server', run_in_background: true, agentId: AGENT_ID, tool_use_id: 'toolu_bg' })

    // A workflow run and two of its agents, the first done after one call.
    const script = "export const meta = { name: 'review-pr', description: 'Review the change', phases: [{ title: 'Read' }, { title: 'Judge' }] }"
    await call($, { tool: 'Workflow', script, tool_use_id: 'toolu_wf' })
    for (const [index, description] of [[1, 'Read the diff'], [2, 'Judge it']] as const) {
      await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_wf', description, subagentType: 'general-purpose', workflow: { runId: WORKFLOW_RUN, agentIndex: index } }))
    }
    for await (const chunk of $.turn.step({ turnId: 'tw', index: 0, model: 'claude-sonnet-5', effort: 'high', messageCount: 2, agentId: 'wf-agent-1' })) {
      expect(chunk).toBeDefined()
    }
    await call($, { tool: 'Read', file_path: '/repo/README.md', agentId: 'wf-agent-1', tool_use_id: 'toolu_wfread' })
    const used = { input_tokens: 1_200, output_tokens: 300, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0, model: 'claude-sonnet-5' }
    await $.turn.complete({ answer: 'ok', durationMs: 1_500, isAborted: false, turnId: 'tw', reason: 'answer', agentId: 'wf-agent-1', usage: used })
    await clock.settle()

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'tab:overview' })
      // The header counts every row and the ones working; Overview says how many work in the background.
      expect((await tabButton(ui, 'agents'))?.props.label).toBe('Agents 5 · 4 live')
      expect(await ui.find({ type: 'Text', text: '⠿ 4 working' })).toBeDefined()
      await ui.press({ key: 'tab:agents' })
      // A card of figures, then Running now as a card of rows.
      expect(await keysOf(ui, 'agents-')).toEqual([AGENTS_SUMMARY_KEY, AGENTS_RUNNING_KEY])
      expect((await textsIn(ui, AGENTS_SUMMARY_KEY)).slice(0, 8)).toEqual(['Agents', '3', 'Workflows', '1', 'Background shells', '1', 'Working now', '4'])
      expect(await ui.find({ text: /Running now/ })).toBeDefined()
      // Folded until expanded: the parents' cards alone, each naming what it started.
      expect((await keysIn(ui, AGENTS_RUNNING_KEY, 'agent:')).sort()).toEqual([agentKey(AGENT_ID), agentKey('toolu_wf')].sort())
      expect(await textsIn(ui, agentKidsKey(AGENT_ID))).toContain('Dev server')
      expect(await textsIn(ui, agentKidsKey('toolu_wf'))).toEqual(expect.arrayContaining(['2 agents', 'Read the diff', 'Judge it']))
      expect(await foldLabel(ui, 'toolu_wf')).toBe('▸ Expand their 2 cards')
      // Expanded, the workflow's agents' cards are drawn under it.
      await clickRow(ui, agentFoldKey('toolu_wf'))
      await clock.settle()
      expect((await keysIn(ui, AGENTS_RUNNING_KEY, 'agent:')).sort()).toEqual([AGENT_ID, 'toolu_wf', 'wf-agent-1', 'wf-agent-2'].map(agentKey).sort())
      expect(await foldLabel(ui, 'toolu_wf')).toBe('▾ Collapse their 2 cards')

      const agentRow = agentKey(AGENT_ID)
      expect(await ui.find({ in: agentRow, type: 'Text', text: AGENT_TASK })).toBeDefined()
      expect(await ui.find({ in: agentRow, type: 'Text', text: 'Explore' })).toBeDefined()
      expect(await ui.find({ in: agentRow, type: 'Text', text: 'Haiku 4.5 · low' })).toBeDefined()
      expect(await ui.find({ in: agentRow, type: 'Text', text: '2 req' })).toBeDefined()
      expect(await ui.find({ in: agentRow, type: 'Text', text: '3 tools' })).toBeDefined()
      const shellRow = agentKey('shell:toolu_bg')

      const workflowRow = agentKey('toolu_wf')
      expect(await ui.find({ in: workflowRow, type: 'Text', text: 'review-pr' })).toBeDefined()
      expect(await ui.find({ in: workflowRow, type: 'Text', text: 'workflow' })).toBeDefined()
      expect(await ui.find({ in: workflowRow, type: 'Text', text: '2 agents' })).toBeDefined()
      expect(await ui.find({ in: workflowRow, type: 'Text', text: '12k tok' })).toBeDefined()
      expect(await ui.find({ in: agentKey('wf-agent-1'), type: 'Text', text: 'Read the diff' })).toBeDefined()
      expect((await ui.find({ in: agentKey('wf-agent-1'), type: 'Text', text: '✓' }))?.props.color).toBe('success')
      expect(await ui.find({ in: agentKey('wf-agent-1'), type: 'Text', text: 'Sonnet 5 · high' })).toBeDefined()
      expect(await ui.find({ in: agentKey('wf-agent-2'), type: 'Text', text: 'Judge it' })).toBeDefined()

      // A click opens the agent's card in the section's: its figures and ids, then the tool calls made inside it,
      // the newest first, drawn as the Commands tab draws them. Opened, a parent shows its children's cards:
      // its background shell nests beneath it.
      await clickRow(ui, agentRow)
      await clock.settle()
      expect(await ui.find({ in: shellRow, type: 'Text', text: 'Dev server' })).toBeDefined()
      expect(await ui.find({ in: shellRow, type: 'Text', text: 'shell' })).toBeDefined()
      expect(await ui.find({ in: shellRow, type: 'Text', text: '└' })).toBeDefined()
      const card = agentCardKey(AGENT_ID)
      expect(await keysIn(ui, AGENTS_RUNNING_KEY, 'agentcard:')).toEqual([card])
      expect((await ui.find({ key: card }))?.props.borderColor).toBe('warning')
      const opened = await textsIn(ui, card)
      expect(opened).toContain(`Id ${AGENT_ID}`)
      expect(opened[opened.indexOf('Started') + 1]).toMatch(/[AP]M$/)
      expect(opened[opened.indexOf('Tool calls') + 1]).toBe('3')
      expect(opened).toContain('Tool calls · 3, the newest first')
      expect(await keysIn(ui, card, 'cmd:')).toEqual(['cmd:toolu_bg', 'cmd:toolu_grep', 'cmd:toolu_read'])
      // Each call's exact text is its row's second line: plain text under the row's region, so it can be selected.
      expect((await textsIn(ui, rowBoxKey('cmd:toolu_read'))).some(text => text.includes('/repo/src/app.py'))).toBe(true)
      expect(await ui.find({ in: 'cmd:toolu_read', type: 'Text', text: '/repo/src/app.py' })).toBeUndefined()
      expect(await ui.find({ in: 'cmd:toolu_read', type: 'Text', text: `⤷ ${AGENT_TASK}` })).toBeDefined()
      expect((await textsIn(ui, rowBoxKey('cmd:toolu_bg'))).some(text => text.startsWith('npm'))).toBe(true)
      expect(await ui.find({ in: 'cmd:toolu_bg', type: 'Text', text: '▣ —' })).toBeDefined()

      // A click on a call opens its card right here, as in Commands: its figures, flow, cost and output.
      await clickRow(ui, 'cmd:toolu_read')
      await clock.settle()
      expect((await tabButton(ui, 'agents'))?.props.variant).toBe('primary')
      expect(await isOpenRow(ui, 'cmd:toolu_read')).toBe(true)
      expect(await keysIn(ui, card, 'cmdcard:')).toEqual([commandCardKey('toolu_read')])
      const call = await textsIn(ui, commandCardKey('toolu_read'))
      for (const part of ['Access', 'Memory', 'Flow', 'Context & cost', `Run by sub-agent ${AGENT_ID}`]) {
        expect(call).toContain(part)
      }
      expect(await ui.find({ type: 'Code', text: 'print("hi")' })).toBeDefined()
      // Its Collapse closes it, here too.
      await clock.advance(1_000)
      await ui.press({ key: 'close:toolu_read' })
      await clock.settle()
      expect((await tabButton(ui, 'agents'))?.props.variant).toBe('primary')
      expect(await isOpenRow(ui, 'cmd:toolu_read')).toBe(false)
      expect(await ui.find({ key: commandCardKey('toolu_read') })).toBeUndefined()

      // A workflow agent names its workflow as its parent, and lists its own call.
      await clickRow(ui, agentKey('wf-agent-1'))
      await clock.settle()
      const agentOne = await textsIn(ui, agentCardKey('wf-agent-1'))
      expect(agentOne).toContain('Parent review-pr (toolu_wf)')
      expect(agentOne).toContain('Tool calls · 1')
      expect(await keysOf(ui, 'cmd:')).toEqual(['cmd:toolu_wfread'])
      // The workflow lists its phases, and its agents' calls.
      await clickRow(ui, workflowRow)
      await clock.settle()
      const workflow = await textsIn(ui, agentCardKey('toolu_wf'))
      expect(workflow).toContain('Phases Read → Judge')
      expect(workflow).toContain('Its agents’ tool calls · 1')
      expect(await keysOf(ui, 'cmd:')).toEqual(['cmd:toolu_wfread'])

      // A background shell is a call itself: it lists none, and Open in Commands opens it there.
      await clickRow(ui, shellRow)
      await clock.settle()
      expect(await ui.find({ type: 'Text', text: /Read → Judge/ })).toBeUndefined()
      const shell = await textsIn(ui, agentCardKey('shell:toolu_bg'))
      expect(shell).toContain('[Open in Commands]')
      expect(shell.some(text => text.includes('Tool calls'))).toBe(false)
      await ui.press({ key: `agentcmd:${keyOf('shell:toolu_bg')}` })
      await clock.settle()
      expect((await tabButton(ui, 'commands'))?.props.variant).toBe('primary')
      expect(await isOpenRow(ui, 'cmd:toolu_bg')).toBe(true)
      await clock.advance(1_000)
      await ui.press({ key: 'close:toolu_bg' })
      await ui.press({ key: 'tab:agents' })
      // Its open shell keeps its agent's children shown; closed, the agent's own card again, and closed in turn, they fold away.
      await clock.advance(1_000)
      await clickRow(ui, shellRow)
      await clock.advance(1_000)
      await clickRow(ui, agentRow)
      await clock.settle()
      expect(await keysIn(ui, AGENTS_RUNNING_KEY, 'agent:')).toContain(shellRow)
      await clock.advance(1_000)
      await clickRow(ui, agentRow)
      await clock.settle()
      expect(await keysIn(ui, AGENTS_RUNNING_KEY, 'agent:')).not.toContain(shellRow)
      // Its Collapse folds the workflow's agents away again.
      await clock.advance(1_000)
      await clickRow(ui, agentFoldKey('toolu_wf'))
      await clock.settle()
      expect((await keysIn(ui, AGENTS_RUNNING_KEY, 'agent:')).sort()).toEqual([agentKey(AGENT_ID), agentKey('toolu_wf')].sort())
      await clock.advance(1_000)
      await ui.unmount()
    }

    // The sub-agent finishes, and the main loop's Stop no longer has the workflow in flight.
    roster[0] = { id: AGENT_ID, description: AGENT_TASK, type: 'Explore', status: 'completed' }
    await $.turn.complete({ answer: 'found it', durationMs: 4_000, isAborted: false, turnId: 'ta', reason: 'answer', agentId: AGENT_ID })
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
    await clock.settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      // Only the finished agent's background shell still works, so its tree stays in Running now; the workflow's is a Finished card's.
      expect((await tabButton(ui, 'agents'))?.props.label).toBe('Agents 5 · 1 live')
      expect(await keysOf(ui, 'agents-')).toEqual([AGENTS_SUMMARY_KEY, AGENTS_RUNNING_KEY, AGENTS_FINISHED_KEY])
      expect(await ui.find({ text: /Finished \(1\)/ })).toBeDefined()
      // The workflow's card alone until it is expanded; then its agents' cards under it.
      expect(await keysIn(ui, AGENTS_FINISHED_KEY, 'agent:')).toEqual([agentKey('toolu_wf')])
      await clickRow(ui, agentFoldKey('toolu_wf'))
      await clock.settle()
      expect(await keysIn(ui, AGENTS_FINISHED_KEY, 'agent:')).toEqual([agentKey('toolu_wf'), agentKey('wf-agent-1'), agentKey('wf-agent-2')])
      // Each agent a card of its own, holding its own row alone, edged as a finished call's is; the workflow's agents indented under it.
      expect(await keysIn(ui, AGENTS_FINISHED_KEY, 'agentitem:')).toEqual([agentItemKey('toolu_wf'), agentItemKey('wf-agent-1'), agentItemKey('wf-agent-2')])
      for (const id of ['toolu_wf', 'wf-agent-1', 'wf-agent-2']) {
        expect(await keysIn(ui, agentItemKey(id), 'agent:')).toEqual([agentKey(id)])
      }
      for (const id of ['wf-agent-1', 'wf-agent-2']) {
        const child = await ui.find({ key: agentItemKey(id) })
        expect([child?.props.borderColor, child?.props.backgroundColor]).toEqual([surface === 'terminal' ? 'subtle' : CALL_EDGE, surface === 'terminal' ? undefined : CALL_BACKGROUND])
      }
      // The workflow, their parent, edged and shaded apart from them, naming them one under another with how many.
      const parent = await ui.find({ key: agentItemKey('toolu_wf') })
      expect([parent?.props.borderColor, parent?.props.backgroundColor]).toEqual(['merged', surface === 'terminal' ? undefined : PARENT_BACKGROUND])
      const kids = await textsIn(ui, agentKidsKey('toolu_wf'))
      expect(kids[0]).toBe('2 agents')
      expect(kids.indexOf('Read the diff')).toBeLessThan(kids.indexOf('Judge it'))
      // Its Collapse hides their cards and keeps their names; Expand brings them back.
      await clock.advance(1_000)
      await clickRow(ui, agentFoldKey('toolu_wf'))
      await clock.settle()
      expect(await keysIn(ui, AGENTS_FINISHED_KEY, 'agentitem:')).toEqual([agentItemKey('toolu_wf')])
      expect(await textsIn(ui, agentKidsKey('toolu_wf'))).toContain('Judge it')
      expect(await foldLabel(ui, 'toolu_wf')).toBe('▸ Expand their 2 cards')
      await clock.advance(1_000)
      await clickRow(ui, agentFoldKey('toolu_wf'))
      await clock.settle()
      expect(await keysIn(ui, AGENTS_FINISHED_KEY, 'agentitem:')).toEqual([agentItemKey('toolu_wf'), agentItemKey('wf-agent-1'), agentItemKey('wf-agent-2')])
      expect(await foldLabel(ui, 'toolu_wf')).toBe('▾ Collapse their 2 cards')
      await clock.advance(1_000)
      expect(await keysIn(ui, agentItemKey(AGENT_ID), 'agent:')).toEqual([agentKey(AGENT_ID)])
      expect((await ui.find({ in: agentKey(AGENT_ID), type: 'Text', text: '✓' }))?.props.color).toBe('success')
      expect((await ui.find({ in: agentKey('wf-agent-2'), type: 'Text', text: '✓' }))?.props.color).toBe('success')
      // Folded again for the next surface.
      await clickRow(ui, agentFoldKey('toolu_wf'))
      await clock.advance(1_000)
      await ui.unmount()
    }
  })

  test("a long list of an agent's calls: the newest first, a page at a time, Newer and Older reaching every one, an open one kept, and those no longer kept counted", { timeoutMs: 60_000 }, async ($, on) => {
    on('agent.list', () => ({ value: [] }))
    const clock = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
    // Five more calls inside one agent than the monitor keeps (MAX_COMMANDS): the oldest five leave the list.
    const id = (n: number): string => `toolu_m${String(n).padStart(3, '0')}`
    for (let n = 0; n < MAX_COMMANDS + 5; n += 1) {
      await call($, { tool: 'Grep', pattern: `pat-${String(n).padStart(3, '0')}`, agentId: 'ag-many', tool_use_id: id(n) })
    }
    await clock.settle()

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:agents' })
    await clickRow(ui, agentKey('ag-many'))
    await clock.settle()
    const card = agentCardKey('ag-many')
    const [newer, older] = [agentNewerKey('ag-many'), agentOlderKey('ag-many')]
    const texts = await textsIn(ui, card)
    expect(texts).toContain(`Tool calls · ${MAX_COMMANDS} of ${MAX_COMMANDS + 5}, the newest first`)
    // Its transcript was read and holds none of the five: they are counted.
    expect(transcripts.runs).toContainEqual(['agents', '/repo', SESSION_ID, 'ag-many'])
    expect(texts).toContain(unseenText(5, true))
    expect(unseenText(5, true)).toBe(`5 not listed: the monitor did not see them or keeps only its newest ${MAX_COMMANDS} calls, and they are not in the agent's transcript.`)
    // The newest page, and which of how many it shows: Older, no Newer.
    const page = async (): Promise<{ rows: string[]; range: string | undefined; isNewer: boolean; isOlder: boolean }> => ({
      rows: await keysIn(ui, card, 'cmd:'),
      range: (await textsIn(ui, card)).find(text => / of 400$/.test(text)),
      isNewer: (await ui.find({ key: newer })) !== undefined,
      isOlder: (await ui.find({ key: older })) !== undefined,
    })
    const ids = (from: number, count: number): string[] => Array.from({ length: count }, (_, index) => `cmd:${id(404 - from - index)}`)
    expect(await page()).toEqual({ rows: ids(0, AGENT_CALLS_PAGE), range: '1–20 of 400', isNewer: false, isOlder: true })
    await ui.press({ key: older })
    await clock.settle()
    expect(await page()).toEqual({ rows: ids(20, AGENT_CALLS_PAGE), range: '21–40 of 400', isNewer: true, isOlder: true })
    // Older to the last page: every call is reached, the oldest kept last.
    for (let n = 2; n < MAX_COMMANDS / AGENT_CALLS_PAGE; n += 1) {
      await clock.advance(1_000)
      await ui.press({ key: older })
    }
    await clock.settle()
    expect(await page()).toEqual({ rows: ids(380, AGENT_CALLS_PAGE), range: '381–400 of 400', isNewer: true, isOlder: false })
    await clock.advance(1_000)
    await ui.press({ key: newer })
    await clock.settle()
    expect((await page()).range).toBe('361–380 of 400')

    // Closed and opened again: the newest page.
    await clock.advance(1_000)
    await clickRow(ui, agentKey('ag-many'))
    await clock.advance(1_000)
    await clickRow(ui, agentKey('ag-many'))
    await clock.settle()
    expect((await page()).range).toBe('1–20 of 400')

    // The oldest kept, opened in Commands (found by its text), stays listed and open after the page.
    await ui.press({ key: 'tab:commands' })
    await ui.input({ key: 'filter', text: 'pat-005' })
    await clickRow(ui, `cmd:${id(5)}`)
    await clock.settle()
    expect((await tabButton(ui, 'commands'))?.props.variant).toBe('primary')
    await ui.press({ key: 'tab:agents' })
    expect((await page()).rows).toEqual([...ids(0, AGENT_CALLS_PAGE), `cmd:${id(5)}`])
    expect(await isOpenRow(ui, `cmd:${id(5)}`)).toBe(true)

    // Closed here, in place, it leaves the page again.
    await clock.advance(1_000)
    await clickRow(ui, `cmd:${id(5)}`)
    await clock.settle()
    expect((await tabButton(ui, 'agents'))?.props.variant).toBe('primary')
    expect((await page()).rows).toEqual(ids(0, AGENT_CALLS_PAGE))
  })

  test("an agent's card lists every call its transcript holds that the monitor no longer does, paged with the rest; one opens in place with its output", { timeoutMs: 60_000 }, async ($, on) => {
    on('agent.list', () => ({ value: [] }))
    const clock = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
    const id = (n: number): string => `toolu_m${String(n).padStart(3, '0')}`
    for (let n = 0; n < MAX_COMMANDS + 5; n += 1) {
      await call($, { tool: 'Grep', pattern: `pat-${String(n).padStart(3, '0')}`, agentId: 'ag-many', tool_use_id: id(n) })
    }
    await clock.settle()
    // Its transcript holds every call, the five the monitor let go with them, and the request that read the oldest.
    transcripts.agents.set('ag-many', {
      id: 'ag-many',
      calls: Array.from({ length: MAX_COMMANDS + 5 }, (_, n) => ({
        id: id(n),
        name: 'Grep',
        input: { pattern: `pat-${String(n).padStart(3, '0')}` },
        startedAt: NOW - 1_000_000 + n,
        endedAt: NOW - 1_000_000 + n + 500,
        isError: false,
        output: `match ${n} in src/app.py`,
        model: 'claude-sonnet-5-5',
        ...(n === 0 ? { readBy: 'msg_0' } : {}),
      })),
      requests: { msg_0: { model: 'claude-sonnet-5-5', requests: 1, input: 1_000, output: 100, cacheRead: 9_000, cacheWrite: 0 } },
    })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:agents' })
    await clickRow(ui, agentKey('ag-many'))
    await clock.settle()
    const card = agentCardKey('ag-many')
    const texts = await textsIn(ui, card)
    expect(texts).toContain(`Tool calls · ${MAX_COMMANDS + 5}, the newest first`)
    expect(texts.filter(text => text.includes('not listed'))).toEqual([])
    // The last page: the five read from the transcript, the oldest last.
    const pages = Math.ceil((MAX_COMMANDS + 5) / AGENT_CALLS_PAGE)
    for (let n = 1; n < pages; n += 1) {
      await clock.advance(1_000)
      await ui.press({ key: agentOlderKey('ag-many') })
    }
    await clock.settle()
    expect(await keysIn(ui, card, 'cmd:')).toEqual([4, 3, 2, 1, 0].map(n => `cmd:${id(n)}`))
    expect(await textsIn(ui, card)).toContain(`401–405 of 405`)
    // The oldest, read from the transcript alone: its tokens, and opened here, its output.
    expect(await ui.find({ in: `cmd:${id(0)}`, type: 'Text', text: '10k in · 100 out' })).toBeDefined()
    await clickRow(ui, `cmd:${id(0)}`)
    await clock.settle()
    expect((await tabButton(ui, 'agents'))?.props.variant).toBe('primary')
    expect(await isOpenRow(ui, `cmd:${id(0)}`)).toBe(true)
    expect(await ui.find({ type: 'Code', text: /match 0 in src\/app\.py/ })).toBeDefined()
    await clock.advance(1_000)
    await ui.unmount()
  })

  test("an agent's card says so when its transcript cannot be read", { timeoutMs: 60_000 }, async ($, on) => {
    on('agent.list', () => ({ value: [] }))
    const clock = world(on)
    transcripts.failsAgents = true
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
    for (let n = 0; n < MAX_COMMANDS + 2; n += 1) {
      await call($, { tool: 'Grep', pattern: `p${n}`, agentId: 'ag-few', tool_use_id: `toolu_f${n}` })
    }
    await clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:agents' })
    await clickRow(ui, agentKey('ag-few'))
    await clock.settle()
    expect(await textsIn(ui, agentCardKey('ag-few'))).toContain(unseenText(2, false))
    expect(unseenText(2, false)).toBe(`2 not listed: the monitor did not see them or keeps only its newest ${MAX_COMMANDS} calls, and its transcript could not be read.`)
    await ui.unmount()
  })

  test('a long Finished list: Show more as far as the pane can draw, then a note', { timeoutMs: 60_000 }, async ($, on) => {
    on('agent.list', () => ({ value: [] }))
    on('agent.spawn', ($, e) => ({ model: 'claude-haiku-4-5', agentId: e.tool_use_id.replace('toolu_', 'ag-') }))
    const clock = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
    // 130 finished agents, each with a long task and brief, so a row carries a few hundred characters of its own.
    const task = 'Read every module under hooks and report what each exports, '.repeat(2)
    for (let n = 0; n < 130; n += 1) {
      await $.agent.spawn(spawnInput({ tool_use_id: `toolu_${n}`, description: `${n} ${task}`, subagentType: 'Explore', prompt: `${task.repeat(3)} Then stop.` }))
      await $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId: `t${n}`, reason: 'answer', agentId: `ag-${n}` })
    }
    await clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:agents' })
    expect(await keysIn(ui, AGENTS_FINISHED_KEY, 'agent:')).toHaveLength(40)
    expect((await ui.find({ key: 'agents:more' }))?.props.label).toBe('Show 50 more of 90')
    await ui.press({ key: 'agents:more' })
    await clock.settle()
    const rows = await keysIn(ui, AGENTS_FINISHED_KEY, 'agent:')
    expect(rows.length).toBeGreaterThan(40)
    expect(rows.length).toBeLessThan(90)
    expect(await textsIn(ui, AGENTS_FINISHED_KEY)).toContain(`The newest ${rows.length} fill the pane.`)
    expect(await ui.find({ key: 'agents:more' })).toBeUndefined()
  })

  test('an empty tab says what will appear; /session-monitor agents opens it', { timeoutMs: 20_000 }, async ($, on) => {
    on('agent.list', () => ({ value: [] }))
    const clock = world(on)
    await start($, clock)
    expect((await $.command.run({ command: 'session-monitor', args: 'agents', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })).text).toContain('open')
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await tabButton(ui, 'agents'))?.props.label).toBe('Agents')
      expect(await ui.find({ type: 'Text', text: /No agents yet/ })).toBeDefined()
    }
  })
})

describe("an agent's network", () => {
  const bash = (id: string, agentId: string | undefined, netIn: number, isSampled: boolean): CommandRecord => {
    const record = startRecord(id, 'Bash', { command: 'curl -sO https://x' }, 1_000, agentId, 'engine')
    return { ...record, metrics: { ...record.metrics, netIn, netOut: 1_000, isSampled } }
  }

  test("its own measured shell calls summed; a background shell's is its command's", () => {
    const calls = [bash('toolu_1', 'ag-1', 5_000_000, true), bash('toolu_2', 'ag-1', 9_000_000, false), bash('toolu_3', 'ag-2', 7_000_000, true), bash('toolu_bg', undefined, 2_000_000, true)]
    const agent: AgentRecord = { ...blankAgent('ag-1', 'subagent', 1_000) }
    expect(agentNetwork(agent, calls)).toEqual({ netIn: 5_000_000, netOut: 1_000, measured: 1 })
    const shell: AgentRecord = { ...blankAgent('shell:toolu_bg', 'shell', 1_000), toolUseId: 'toolu_bg' }
    expect(agentNetwork(shell, calls)).toEqual({ netIn: 2_000_000, netOut: 1_000, measured: 1 })
    expect(agentNetwork({ ...blankAgent('ag-9', 'subagent', 1_000) }, calls)).toEqual({ netIn: 0, netOut: 0, measured: 0 })
  })
})
