import type { AgentSpawnInput, TurnUsage } from 'claude-code'
import { describe, expect, test, type Engine } from 'claude-code/testing'

import { briefOf, layoutAgents, MAX_RUNS, recordAgentSpend, recordAgentStep, recordAgentTurn, blankAgent } from '../hooks/lib/agents'
import { keyOf } from '../hooks/lib/format'
import { startRecord } from '../hooks/lib/commands'
import { recentlyFinished } from '../hooks/lib/stats'
import { agentCardKey, agentKey, agentPartsKey } from '../hooks/view/agents'
import { commandCardKey, costPartsKey } from '../hooks/view/commands'
import type { CommandRecord } from '../types'
import { ARTIFACT_URL, call, clickRow, COMMAND, isOpenRow, limits, NOW, PANE, run, stepUsage, textsIn, world } from './world'

const OPUS: TurnUsage = { input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 2_000, model: 'claude-opus-5-5' }

const step = async ($: Engine, turnId: string, index: number, agentId?: string): Promise<void> => {
  const model = agentId === undefined ? 'claude-opus-5-5' : 'claude-sonnet-5-5'
  for await (const chunk of $.turn.step({ turnId, index, model, effort: 'high', messageCount: 3, ...(agentId !== undefined ? { agentId } : {}) })) {
    expect(chunk).toBeDefined()
  }
}

describe('recent calls, agent runs and spend', () => {
  const record = (id: string, endedAt: number | undefined, status: CommandRecord['status']): CommandRecord => ({
    ...startRecord(id, 'Bash', { command: id }, 0, undefined, 'engine'),
    endedAt,
    status,
  })

  test('the last five calls to finish, newest first; running and background ones wait', () => {
    const list = [
      ...[1, 2, 3, 4, 5, 6].map(n => record(`c${n}`, n * 1_000, 'ok')),
      record('live', undefined, 'running'),
      record('bg', 9_000, 'background'),
    ]
    expect(recentlyFinished(list).map(one => one.id)).toEqual(['c6', 'c5', 'c4', 'c3', 'c2'])
  })

  test("a prompt's brief: its opening sentences, past headings, list marks and code", () => {
    const prompt = '## Task\nFind every TODO in hooks/register.tsx. Report them grouped by file.\n\n```ts\nconst x = 1\n```\n- Then stop.'
    expect(briefOf(prompt)).toBe('Task Find every TODO in hooks/register.tsx. Report them grouped by file. Then stop.')
    expect(briefOf('x'.repeat(900)).length).toBeLessThanOrEqual(400)
  })

  test("each run of an agent's loop: opened by its first request, closed by its turn's end", () => {
    let list = recordAgentStep([blankAgent('a', 'subagent', 0)], 'a', { model: 'm', effort: 'high', usage: null }, 1_000)
    list = recordAgentStep(list, 'a', { model: 'm', effort: 'high', usage: null }, 2_000)
    list = recordAgentTurn(list, 'a', { reason: 'answer', durationMs: 1_500 }, 3_000)
    list = recordAgentStep(list, 'a', { model: 'm', effort: 'high', usage: null }, 10_000)
    expect(list[0]?.runs).toEqual([
      { startedAt: 1_000, endedAt: 3_000, requests: 2, reason: 'answer' },
      { startedAt: 10_000, requests: 1 },
    ])
    for (let n = 0; n < MAX_RUNS + 5; n += 1) {
      list = recordAgentTurn(list, 'a', { reason: 'error', durationMs: 0 }, 20_000 + n)
    }
    expect(list[0]?.runs?.length).toBe(MAX_RUNS)
  })

  test("an agent's spend in all and in the current block; a workflow sums its agents'", () => {
    const workflow = { ...blankAgent('wf', 'workflow', 0) }
    const kid = { ...blankAgent('k', 'workflow-agent', 0), parentId: 'wf' }
    let list = recordAgentSpend([workflow, kid], 'k', 0.5, 'b1')
    list = recordAgentSpend(list, 'k', 0.25, 'b1')
    expect(list[1]).toMatchObject({ usd: 0.75, blockUsd: 0.75, blockKey: 'b1' })
    list = recordAgentSpend(list, 'k', 0.1, 'b2')
    expect(list[1]).toMatchObject({ blockUsd: 0.1, blockKey: 'b2' })
    expect(recordAgentSpend(list, 'nobody', 1, 'b2')).toEqual(list)
    const rows = layoutAgents(list, 0).running
    expect(Math.round((rows.find(row => row.record.id === 'wf')?.usd ?? 0) * 100)).toBe(85)
  })
})

describe('the pane', () => {
  test("a command's details: its context, its share of the request that read it, and of the 5-hour window", { timeoutMs: 30_000 }, async ($, on) => {
    const clock = world(on)
    limits.resetsAt = new Date(NOW + 3 * 3_600_000).toISOString()
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await $.turn.start({ text: 'look around', turnId: 't1' })
    stepUsage.value = OPUS
    await step($, 't1', 0)
    await call($, { tool: 'Read', file_path: '/repo/src/app.py', tool_use_id: 'toolu_read' })
    await call($, { tool: 'Bash', command: COMMAND, description: 'Fetch the data', tool_use_id: 'toolu_bash' })
    limits.percentUsed = 44
    await step($, 't1', 1)
    await $.turn.complete({ answer: 'done', durationMs: 2_000, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.settle()

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    // Overview keeps the calls that finished, newest first; a click opens one in Commands.
    expect(await ui.find({ text: /Most recent commands/ })).toBeDefined()
    expect(await ui.find({ key: 'recent:toolu_bash' })).toBeDefined()
    expect(await ui.find({ key: 'recent:toolu_read' })).toBeDefined()
    await clickRow(ui, 'recent:toolu_bash')
    await clock.settle()
    expect(await isOpenRow(ui, 'cmd:toolu_bash')).toBe(true)

    expect(await ui.find({ type: 'Text', text: 'Context & cost' })).toBeDefined()
    // Each figure a tile: its name, then its value.
    const figures = await textsIn(ui, commandCardKey('toolu_bash'))
    const valueOf = (name: string): string | undefined => figures[figures.indexOf(name) + 1]
    expect(valueOf('Context')).toBe('≈ 19 tokens (<0.1% of 200k)')
    // The request that read both outputs cost (1k × $4 + 2k × $5 + 20k × $0.20 + 500 × $20) / 1M = $0.028, shared by two.
    expect(valueOf('Request')).toBe('$0.03 · 24k tokens · 2 outputs')
    expect(valueOf('Cost')).toMatch(/^≈ \$0\.0\d+$/)
    // Its share of that request's cost by the kind of token, which comes to its Cost.
    const parts = await textsIn(ui, costPartsKey('toolu_bash'))
    expect(parts[0]).toMatch(/^Cost breakdown · its share \(\d+%\) of the request that read its output$/)
    expect(parts.filter(text => /^[A-Z]/.test(text) && !text.startsWith('Cost'))).toEqual(['Input tokens', 'Cache reads', 'Cache writes (kept 5 min)', 'Output tokens', 'Total'])
    expect(parts.at(-1)).toBe(valueOf('Cost')?.replace('≈ ', ''))
    // Its share of that request's 23k in (20k of them cached) and 500 out, and what its own text comes to.
    const tokens = valueOf('Tokens') ?? ''
    expect(tokens).toMatch(/^\d+(\.\d)?k in \(\d+(\.\d)?k cached\) · \d+ out$/)
    expect(valueOf('Its own tokens')).toMatch(/^≈ \d+ in · \d+ out · \$0\.\d+$/)
    // The row says it too, in and out: the two calls' shares come to the request's.
    const rowTokens = async (id: string): Promise<string | undefined> => (await ui.find({ in: `cmd:${id}`, type: 'Text', text: / in · \d+ out$/ }))?.text
    const [bashRow, readRow] = [await rowTokens('toolu_bash'), await rowTokens('toolu_read')]
    expect(bashRow).toBe(tokens.replace(/ \(.*\)/, ''))
    const outs = [bashRow, readRow].map(text => Number(/ (\d+) out$/.exec(text ?? '')?.[1] ?? NaN))
    expect(outs.reduce((total, one) => total + one, 0)).toBe(500)
    // The limit rose 4 points over the session's two requests: the Bash call's part of that.
    expect(valueOf('This command used')).toMatch(/^≈ [0-3]\.\d+% of the 5-hour window$/)
    expect(valueOf('Window used')).toBe('44% of 100%')
    // The figures speak for themselves: none of the notes that once explained them.
    expect(await ui.find({ type: 'Text', text: /^Its share of the 5-hour window is/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Cost is its share, by output size/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^The sampler never saw its processes/ })).toBeUndefined()

    const text = await run($, 'monitor-report', '')
    expect(text).toContain('- **Model requests:** 2 at list prices ≈ $0.06 · $0.06 in the current 5-hour window')
    expect(text).toContain('### Most expensive calls')
    expect(text).toContain('| Bash | Fetch the data |')
  })

  test('a call no request has read yet says when its cost is counted', { timeoutMs: 30_000 }, async ($, on) => {
    const clock = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await $.turn.start({ text: 'look', turnId: 't1' })
    await call($, { tool: 'Bash', command: 'ls', description: 'List', tool_use_id: 'toolu_ls' })
    await clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:commands' })
    await clickRow(ui, 'cmd:toolu_ls')
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: /cost is counted when the request that reads its output finishes/ })).toBeDefined()
    // Nor its tokens: no request has read them yet.
    expect(await ui.find({ in: 'cmd:toolu_ls', type: 'Text', text: / in · \d+ out$/ })).toBeUndefined()
    expect(await ui.find({ in: 'cmd:toolu_ls', type: 'Text', text: /^⇅/ })).toBeDefined()
  })

  test('Overview lists the pages published and the files sent', { timeoutMs: 30_000 }, async ($, on) => {
    const toasts: string[] = []
    const clock = world(on, toasts)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /^None yet\. Pages Claude publishes/ })).toBeDefined()

    await call($, { tool: 'Artifact', file_path: '/repo/report.html', title: 'Spend report' })
    await call($, { tool: 'Artifact', file_path: '/repo/report.html', title: 'Spend report' })
    await call($, { tool: 'Artifact', action: 'read', url: ARTIFACT_URL })
    await call($, { tool: 'SendUserFile', files: ['/repo/out.csv'], caption: 'the data', status: 'normal' })
    await clock.settle()

    const link = await ui.find({ type: 'Link' })
    expect(link?.props.href).toBe(ARTIFACT_URL)
    expect(link?.props.label).toBe('Spend report')
    expect(await ui.find({ type: 'Text', text: '1 page · 1 file sent' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /published 2×/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'out.csv' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'the data' })).toBeDefined()
    // A sent file shows in Finder; one gone since says so.
    await ui.press({ key: `art:${keyOf('file:/repo/out.csv')}` })
    await clock.settle()
    expect(toasts).toContain('That file is no longer there.')

    const text = await run($, 'monitor-report', '')
    expect(text).toContain(`- [Spend report](${ARTIFACT_URL}) · published 2×`)
    expect(text).toContain('- Sent `/repo/out.csv`')
  })

  test("an agent says what it is responsible for, each run's start and end, its context, cost and 5-hour share", { timeoutMs: 30_000 }, async ($, on) => {
    on('agent.list', () => ({ value: [] }))
    on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'ag-todo' }))
    on('classic.Stop', () => ({}))
    const clock = world(on)
    limits.resetsAt = new Date(NOW + 3 * 3_600_000).toISOString()
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await $.turn.start({ text: 'find the todos', turnId: 't1' })
    stepUsage.value = OPUS
    await step($, 't1', 0)
    const spawn: AgentSpawnInput = {
      tool_use_id: 'toolu_agent',
      prompt: 'Find every TODO in hooks/register.tsx. Report them grouped by file.\n\n## Details\nSkip tests.',
      description: 'Find TODOs',
      subagentType: 'Explore',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5',
      background: true,
      fork: false,
    }
    await $.agent.spawn(spawn)
    stepUsage.value = { ...OPUS, model: 'claude-sonnet-5-5', cache_read_input_tokens: 30_000 }
    limits.percentUsed = 41
    await step($, 'ta', 0, 'ag-todo')
    await clock.advance(5_000)
    await call($, { tool: 'Grep', pattern: 'TODO', agentId: 'ag-todo' })
    limits.percentUsed = 43
    await step($, 'ta', 1, 'ag-todo')
    await clock.advance(5_000)
    await $.turn.complete({ answer: 'ok', durationMs: 10_000, isAborted: false, turnId: 'ta', reason: 'answer', agentId: 'ag-todo' })
    await clock.settle()

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:agents' })
    const row = agentKey('ag-todo')
    expect(await ui.find({ in: row, type: 'Text', text: /^≈ \$0\.0\d+$/ })).toBeDefined()
    expect(await ui.find({ in: row, type: 'Text', text: /^5h ≈ \d/ })).toBeDefined()
    await clickRow(ui, row)
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: 'Responsible for ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Find every TODO in hooks/register.tsx. Report them grouped by file.' })).toBeDefined()
    const figures = await textsIn(ui, agentCardKey('ag-todo'))
    const valueOf = (name: string): string | undefined => figures[figures.indexOf(name) + 1]
    expect(valueOf('Model')).toBe('Sonnet 5.5')
    expect(valueOf('Effort')).toBe('high')
    expect(figures).toContain('Context & cost')
    expect(valueOf('Context')).toMatch(/^\d+k \(\d+(\.\d)?% of 200k\)$/)
    expect(valueOf('Cost')).toMatch(/^≈ \$0\.0\d+$/)
    expect(valueOf('This agent used')).toMatch(/^≈ \d.*% of the 5-hour window$/)
    expect(await ui.find({ type: 'Text', text: /2 requests · answered/ })).toBeDefined()
    // Its cost by the kind of token, Sonnet 5.5's prices: 2k in at $2, 60k read at $0.20, 4k written at $2.50, 1k out at $10.
    expect(await textsIn(ui, agentPartsKey('ag-todo'))).toEqual([
      'Cost breakdown · its 2 requests',
      'Input tokens', '2k', '$0.0040', '11%',
      'Cache reads', '60k', '$0.01', '33%',
      'Cache writes (kept 5 min)', '4k', '$0.01', '28%',
      'Output tokens', '1k', '$0.01', '28%',
      'Total', '67k', '$0.04',
    ])
    // The figures speak for themselves: no paragraph explaining them.
    expect(figures.some(text => text.startsWith('Context is its latest request'))).toBe(false)
    expect(await ui.find({ type: 'Text', text: /list prices/ })).toBeUndefined()
  })
})
