import type { AgentSpawnInput } from 'claude-code'
import { describe, expect, test, type Engine, type FoundElement } from 'claude-code/testing'

import { blankAgent } from '../hooks/lib/agents'
import { startRecord } from '../hooks/lib/commands'
import { fmtClock, keyOf } from '../hooks/lib/format'
import {
  addAgent,
  addRequest,
  agentPromptsOf,
  beginTurn,
  carriedPrompts,
  carriesPrompt,
  cleanSummary,
  closeOpenRuns,
  contextText,
  deliveredTaskId,
  deliverPrompts,
  endFolded,
  endTurn,
  extendRun,
  groupCommands,
  FIND_APP,
  findKeystrokes,
  findSnippet,
  isFolded,
  isUserOrigin,
  isWaiting,
  jumpPlan,
  jumpTargets,
  linkRequest,
  linkTask,
  markDelivered,
  mergeStored,
  MAX_STORED_PROMPTS,
  needsModelSummary,
  newRun,
  NO_PROMPT,
  noteOpenWindows,
  noteWindows,
  overlapOf,
  promptAgents,
  promptFacts,
  quickSummary,
  readStored,
  refileAgentCalls,
  spawnOwner,
  storeKey,
  tellingWords,
  useOf,
  windowLead,
  windowPoints,
  windowText,
} from '../hooks/lib/prompts'
import { REVEAL_WAITS_MS } from '../hooks/register'
import { EXCERPT_CHARS, overviewTitleKey, promptAgentsKey, promptPartsKey, statusOf } from '../hooks/view/prompts'
import type { AgentRecord, CommandRecord, PromptRecord, RateLimitView, StoredPrompt, TaskLabel, Totals, WindowUse } from '../types'
import { callCardKey, jumpLabel, TITLE_COLOR } from '../hooks/view/kit'
import { call, cardScrollAsked, clickRow, clipboard, keystrokes, findAsked, hoverRow, keysOf, laterTicks, limits, memoryStore, NOW, PANE, promptEvents, run, scrollAsked, SESSION_ID, stepUsage, summaryModel, textsIn, TICK, weekly, world, type FindsAll, keysIn, tabButton, regionText } from './world'

const prompt = (fields: Partial<PromptRecord> & Pick<PromptRecord, 'id' | 'text'>): PromptRecord => ({
  summary: quickSummary(fields.text),
  isModelSummary: false,
  at: NOW,
  origin: 'composer',
  ...fields,
})

const record = (id: string, promptId: string | undefined, startedAt: number, fields: Partial<CommandRecord> = {}): CommandRecord => ({
  ...startRecord(id, 'Bash', { command: `echo ${id}` }, startedAt, undefined, 'engine'),
  promptId,
  ...fields,
})

describe('prompt titles', () => {
  test('the first sentence at once, past a greeting and list marks', () => {
    expect(quickSummary('can you make the timestamps 12 hour time. AM and PM please')).toBe('Make the timestamps 12 hour time.')
    expect(quickSummary('- fix the ports tab\n- and the strip')).toBe('Fix the ports tab and the strip')
    expect(quickSummary('```\ncode\n```\nwhy does this fail?')).toBe('Why does this fail?')
    expect(quickSummary('x'.repeat(200)).length).toBeLessThanOrEqual(72)
    expect(quickSummary('   ')).toBe('(empty prompt)')
  })

  test("a model's reply cleaned to a title; short prompts need no model", () => {
    expect(cleanSummary('Title: "Group commands by prompt."\n')).toBe('Group commands by prompt')
    expect(cleanSummary('\n\n**Add a Prompts tab**')).toBe('Add a Prompts tab')
    expect(cleanSummary('  ')).toBeUndefined()
    expect(needsModelSummary('fix the ports tab')).toBe(false)
    expect(needsModelSummary('a'.repeat(100))).toBe(true)
  })

  test('yours: typed, from the phone or web, or the app; not a notification or a peer', () => {
    expect(['composer', 'bridge', 'sdk'].every(isUserOrigin)).toBe(true)
    expect(['task-notification', 'peer', 'plugin', 'scheduled-trigger'].some(isUserOrigin)).toBe(false)
  })
})

describe('linking prompts', () => {
  test('a turn takes the newest prompt of its text without a task; a row the oldest without a row', () => {
    const list = [prompt({ id: 'a', text: 'run the tests' }), prompt({ id: 'b', text: 'run  the tests' }), prompt({ id: 'c', text: 'other' })]
    expect(linkTask(list, 'run the tests', 't9').map(one => one.taskId)).toEqual([undefined, 't9', undefined])
    const rowed = linkRequest(linkRequest(list, 'run the tests', 'r1'), 'run the tests', 'r2')
    expect(rowed.map(one => one.requestId)).toEqual(['r1', 'r2', undefined])
    // The same row again changes nothing.
    expect(linkRequest(rowed, 'run the tests', 'r1')).toEqual(rowed)
  })

  test('a row showing the prompt as typed matches the record as it reached the model (a paste expanded)', () => {
    const typed = 'look at this error and tell me what is wrong with it'
    const list = [prompt({ id: 'a', text: `${typed}\n[pasted 300 lines of log]` })]
    expect(linkRequest(list, typed, 'r1')[0]?.requestId).toBe('r1')
  })

  test('a jump plan: the rows seen since the last link matched first; another session’s prompt has none', () => {
    const calls = [record('toolu_first', 't1', NOW + 2_000), record('toolu_other', 't2', NOW + 500)]
    const known = [prompt({ id: 'p1', text: 'run the tests', taskId: 't1' }), prompt({ id: 'p2', text: 'and fix them', taskId: 't2', requestId: 'msg-2' })]
    expect(jumpPlan(known, [['msg-1', 'run the tests']], calls, 'p1')).toEqual({ summary: 'Run the tests', targets: ['msg-1', 'toolu_first'], snippet: 'run the tests' })
    expect(jumpPlan(known, [], calls, 'p1')).toEqual({ summary: 'Run the tests', targets: ['toolu_first'], snippet: 'run the tests' })
    expect(jumpPlan(known, [], calls, 'p2')).toEqual({ summary: 'And fix them', targets: ['msg-2', 'toolu_other'], snippet: 'and fix them' })
    expect(jumpPlan(known, [], calls, 'old-1')).toBeUndefined()
  })

  test("Find's snippet: the first line, spaces folded, cut at a word near 60 characters", () => {
    expect(findSnippet('\n\n  fix   the ports tab\nand the strip')).toBe('fix the ports tab')
    const long = 'in the overview tab put the prompt section underneath the models & effort section and right above the Agents section'
    expect(findSnippet(long)).toBe('in the overview tab put the prompt section underneath the')
    expect(findSnippet('x'.repeat(90))).toBe('x'.repeat(60))
    expect(findSnippet('')).toBe('')
  })

  test('a jump goes to the prompt’s row, then to the first main-loop call its work made', () => {
    const calls = [
      record('toolu_late', 't1', NOW + 9_000),
      record('toolu_agent', 't1', NOW + 1_000, { agentId: 'ag', actor: { kind: 'agent', name: '' } }),
      record('toolu_first', 't1', NOW + 2_000),
      record('toolu_other', 't2', NOW + 500),
    ]
    expect(jumpTargets(prompt({ id: 'p', text: 'x', taskId: 't1', requestId: 'msg-1' }), calls)).toEqual(['msg-1', 'toolu_first'])
    expect(jumpTargets(prompt({ id: 'p', text: 'x', taskId: 't1' }), calls)).toEqual(['toolu_first'])
    expect(jumpTargets(prompt({ id: 'p', text: 'x' }), calls)).toEqual([])
  })
})

describe("the project's history", () => {
  test('kept by repository, newest last, capped; what does not parse is dropped', () => {
    expect(storeKey('/Users/me/repo')).toBe('prompts:/Users/me/repo')
    const entry = (id: string, at: number): StoredPrompt => ({ id, text: id, summary: id, at, sessionId: 's' })
    let list: StoredPrompt[] = []
    for (let n = 0; n < MAX_STORED_PROMPTS + 5; n += 1) {
      list = mergeStored(list, entry(`p${n}`, n))
    }
    expect(list.length).toBe(MAX_STORED_PROMPTS)
    expect(list[0]?.id).toBe('p5')
    expect(mergeStored(list, { ...entry('p5', 5), summary: 'renamed' }).find(one => one.id === 'p5')?.summary).toBe('renamed')
    expect(readStored([entry('ok', 1), { id: 3 }, 'junk', null])).toEqual([entry('ok', 1)])
    expect(readStored('nope')).toEqual([])
  })
})

describe('command groups', () => {
  test('one per prompt, the newest prompt first, named by its summary, its task, or as outside any prompt', () => {
    const prompts = [prompt({ id: 'p1', text: 'first', taskId: 't1', summary: 'Fix the flaky login test', at: NOW }), prompt({ id: 'p2', text: 'second', taskId: 't2', at: NOW + 60_000 })]
    const tasks: TaskLabel[] = [{ id: 't0', kind: 'prompt', label: 'an earlier prompt from before the reload. more text', startedAt: NOW - 60_000 }]
    // Newest first, as the Commands tab lists them.
    const calls = [
      record('c5', 't2', NOW + 61_000),
      record('c4', 't1', NOW + 3_000),
      record('c3', 't1', NOW + 2_000),
      record('c2', 't0', NOW - 59_000),
      record('c1', undefined, NOW - 120_000),
    ]
    const groups = groupCommands(calls, prompts, tasks)
    expect(groups.map(group => [group.id, group.title, group.records.map(one => one.id)])).toEqual([
      ['t2', 'Second', ['c5']],
      ['t1', 'Fix the flaky login test', ['c4', 'c3']],
      ['t0', 'An earlier prompt from before the reload.', ['c2']],
      ['', NO_PROMPT, ['c1']],
    ])
    expect(groups[1]?.prompt?.id).toBe('p1')
  })
})

const LONG_PROMPT =
  'the login test fails about one run in five on CI with a timeout, can you find out why it is flaky and fix it so it passes reliably every time'

const begin = async ($: Engine, clock: ReturnType<typeof world>): Promise<void> => {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.turn.start({ text: LONG_PROMPT, turnId: 't1' })
  await clock.settle()
  await call($, { tool: 'Bash', command: 'npm test -- login', description: 'Run the login test', tool_use_id: 'toolu_a' })
  await call($, { tool: 'Read', file_path: '/repo/src/app.py', tool_use_id: 'toolu_b' })
  await $.turn.complete({ answer: 'done', durationMs: 2_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(60_000)
  await $.turn.start({ text: 'now add a retry', turnId: 't2' })
  await clock.settle()
  await call($, { tool: 'Edit', file_path: '/repo/src/app.py', old_string: 'a', new_string: 'b', tool_use_id: 'toolu_c' })
  await clock.settle()
}

describe('the pane', () => {
  test('Commands are grouped by the prompt that made them, titled by its summary; a header opens and closes its group', { timeoutMs: 30_000 }, async ($, on) => {
    on('ui.render', { component: 'UserMessage' }, () => ({ type: 'Box' as const, props: { key: 'engine-row' } }))
    const toasts: string[] = []
    const clock = world(on, toasts)
    await begin($, clock)
    // The long prompt was titled by the small model; the short one is its own title.
    expect(summaryModel.asked).toHaveLength(1)
    expect(summaryModel.asked[0]).toContain('the login test fails')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'tab:commands' })
      const first = `grp:${keyOf('t1')}`
      const second = `grp:${keyOf('t2')}`
      expect(await ui.find({ in: first, type: 'Text', text: 'Fix the flaky login test' })).toBeDefined()
      expect(await ui.find({ in: first, type: 'Text', text: '2 calls' })).toBeDefined()
      expect(await ui.find({ in: second, type: 'Text', text: 'Now add a retry' })).toBeDefined()
      expect(await ui.find({ in: second, type: 'Text', text: '1 call' })).toBeDefined()
      // The newest prompt's group comes first.
      const keys = (await ui.findAll({ type: 'Client' })).map(client => client.key ?? '').filter(key => key.startsWith('grp:'))
      expect(keys).toEqual([second, first])
      expect((await ui.findAll({ type: 'Client' })).some(client => client.key === 'cmd:toolu_a')).toBe(true)

      await clickRow(ui, first)
      await clock.settle()
      expect((await ui.findAll({ type: 'Client' })).some(client => client.key === 'cmd:toolu_a')).toBe(false)
      expect((await ui.findAll({ type: 'Client' })).some(client => client.key === 'cmd:toolu_c')).toBe(true)
      await clock.advance(1_000)
      await clickRow(ui, first)
      await clock.settle()
      expect((await ui.findAll({ type: 'Client' })).some(client => client.key === 'cmd:toolu_a')).toBe(true)
      // The group's button goes to its prompt in the conversation: a press of yours, so it may move it.
      const firstId = (await promptIds($))[0] ?? ''
      const before = toasts.length
      await ui.press({ key: `gojump:${keyOf(firstId)}` })
      // The terminal asks the transcript to scroll; the desktop, which no plugin can scroll, copies the prompt's opening for ⌘F.
      expect(toasts.slice(before)).toEqual([surface === 'terminal' ? scrollAsked('Fix the flaky login test') : findAsked(findSnippet(LONG_PROMPT))])
      await clock.advance(1_000)
      await ui.unmount()
    }
  })

  test('the Prompts tab: a card per prompt, newest first, with its times, its work and a jump to it', { timeoutMs: 30_000 }, async ($, on) => {
    on('ui.render', { component: 'UserMessage' }, () => ({ type: 'Box' as const, props: { key: 'engine-row' } }))
    const toasts: string[] = []
    const clock = world(on, toasts)
    // Another session of this project left a prompt in the store.
    memoryStore.set(storeKey('/repo'), [{ id: 'old-1', text: 'set up the project', summary: 'Set up the project', at: NOW - 86_400_000, sessionId: 'session-0000' }])
    await begin($, clock)
    // The conversation draws your first prompt's row: the prompt learns where it is.
    await $.ui.mount({ plugin: 'session-monitor', component: 'UserMessage', requestId: 'msg-1', surface: 'terminal', props: { text: LONG_PROMPT, origin: { kind: 'composer' }, isExpanded: true } })
    await clock.settle()
    const [firstId, secondId] = await promptIds($)
    const first = keyOf(firstId ?? '')
    const second = keyOf(secondId ?? '')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'tab:prompts' })
      // A card each, newest first; the other session's below. No list rows: a card is not a click region.
      expect(await keysOf(ui, 'prm:')).toEqual([`prm:${second}`, `prm:${first}`, `prm:${keyOf('old-1')}`])
      expect((await ui.findAll({ type: 'Client' })).some(client => (client.key ?? '').startsWith('prm:'))).toBe(false)
      expect((await tabButton(ui, 'prompts'))?.props.label).toBe('Prompts 2')

      // The first: titled, numbered, done, its words, its times and what its work came to.
      const done = (await textsIn(ui, `prm:${first}`)).join('\n')
      expect(done).toContain('#1')
      expect(done).toMatch(/Fix the flaky login test/)
      expect(done).toContain('✓ Done')
      expect(done).toContain(`“${LONG_PROMPT}”`)
      for (const name of ['Sent', 'Ended', 'Duration', 'Claude worked', 'Tool calls', 'From']) {
        expect(done).toContain(name)
      }
      expect(done).toContain(fmtClock(NOW, NOW))
      expect(done).toContain('2.0s')
      expect(done).toContain('typed')
      expect(done).toContain('Bash ×1')
      expect(done).toContain('Read ×1')
      expect(done).toContain(`[${jumpLabel(surface)}]`)
      expect(done).toContain('[Show its commands]')
      expect(done).toContain('[Copy prompt]')
      // The second is still running: no end yet.
      const running = (await textsIn(ui, `prm:${second}`)).join('\n')
      expect(running).toContain('#2')
      expect(running).toContain('● Running')
      expect(running).toContain('still running')
      expect(running).toContain('Edit ×1')
      // Every title is bold and in the blue a command's title is drawn in: this session's, the other session's too.
      for (const title of ['Fix the flaky login test', 'Now add a retry', 'Set up the project']) {
        const found = (await ui.findAll({ type: 'Text', text: title })).find(text => text.text === title)
        expect(found?.props.color).toBe(TITLE_COLOR)
        expect(found?.props.bold).toBe(true)
      }
      // The other session's: its words and when, to copy; no jump, its conversation is not this one.
      const other = (await textsIn(ui, `prm:${keyOf('old-1')}`)).join('\n')
      expect(other).toContain('Set up the project')
      expect(other).toContain('session session-')
      expect(other).not.toContain('Jump')
      expect(await ui.find({ type: 'Text', text: '1 from other sessions' })).toBeDefined()

      // A press of Jump asks the conversation to scroll (jumpPlan's tests cover to what); where it cannot, a toast says why.
      const before = toasts.length
      await ui.press({ key: `pjump:${first}` })
      await ui.press({ key: `pjump:${second}` })
      expect(toasts.slice(before)).toEqual(
        surface === 'terminal'
          ? [scrollAsked('Fix the flaky login test'), scrollAsked('Now add a retry')]
          : [findAsked(findSnippet(LONG_PROMPT)), findAsked('now add a retry')],
      )
      expect(clipboard.texts.slice(-2)).toEqual(surface === 'terminal' ? clipboard.texts.slice(-2) : [findSnippet(LONG_PROMPT), 'now add a retry'])
      await clock.advance(1_000)
      await ui.unmount()
    }

    // Show its commands: the Commands tab with only its group open.
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:prompts' })
    await ui.press({ key: `pcmds:${first}` })
    await clock.settle()
    expect((await tabButton(ui, 'commands'))?.props.variant).toBe('primary')
    const clients = (await ui.findAll({ type: 'Client' })).map(client => client.key ?? '')
    expect(clients).toContain('cmd:toolu_a')
    expect(clients).not.toContain('cmd:toolu_c')

    // The project's history holds this session's prompts too, under its id.
    const history = readStored(memoryStore.get(storeKey('/repo')))
    expect(history.map(one => [one.summary, one.sessionId])).toEqual([
      ['Set up the project', 'session-0000'],
      ['Fix the flaky login test', SESSION_ID],
      ['Now add a retry', SESSION_ID],
    ])
  })

  test("a card shows a long prompt's opening; Expand shows all of it", { timeoutMs: 30_000 }, async ($, on) => {
    const clock = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
    const long = `${'please look at every flaky test in the suite and tell me which ones fail and why '.repeat(5)}\nand then fix them all`
    await $.turn.start({ text: long, turnId: 't1' })
    await clock.settle()
    const [id] = await promptIds($)
    const key = keyOf(id ?? '')
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'tab:prompts' })
    const shut = (await textsIn(ui, `prm:${key}`)).find(text => text.startsWith('“')) ?? ''
    expect(shut.length).toBeLessThanOrEqual(EXCERPT_CHARS + 2)
    expect(shut.endsWith('…”')).toBe(true)
    await clickRow(ui, `pfull:${key}`)
    expect((await textsIn(ui, `prm:${key}`)).some(text => text === `“${long}”`)).toBe(true)
    expect(await regionText(ui, `pfull:${key}`)).toBe('▾ Collapse')
    // Its title, the small model's few words: bold, in the title blue, as on the terminal; no heading, which takes no colour.
    expect(await ui.find({ type: 'Markdown', text: /Fix the flaky login test/ })).toBeUndefined()
    const title = (await ui.findAll({ type: 'Text', text: 'Fix the flaky login test' })).find(text => text.text === 'Fix the flaky login test')
    expect(title?.props.color).toBe(TITLE_COLOR)
    expect(title?.props.bold).toBe(true)
  })

  test("a prompt's run: its requests' tokens and price, when its turn ended, and what the machine spent", { timeoutMs: 30_000 }, async ($, on) => {
    const clock = world(on)
    // The sampler's second tick: ten more CPU-seconds, thirty more joules, a megabyte down.
    laterTicks.value = [{ ...TICK, t: (NOW + 2_000) / 1000, session: { ...TICK.session, cpuS: 41.5, energyJ: 58, netIn: 13_803_000 } }]
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await clock.advance(1_000)
    await $.turn.start({ text: 'fetch the data', turnId: 't1' })
    await clock.settle()
    stepUsage.value = { input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 2_000, model: 'claude-opus-5-5' }
    for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 3 })) {
      expect(chunk).toBeDefined()
    }
    await call($, { tool: 'Write', file_path: '/repo/out.txt', content: 'x', tool_use_id: 'toolu_w' })
    await clock.advance(1_000)
    await $.turn.complete({ answer: 'done', durationMs: 5_000, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.settle()

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:prompts' })
    const [id] = await promptIds($)
    const card = (await textsIn(ui, `prm:${keyOf(id ?? '')}`)).join('\n')
    // (1k × $4 + 2k × $5 + 20k × $0.20 + 500 × $20) / 1M = $0.028.
    expect(card).toContain('≈ $0.03')
    // In: 1k uncached, 2k written to the cache and 20k read from it; out: 500.
    expect(card).toContain('Tokens\n23k in (20k cached) · 500 out')
    expect(card).toContain('Opus 5.5')
    expect(card).toContain('5.0s')
    expect(card).toContain('30 J')
    expect(card).toContain('10s')
    expect(card).toContain('↓ 1.00 MB ↑ 0 B')
    expect(card).toContain('Files changed')
    expect(card).toContain(fmtClock(NOW + 2_000, NOW + 2_000))
    // Its cost by the kind of token once the card is expanded: (1k × $4 + 20k × $0.20 + 2k × $5 + 500 × $20) / 1M.
    expect(await ui.find({ key: promptPartsKey(id ?? '') })).toBeUndefined()
    await clickRow(ui, `pfull:${keyOf(id ?? '')}`)
    await clock.settle()
    expect(await textsIn(ui, promptPartsKey(id ?? ''))).toEqual([
      'Cost breakdown · its 1 request, sub-agents’ included',
      'Input tokens', '1k', '$0.0040', '14%',
      'Cache reads', '20k', '$0.0040', '14%',
      'Cache writes (kept 5 min)', '2k', '$0.01', '36%',
      'Output tokens', '500', '$0.01', '36%',
      'Total', '24k', '$0.03',
    ])
    await clock.advance(1_000)
    await clickRow(ui, `pfull:${keyOf(id ?? '')}`)
    await clock.settle()
    // The tab's totals sum the session's prompts, their tokens too.
    expect(await ui.find({ type: 'Text', text: '1' })).toBeDefined()
    expect(await ui.findAll({ type: 'Text', text: '23k in (20k cached) · 500 out' })).toHaveLength(2)
    // Overview's card says them in short.
    await ui.press({ key: 'tab:overview' })
    expect((await textsIn(ui, `ovp:${keyOf(id ?? '')}`)).join('\n')).toContain(' · 23k in · 500 out')
    await ui.press({ key: 'tab:prompts' })
    // A continuation carries the prompt on: running again, a second turn.
    await $.turn.start({ text: '', turnId: 't2' })
    await clock.settle()
    expect((await textsIn(ui, `prm:${keyOf(id ?? '')}`)).join('\n')).toContain('● Running')
    await $.turn.complete({ answer: 'more', durationMs: 1_000, isAborted: true, turnId: 't2', reason: 'aborted' })
    await clock.settle()
    const after = (await textsIn(ui, `prm:${keyOf(id ?? '')}`)).join('\n')
    expect(after).toContain('■ Interrupted')
    expect(after).toContain('6.0s · 2 turns')
  })

  test('Overview: your latest 2 prompts as cards under Models & effort, above Agents; Jump goes to one', { timeoutMs: 30_000 }, async ($, on) => {
    const toasts: string[] = []
    const clock = world(on, toasts)
    await begin($, clock)
    await clock.advance(60_000)
    await $.turn.start({ text: 'and write the changelog', turnId: 't3' })
    await clock.settle()
    const ids = await promptIds($)
    expect(ids).toHaveLength(3)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      // The newest two, newest first; the first prompt is left for the Prompts tab.
      expect(await keysOf(ui, 'ovp:')).toEqual([`ovp:${keyOf(ids[2] ?? '')}`, `ovp:${keyOf(ids[1] ?? '')}`])
      const newest = (await textsIn(ui, `ovp:${keyOf(ids[2] ?? '')}`)).join('\n')
      expect(await ui.find({ in: overviewTitleKey(ids[2] ?? ''), type: 'Text', text: 'And write the changelog' })).toBeDefined()
      expect(newest).toContain('● Running')
      expect((await textsIn(ui, `ovp:${keyOf(ids[1] ?? '')}`)).join('\n')).toContain('1 call')
      expect((await ui.find({ key: 'ov:prompts' }))?.props.label).toBe('All prompts (3)')
      const before = toasts.length
      await ui.press({ key: `ovjump:${keyOf(ids[1] ?? '')}` })
      expect(toasts.slice(before)).toEqual([surface === 'terminal' ? scrollAsked('Now add a retry') : findAsked('now add a retry')])
      await ui.press({ key: 'ov:prompts' })
      expect((await tabButton(ui, 'prompts'))?.props.variant).toBe('primary')
      await ui.press({ key: 'tab:overview' })
      await ui.unmount()
    }
  })

  test("Overview: a click on a prompt's title opens its card expanded: the whole prompt, the button to fold it again", { timeoutMs: 30_000 }, async ($, on) => {
    const clock = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
    const long = `${'the login test fails on CI with a timeout about one run in five, '.repeat(6)}find out why and fix it`
    expect(long.length).toBeGreaterThan(EXCERPT_CHARS)
    await $.turn.start({ text: long, turnId: 't1' })
    await clock.settle()
    await $.turn.complete({ answer: 'done', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.settle()
    const [id] = await promptIds($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await clickRow(ui, overviewTitleKey(id ?? ''))
    await clock.settle()
    expect(await regionText(ui, `pfull:${keyOf(id ?? '')}`)).toBe('▾ Collapse')
    await clock.advance(5_000)
    await ui.unmount()
  })

  test("Overview: a prompt's title is blue; a click on it opens its card on the Prompts tab, edged in the accent, then scrolls there", { timeoutMs: 30_000 }, async ($, on) => {
    const toasts: string[] = []
    const clock = world(on, toasts)
    await begin($, clock)
    const [firstId, secondId] = await promptIds($)
    const first = keyOf(firstId ?? '')
    const second = keyOf(secondId ?? '')
    const firstTitle = overviewTitleKey(firstId ?? '')
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      // The title is one clickable region, bold and in the blue a command's title is drawn in.
      const title = async (): Promise<FoundElement | undefined> => ui.find({ in: firstTitle, type: 'Text', text: 'Fix the flaky login test' })
      expect((await title())?.props.color).toBe(TITLE_COLOR)
      expect((await title())?.props.bold).toBe(true)
      // Under the pointer it underlines, as a link does.
      expect((await title())?.props.underline).toBe(false)
      await hoverRow(ui, firstTitle, 'enter')
      expect((await title())?.props.underline).toBe(true)
      await hoverRow(ui, firstTitle, 'leave')
      expect((await title())?.props.underline).toBe(false)

      // A click on it: the Prompts tab, that prompt's card edged in the accent; the running one keeps its own edge.
      const before = toasts.length
      await clickRow(ui, firstTitle)
      expect((await tabButton(ui, 'prompts'))?.props.variant).toBe('primary')
      expect((await ui.find({ key: `prm:${first}` }))?.props.borderColor).toBe('claude')
      expect((await ui.find({ key: `prm:${second}` }))?.props.borderColor).toBe('warning')
      // Opened expanded, it lists its own calls (both started at once here), each a card of its own; the next prompt's are not among them.
      expect((await keysIn(ui, `prm:${first}`, 'callcard:')).sort()).toEqual([callCardKey('toolu_a'), callCardKey('toolu_b')].sort())
      // The card is drawn only once the tab is: the scroll waits for that redraw, then tries again a few times
      // while the card is not drawn yet. The kit scrolls no pane, so the tries end in a toast, once all are spent.
      const tries = REVEAL_WAITS_MS.reduce((total, ms) => total + ms, 0)
      expect(toasts.slice(before)).toEqual([])
      await clock.advance(tries - 1)
      expect(toasts.slice(before)).toEqual([])
      await clock.advance(1)
      expect(toasts.slice(before)).toEqual([cardScrollAsked('Fix the flaky login test')])

      // The next click, a press of any button, takes the mark off.
      await ui.press({ key: `pcopy:${first}` })
      expect((await ui.find({ key: `prm:${first}` }))?.props.borderColor).toBe('subtle')
      await ui.press({ key: 'tab:overview' })
      await clock.advance(1_000)
      await ui.unmount()
    }
  })

  test('a click on an Overview title that the person moves on from asks no scroll; a click on a row takes the mark off too', { timeoutMs: 30_000 }, async ($, on) => {
    const toasts: string[] = []
    const clock = world(on, toasts)
    await begin($, clock)
    const [firstId, secondId] = await promptIds($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    // Clicked, then another tab at once: the scroll is not tried, nor said to fail.
    await clickRow(ui, overviewTitleKey(secondId ?? ''))
    await ui.press({ key: 'tab:overview' })
    await clock.advance(1_000)
    expect(toasts).toEqual([])
    // A click on another prompt's title moves the mark there.
    await clickRow(ui, overviewTitleKey(firstId ?? ''))
    expect((await ui.find({ key: `prm:${keyOf(firstId ?? '')}` }))?.props.borderColor).toBe('claude')
    expect((await ui.find({ key: `prm:${keyOf(secondId ?? '')}` }))?.props.borderColor).toBe('warning')
    // Not a click, the command that opens a tab keeps it; a click on a row takes it off.
    await run($, 'monitor', 'commands')
    await clickRow(ui, 'cmd:toolu_a')
    await run($, 'monitor', 'prompts')
    expect((await ui.find({ key: `prm:${keyOf(firstId ?? '')}` }))?.props.borderColor).toBe('subtle')
    await clock.advance(1_000)
    expect(toasts).toEqual([])
  })

  test('where no Client is drawn, an Overview title is a plain button that opens its card the same way', { timeoutMs: 30_000 }, async ($, on) => {
    const toasts: string[] = []
    const clock = world(on, toasts)
    await begin($, clock)
    const [firstId] = await promptIds($)
    const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
    const button = await ui.find({ key: overviewTitleKey(firstId ?? '') })
    expect(button?.type).toBe('Button')
    expect(button?.props.label).toBe('Fix the flaky login test')
    expect(button?.props.plain).toBe(true)
    await ui.press({ key: overviewTitleKey(firstId ?? '') })
    expect((await tabButton(ui, 'prompts'))?.props.variant).toBe('primary')
    expect((await ui.find({ key: `prm:${keyOf(firstId ?? '')}` }))?.props.borderColor).toBe('claude')
    await clock.advance(1_000)
    expect(toasts).toEqual([cardScrollAsked('Fix the flaky login test')])
    await ui.press({ key: 'tab:prompts' })
    expect((await ui.find({ key: `prm:${keyOf(firstId ?? '')}` }))?.props.borderColor).toBe('subtle')
  })

  test('/monitor summaries off: prompts keep their first sentence and no model is asked', { timeoutMs: 30_000 }, async ($, on) => {
    const clock = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await $.command.run({ command: 'session-monitor', args: 'summaries off', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
    await $.turn.start({ text: LONG_PROMPT, turnId: 't1' })
    await clock.settle()
    expect(summaryModel.asked).toHaveLength(0)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:prompts' })
    const [id] = await promptIds($)
    expect((await textsIn(ui, `prm:${keyOf(id ?? '')}`)).some(text => /^The login test fails about one run in five/.test(text))).toBe(true)
  })
})

describe("a prompt's run", () => {
  const totals = (cpuS: number, energyJ: number, netIn: number): Totals => ({ cpuS, energyJ, energyEstJ: 0, netIn, netOut: 0, diskR: 0, diskW: 0, netActiveS: 0 })
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }

  test('a turn begins it, requests add up, a turn ends it; a continuation runs it again', () => {
    let list = [prompt({ id: 'p', text: 'x', taskId: 't1', run: newRun(totals(1, 10, 100)) }), prompt({ id: 'q', text: 'y', taskId: 't2' })]
    list = addRequest(list, 't1', usage, 0.5, 'claude-opus-5-5')
    list = addRequest(list, 't1', usage, undefined, 'claude-sonnet-5-5')
    expect(list[0]?.run).toMatchObject({ requests: 2, usd: 0.5, model: 'claude-sonnet-5-5', tokens: { input: 20, output: 10, cacheRead: 200, cacheWrite: 40 } })
    list = endTurn(list, 't1', { at: NOW + 4_000, durationMs: 4_000, reason: 'answer', totals: totals(3, 25, 600) })
    expect(list[0]?.run).toMatchObject({ endedAt: NOW + 4_000, endReason: 'answer', workMs: 4_000, turns: 1 })
    expect(useOf(list[0]?.run)).toEqual({ energyJ: 15, cpuS: 2, netIn: 500, netOut: 0, diskR: 0, diskW: 0 })
    list = beginTurn(list, 't1', totals(9, 99, 999))
    expect(list[0]?.run).toMatchObject({ turns: 2, workMs: 4_000 })
    expect(list[0]?.run?.endedAt).toBeUndefined()
    // The run keeps the counters from its first turn.
    expect(list[0]?.run?.startTotals?.cpuS).toBe(1)
    // A prompt without a run gets one at its first turn; an unknown task changes nothing.
    expect(beginTurn(list, 't2', undefined)[1]?.run).toMatchObject({ turns: 1, requests: 0 })
    expect(addRequest(list, 'nobody', usage, 1, 'm')).toEqual(list)
  })

  test("what the machine spent needs both ends, and none of its counters going back", () => {
    expect(useOf(undefined)).toBeUndefined()
    expect(useOf(newRun(totals(1, 1, 1)))).toBeUndefined()
    expect(useOf({ ...newRun(totals(5, 5, 5)), endTotals: totals(1, 9, 9) })).toBeUndefined()
  })

  test('a run left open by a reload closes as the next prompt begins', () => {
    const open = [prompt({ id: 'a', text: 'a', taskId: 't1', at: NOW, run: newRun(undefined) }), prompt({ id: 'b', text: 'b', taskId: 't2', at: NOW + 5_000, run: newRun(undefined) })]
    const closed = closeOpenRuns(open, 't2', NOW + 9_000)
    expect(closed[0]?.run?.endedAt).toBe(NOW + 9_000)
    expect(closed[1]?.run?.endedAt).toBeUndefined()
  })

  test("a card's facts: calls, failures, tools, files, agents, its end and how long it took", () => {
    const calls = [
      record('c1', 't1', NOW + 1_000, { endedAt: NOW + 3_000, status: 'ok' }),
      record('c2', 't1', NOW + 2_000, { tool: 'Edit', filePath: '/repo/a.py', endedAt: NOW + 2_500, status: 'ok' }),
      record('c3', 't1', NOW + 2_100, { tool: 'Edit', filePath: '/repo/a.py', endedAt: NOW + 2_600, status: 'ok' }),
      record('c4', 't1', NOW + 2_200, { tool: 'Agent', endedAt: NOW + 2_300, status: 'ok' }),
      record('c5', 't1', NOW + 2_400, { status: 'error', endedAt: NOW + 2_450 }),
      record('c6', 't2', NOW + 9_000),
    ]
    const ended = prompt({ id: 'p', text: 'x', taskId: 't1', run: { ...newRun(undefined), endedAt: NOW + 4_000, endReason: 'answer', agents: ['ag'] } })
    const facts = promptFacts(ended, calls, NOW + 60_000)
    expect(facts).toMatchObject({ calls: 5, failed: 1, running: 0, files: 1, agents: 1, isRunning: false, endedAt: NOW + 4_000, durationMs: 4_000, firstCallAt: NOW + 1_000, lastCallAt: NOW + 3_000 })
    // Its agents are the ones spawned for it; a run kept before those were counts its calls that start agents.
    expect(promptFacts({ ...ended, run: { ...newRun(undefined), endedAt: NOW + 4_000 } }, calls, NOW).agents).toBe(0)
    const { agents: listed, ...older } = newRun(undefined)
    expect(listed).toEqual([])
    expect(promptFacts({ ...ended, run: { ...older, endedAt: NOW + 4_000 } }, calls, NOW).agents).toBe(1)
    expect(facts.tools).toEqual([
      { tool: 'Bash', count: 2 },
      { tool: 'Edit', count: 2 },
      { tool: 'Agent', count: 1 },
    ])
    expect(statusOf(ended, facts)).toEqual({ text: '✓ Done', tone: 'success' })
    // Running: its duration runs to now.
    const running = prompt({ id: 'r', text: 'x', taskId: 't2', run: newRun(undefined) })
    expect(promptFacts(running, calls, NOW + 60_000)).toMatchObject({ isRunning: true, durationMs: 60_000, running: 1 })
    expect(statusOf(running, promptFacts(running, calls, NOW))).toEqual({ text: '● Running', tone: 'warning' })
    // Kept before runs were: its last call's end stands in for its own.
    expect(promptFacts(prompt({ id: 'o', text: 'x', taskId: 't1' }), calls, NOW + 60_000)).toMatchObject({ isRunning: false, endedAt: NOW + 3_000, durationMs: 3_000 })
    // Sent during a turn and not begun: queued, its length unknown.
    const queued = prompt({ id: 'w', text: 'x' })
    expect(statusOf(queued, promptFacts(queued, calls, NOW))).toEqual({ text: '○ Queued', tone: 'subtle' })
    expect(promptFacts(queued, calls, NOW).durationMs).toBeUndefined()
    for (const [reason, text] of [
      ['aborted', '■ Interrupted'],
      ['error', '✗ Ended by an error'],
      ['refusal', '⊘ Refused'],
    ] as const) {
      const one = prompt({ id: 'e', text: 'x', taskId: 't1', run: { ...newRun(undefined), endedAt: NOW, endReason: reason } })
      expect(statusOf(one, promptFacts(one, calls, NOW)).text).toBe(text)
    }
  })
})

describe("a prompt's agents", () => {
  const agent = (id: string, kind: AgentRecord['kind'], at: number, fields: Partial<AgentRecord> = {}): AgentRecord => ({ ...blankAgent(id, kind, at), label: `label ${id}`, ...fields })

  test('every agent spawned for it, oldest first, a workflow named over its agents, which alone count', () => {
    const agents = [
      agent('wf', 'workflow', 10, { label: 'verify the pane' }),
      agent('w2', 'workflow-agent', 30, { parentId: 'wf', type: 'workflow-subagent' }),
      agent('w1', 'workflow-agent', 20, { parentId: 'wf', type: 'workflow-subagent' }),
      agent('solo', 'subagent', 5, { type: 'Explore' }),
      agent('other', 'subagent', 6),
    ]
    const used = promptAgents(prompt({ id: 'p', text: 'x', taskId: 't', run: { ...newRun(undefined), agents: ['w2', 'solo', 'w1', 'gone'] } }), agents, [])
    expect(used.lines).toEqual([
      { id: 'solo', label: 'label solo', kind: 'Explore', depth: 0 },
      { id: 'wf', label: 'verify the pane', kind: 'workflow', depth: 0, agents: 2 },
      { id: 'w1', label: 'label w1', kind: 'workflow-subagent', depth: 1 },
      { id: 'w2', label: 'label w2', kind: 'workflow-subagent', depth: 1 },
    ])
    // One spawned for it that the list does not hold yet still counts.
    expect(used.total).toBe(4)
    expect(promptAgents(prompt({ id: 'q', text: 'y', taskId: 'u', run: newRun(undefined) }), agents, [])).toEqual({ total: 0, lines: [] })
  })

  test('kept before runs listed them: its Agent and Workflow calls, named as asked; an agent’s own spawns are not its', () => {
    const calls = [
      record('c2', 't', 20, { tool: 'Workflow', summary: 'run the review', title: 'review' }),
      record('c1', 't', 10, { tool: 'Agent', summary: 'Find the config', title: 'Explore' }),
      record('c3', 't', 30, { tool: 'Agent', summary: 'nested', title: 'nested', agentId: 'c1-agent' }),
      record('c4', 't', 40, { tool: 'Read', summary: 'read', title: 'read' }),
    ]
    const used = promptAgents(prompt({ id: 'p', text: 'x', taskId: 't' }), [], calls)
    expect(used.lines.map(line => [line.label, line.kind])).toEqual([
      ['Find the config', 'agent'],
      ['run the review', 'workflow'],
    ])
    expect(used.total).toBe(1)
  })
})

describe("a prompt's context and rate-limit windows", () => {
  const usage = (input: number, cacheRead: number, cacheWrite: number) => ({ input_tokens: input, output_tokens: 100, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite })

  test("its own loop's requests: the context at the latest, its share of the window, its growth since the first", () => {
    let list = [prompt({ id: 'p', text: 'x', taskId: 't1', run: newRun(undefined) })]
    expect(contextText(list[0]?.run)).toBeUndefined()
    list = addRequest(list, 't1', usage(1_000, 180_000, 4_000), 0.1, 'claude-opus-5-5', { contextWindow: 1_000_000 })
    expect(list[0]?.run).toMatchObject({ contextFirst: 185_000, contextLast: 185_000, contextWindow: 1_000_000 })
    // A sub-agent's request adds its tokens and price, not the prompt's context.
    list = addRequest(list, 't1', usage(50_000, 0, 0), 0.2, 'claude-sonnet-5-5')
    expect(list[0]?.run?.contextLast).toBe(185_000)
    list = addRequest(list, 't1', usage(2_000, 190_000, 5_000), 0.1, 'claude-opus-5-5', {})
    expect(list[0]?.run).toMatchObject({ contextFirst: 185_000, contextLast: 197_000, contextWindow: 1_000_000, requests: 3 })
    expect(contextText(list[0]?.run)).toBe('197k (20% of 1M) · +12k')
    // A compaction shrinks it; with no window known, no share.
    expect(contextText({ ...newRun(undefined), contextFirst: 150_000, contextLast: 100_000 })).toBe('100k · −50k')
  })

  const reading = (kind: string, percentUsed: number, resetsAt?: string): RateLimitView => ({ kind, percentUsed, ...(resetsAt !== undefined ? { resetsAt } : {}) })
  const SOON = new Date(NOW + 3_600_000).toISOString()
  const LATER = new Date(NOW + 5 * 3_600_000).toISOString()

  test('each window as the run began and at its latest reading; a kind not read is kept, others ignored', () => {
    let windows = noteWindows(undefined, [reading('five_hour', 24.8, SOON), reading('seven_day', 61.2), reading('spend_limit', 3)], NOW)
    expect(windows.map(one => one.kind)).toEqual(['five_hour', 'seven_day'])
    windows = noteWindows(windows, [reading('five_hour', 26, SOON)], NOW + 60_000)
    const five = windows.find(one => one.kind === 'five_hour')
    expect(five).toMatchObject({ firstPct: 24.8, startPct: 24.8, lastPct: 26, resets: 0 })
    expect(windows.find(one => one.kind === 'seven_day')?.lastPct).toBe(61.2)
    expect(five !== undefined && windowText(five, 0.5)).toBe('+1.2% (24.8% → 26.0%)')
  })

  test('a window that reset in between keeps what the run used before it, and counts again from 0', () => {
    const start = noteWindows(undefined, [reading('five_hour', 97.5, SOON)], NOW)
    const before = noteWindows(start, [reading('five_hour', 98.8, SOON)], NOW + 30 * 60_000)
    // Its reset time passed and the reading names another window.
    const after = noteWindows(before, [reading('five_hour', 2.6, LATER)], NOW + 2 * 3_600_000)
    const five = after[0]
    expect(five).toMatchObject({ startPct: 0, lastPct: 2.6, earlierPoints: expect.any(Number), resets: 1, resetsAt: LATER })
    expect(five === undefined ? '' : windowPoints(five).toFixed(1)).toBe('3.9')
    expect(five !== undefined && windowText(five, 1)).toBe('+3.9% (97.5% → reset → 2.6%)')
    // A percent that fell with no times reported is a reset too.
    expect(noteWindows(start, [reading('five_hour', 1)], NOW + 60_000)[0]).toMatchObject({ resets: 1, earlierPoints: 0, lastPct: 1 })
    // Another reset time before the kept one has passed is the same window (a rolling or jittering report).
    expect(noteWindows(start, [reading('five_hour', 98, LATER)], NOW + 60_000)[0]).toMatchObject({ resets: 0, lastPct: 98, resetsAt: LATER })
  })

  test('under a step: less than a step while the run cost something, or the estimate from its cost', () => {
    const flat: WindowUse = { kind: 'five_hour', firstPct: 24.8, startPct: 24.8, lastPct: 24.8, earlierPoints: 0, resets: 0 }
    expect(windowText(flat, 0.02)).toBe('< 0.1% (24.8% → 24.8%)')
    expect(windowText(flat, 0.02, '≈ 0.040%')).toBe('≈ 0.040% (24.8% → 24.8%)')
    expect(windowText(flat, 0)).toBe('+0.0% (24.8% → 24.8%)')
    // A window reported in whole points rises a point at a time.
    expect(windowLead({ ...flat, firstPct: 24, startPct: 24, lastPct: 24 }, 0.02)).toBe('< 1%')
  })

  test('readings reach the runs at work only', () => {
    const list = [prompt({ id: 'a', text: 'a', taskId: 't1', run: newRun(undefined) }), prompt({ id: 'b', text: 'b', taskId: 't2', run: { ...newRun(undefined), endedAt: NOW } }), prompt({ id: 'w', text: 'w' })]
    const read = noteOpenWindows(list, one => one.run?.endedAt === undefined, [reading('five_hour', 30)], NOW)
    expect(read.map(one => one.run?.windows?.length ?? 0)).toEqual([1, 0, 0])
    expect(noteOpenWindows(list, () => true, [], NOW)).toEqual(list)
  })

  test('work that went on past its turn (an agent of it ended) reads the counters and windows again; a run still going waits for its turn', () => {
    const totals = (cpuS: number): Totals => ({ cpuS, energyJ: 0, energyEstJ: 0, netIn: 0, netOut: 0, diskR: 0, diskW: 0, netActiveS: 0 })
    const ended = prompt({ id: 'p', text: 'x', taskId: 't1', run: { ...newRun(totals(1)), endedAt: NOW, endTotals: totals(2), windows: noteWindows(undefined, [reading('five_hour', 40)], NOW) } })
    const open = prompt({ id: 'q', text: 'y', taskId: 't2', run: newRun(totals(1)) })
    const later = extendRun([ended, open], 't1', { at: NOW + 9_000, totals: totals(5), readings: [reading('five_hour', 41)] })
    expect(later[0]?.run?.endTotals?.cpuS).toBe(5)
    expect(later[0]?.run?.windows?.[0]?.lastPct).toBe(41)
    expect(later[0]?.run?.endedAt).toBe(NOW)
    expect(later[1]).toEqual(open)
    expect(extendRun([open], 't2', { at: NOW, totals: totals(5), readings: [] })).toEqual([open])
  })

  test('a turn reads the windows as it begins and as it ends', () => {
    let list = [prompt({ id: 'p', text: 'x', taskId: 't1' })]
    list = beginTurn(list, 't1', undefined, [reading('five_hour', 40), reading('seven_day', 10.5)], NOW)
    list = endTurn(list, 't1', { at: NOW + 5_000, durationMs: 5_000, reason: 'answer', totals: undefined, readings: [reading('five_hour', 41.5), reading('seven_day', 10.7)] })
    expect(list[0]?.run?.windows?.map(one => windowText(one, 1))).toEqual(['+1.5% (40.0% → 41.5%)', '+0.2% (10.5% → 10.7%)'])
  })
})

/** The prompts of a turn: A started it; B and C were typed while it ran. */
const TURN_PROMPT = 'fix the flaky login test: it times out on CI about one run in five'
const TYPED_PROMPT = 'mouse-select partial diff copying feature: when you are viewing the diff in the Files tab I want to select part of it with the mouse and copy just that part'
/** What the engine's request carries for a prompt folded into a running turn. */
const folded = (text: string): string => `The user sent the following message:\n${text}\n\nPlease address this message and continue with your tasks.`
/** A spawned agent's words that restate B's request, as Claude writes them. */
const QUOTING_B =
  "Implement partial diff copy. The user asked: 'when you are viewing the diff in the Files tab I want to select part of it with the mouse and copy just that part'. Add mouse selection to hooks/view/diff.tsx and copy the selected lines."

describe('a prompt typed during a turn', () => {
  test('a running turn carries it: its words in the engine’s framing; a short one only where it is all but alone', () => {
    expect(carriesPrompt(folded(TYPED_PROMPT), TYPED_PROMPT)).toBe(true)
    expect(carriesPrompt(folded(TYPED_PROMPT.replace(/ /g, '  ')), TYPED_PROMPT)).toBe(true)
    expect(carriesPrompt(folded(TURN_PROMPT), TYPED_PROMPT)).toBe(false)
    expect(carriesPrompt(folded('yes'), 'yes')).toBe(true)
    expect(carriesPrompt(`<task-notification>${'the build finished, yes, '.repeat(30)}</task-notification>`, 'yes')).toBe(false)
    // Whole words only.
    expect(carriesPrompt(folded('yesterday'), 'yes')).toBe(false)
    expect(carriesPrompt(folded('anything'), '   ')).toBe(false)
  })

  test("the turn takes in the oldest waiting prompt of a text; a prompt with a task is not taken again", () => {
    const list = [
      prompt({ id: 'a', text: TURN_PROMPT, taskId: 't1', at: NOW }),
      prompt({ id: 'b', text: TYPED_PROMPT, at: NOW + 2_000 }),
      prompt({ id: 'b2', text: TYPED_PROMPT, at: NOW + 3_000 }),
      prompt({ id: 'c', text: 'and then write the changelog', at: NOW + 4_000 }),
    ]
    expect(carriedPrompts(list, folded(TYPED_PROMPT)).map(one => one.id)).toEqual(['b'])
    expect(carriedPrompts(list, folded(TURN_PROMPT))).toEqual([])
  })

  test('folded in, it gets a task of its own and a run with no turn of its own; the turn’s end closes it', () => {
    const totals: Totals = { cpuS: 1, energyJ: 2, energyEstJ: 0, netIn: 3, netOut: 0, diskR: 0, diskW: 0, netActiveS: 0 }
    let list = [prompt({ id: 'a', text: TURN_PROMPT, taskId: 't1', run: newRun(undefined) }), prompt({ id: 'b', text: TYPED_PROMPT, at: NOW + 2_000 })]
    list = deliverPrompts(list, new Set(['b', 'a']), { into: 't1', at: NOW + 5_000, totals, readings: [{ kind: 'five_hour', percentUsed: 30 }] })
    const b = list[1]
    expect(b).toMatchObject({ taskId: deliveredTaskId('b'), deliveredAt: NOW + 5_000, deliveredInto: 't1', run: { turns: 0, requests: 0, agents: [], startTotals: totals } })
    expect(b?.run?.windows?.[0]?.firstPct).toBe(30)
    expect(b !== undefined && isFolded(b)).toBe(true)
    // The prompt that started the turn is not folded into it.
    expect(list[0]?.taskId).toBe('t1')
    expect(list[0] !== undefined && isFolded(list[0])).toBe(false)
    // Another turn's end leaves it running; its own turn's closes it.
    expect(endFolded(list, 't9', { at: NOW + 9_000, durationMs: 9_000, reason: 'answer', totals: undefined })[1]?.run?.endedAt).toBeUndefined()
    const ended = endFolded(list, 't1', { at: NOW + 9_000, durationMs: 9_000, reason: 'answer', totals, readings: [{ kind: 'five_hour', percentUsed: 31 }] })
    expect(ended[1]?.run).toMatchObject({ endedAt: NOW + 9_000, endReason: 'answer', workMs: 0, endTotals: totals })
    expect(ended[1]?.run?.windows?.[0]?.lastPct).toBe(31)
    // The turn's own prompt is ended by its own turn's end, not here.
    expect(ended[0]?.run?.endedAt).toBeUndefined()
    // A prompt that began a turn of its own was given to the model then.
    expect(markDelivered([prompt({ id: 'x', text: 'x', taskId: 't5' })], 't5', NOW + 1)[0]?.deliveredAt).toBe(NOW + 1)
  })
})

describe('which prompt a spawned agent serves', () => {
  const turn = prompt({ id: 'a', text: TURN_PROMPT, taskId: 't1', at: NOW, deliveredAt: NOW })
  const typed = prompt({ id: 'b', text: TYPED_PROMPT, at: NOW + 2_000 })
  const delivered = { ...typed, taskId: deliveredTaskId('b'), deliveredAt: NOW + 5_000 }
  const earlier = prompt({ id: 'o', text: TYPED_PROMPT, taskId: 't0', at: NOW - 600_000 })

  test('telling words: lowercase, the commonest left out, endings cut', () => {
    expect(tellingWords('The user is Copying FILES, and it copied the files')).toEqual(['copy', 'file', 'copi', 'file'])
    expect(overlapOf(TYPED_PROMPT, QUOTING_B).phrases).toBeGreaterThanOrEqual(5)
    expect(overlapOf(TURN_PROMPT, QUOTING_B)).toEqual({ phrases: 0, words: 0 })
  })

  test("the prompt its words quote best: the one typed during the turn, or the turn's own", () => {
    expect(spawnOwner([earlier, turn, delivered], 't1', QUOTING_B)?.id).toBe('b')
    expect(spawnOwner([earlier, turn, delivered], 't1', 'Find out why the flaky login test times out on CI, and fix it')?.id).toBe('a')
    // One still waiting that a spawn quotes was given to the model after all.
    expect(spawnOwner([turn, typed], 't1', QUOTING_B)?.id).toBe('b')
  })

  test('else the prompt the model was given last; a prompt before the turn’s own is never one', () => {
    const generic = 'Explore the repository structure and summarize it'
    expect(spawnOwner([earlier, turn, delivered], 't1', generic)?.id).toBe('b')
    expect(spawnOwner([earlier, turn, typed], 't1', generic)?.id).toBe('a')
    // The earlier prompt has the same words as B, but its turn is over.
    expect(spawnOwner([earlier, turn], 't1', QUOTING_B)?.id).toBe('a')
    // A turn that is no prompt of yours (a notification's), or none known: any prompt it clearly quotes, else none.
    expect(spawnOwner([earlier, turn], 'notification-turn', QUOTING_B)?.id).toBe('o')
    expect(spawnOwner([turn, typed], undefined, QUOTING_B)?.id).toBe('b')
    expect(spawnOwner([earlier, turn], 'notification-turn', generic)).toBeUndefined()
    expect(spawnOwner([], 't1', QUOTING_B)).toBeUndefined()
  })

  test('a quote must clearly lead: two prompts quoted alike fall back to the latest given; a few common words are none', () => {
    const twin = prompt({ id: 'c', text: `${TYPED_PROMPT} please`, taskId: deliveredTaskId('c'), at: NOW + 3_000, deliveredAt: NOW + 6_000 })
    expect(spawnOwner([turn, delivered, twin], 't1', QUOTING_B)?.id).toBe('c')
    const short = prompt({ id: 'y', text: 'yes do it', taskId: deliveredTaskId('y'), at: NOW + 1_000, deliveredAt: NOW + 1_000 })
    expect(spawnOwner([turn, short], 't1', 'yes, do it: fix the build')?.id).toBe('y')
    expect(overlapOf('yes do it', 'yes, do it: fix the build')).toEqual({ phrases: 0, words: 0 })
  })

  test("an agent's calls recorded before its prompt was known are filed under it", () => {
    const calls = [record('c1', 't1', NOW, { agentId: 'ag' }), record('c2', 't1', NOW), record('c3', 'in-turn:b', NOW, { agentId: 'ag' })]
    expect(refileAgentCalls(calls, 'ag', 'in-turn:b').map(one => one.promptId)).toEqual(['in-turn:b', 't1', 'in-turn:b'])
    expect(refileAgentCalls(calls, 'nobody', 'x')).toEqual(calls)
  })

  test('after a reload, each agent serves the prompt whose run lists it; a prompt waits while none of its words has a task', () => {
    const list = [
      prompt({ id: 'a', text: 'a', taskId: 't1', run: { ...newRun(undefined), agents: ['ag1', 'ag2'] } }),
      { ...delivered, run: { ...newRun(undefined), agents: ['ag3'] } },
      typed,
      prompt({ id: 'old', text: 'old', taskId: 't0' }),
    ]
    expect(agentPromptsOf(list)).toEqual([
      ['ag1', 't1'],
      ['ag2', 't1'],
      ['ag3', deliveredTaskId('b')],
    ])
    expect(isWaiting(list, `  ${TYPED_PROMPT}  `)).toBe(true)
    expect(isWaiting(list, 'a')).toBe(false)
  })

  test('the agents spawned for a prompt keep it running, and its work ends at their end', () => {
    const agent = (id: string, fields: Partial<AgentRecord>): AgentRecord => ({ ...blankAgent(id, 'subagent', NOW), ...fields })
    let list: PromptRecord[] = [{ ...delivered, run: { ...newRun(undefined), turns: 0, endedAt: NOW + 9_000, endReason: 'answer' } }]
    list = addAgent(addAgent(list, deliveredTaskId('b'), 'ag'), deliveredTaskId('b'), 'ag')
    const b = list[0]
    expect(b?.run?.agents).toEqual(['ag'])
    if (b === undefined) {
      return
    }
    const working = [agent('ag', { status: 'running', lastActivityAt: NOW + 20_000 }), agent('other', { status: 'running' })]
    const calls = [record('c1', deliveredTaskId('b'), NOW + 12_000, { agentId: 'ag', endedAt: NOW + 15_000, status: 'ok' })]
    expect(promptFacts(b, calls, NOW + 30_000, working)).toMatchObject({ isRunning: true, durationMs: 28_000, agents: 1, calls: 1 })
    expect(statusOf(b, promptFacts(b, calls, NOW + 30_000, working)).text).toBe('● Running')
    const done = [agent('ag', { status: 'completed', endedAt: NOW + 40_000, lastActivityAt: NOW + 40_000 })]
    expect(promptFacts(b, calls, NOW + 60_000, done)).toMatchObject({ isRunning: false, endedAt: NOW + 40_000, durationMs: 38_000 })
    expect(statusOf(b, promptFacts(b, calls, NOW + 60_000, done))).toEqual({ text: '✓ Done', tone: 'success' })
    // Without its agents known, its turn's end and its calls' say when it ended.
    expect(promptFacts(b, calls, NOW + 60_000)).toMatchObject({ isRunning: false, endedAt: NOW + 15_000 })
  })
})

/** An Agent call's spawn, as the engine raises it. */
const spawnFor = (fields: Pick<AgentSpawnInput, 'tool_use_id' | 'description' | 'prompt'> & Partial<AgentSpawnInput>): AgentSpawnInput => ({
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
  ...fields,
})

/** One model request: the main loop's, or a sub-agent's. */
const stepIn = async ($: Engine, turnId: string, index: number, agentId?: string): Promise<void> => {
  const model = agentId === undefined ? 'claude-opus-5-5' : 'claude-sonnet-5-5'
  for await (const chunk of $.turn.step({ turnId, index, model, effort: 'high', messageCount: 3, ...(agentId !== undefined ? { agentId } : {}) })) {
    expect(chunk).toBeDefined()
  }
}

/** The Commands tab's groups as drawn: each group's header, and the calls under it. */
const drawnGroups = async (ui: FindsAll): Promise<Map<string, string[]>> => {
  const groups = new Map<string, string[]>()
  let current: string[] = []
  for (const client of await ui.findAll({ type: 'Client' })) {
    const key = client.key ?? ''
    if (key.startsWith('grp:')) {
      current = []
      groups.set(key, current)
    } else if (key.startsWith('cmd:')) {
      current.push(key)
    }
  }
  return groups
}

/** A turn of A, with a call of its own, and B typed while it runs. */
const typedDuringTurn = async ($: Engine, clock: ReturnType<typeof world>): Promise<void> => {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.prompt.submit({ text: TURN_PROMPT, wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: TURN_PROMPT, turnId: 't1' })
  await clock.settle()
  await call($, { tool: 'Bash', command: 'npm test -- login', description: 'Run the login test', tool_use_id: 'toolu_a' })
  await clock.advance(2_000)
  await $.prompt.submit({ text: TYPED_PROMPT, turnId: 't1', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
}

/** The main loop spawns a sub-agent with B's words; it asks the model once and makes three calls. */
const agentForB = async ($: Engine, clock: ReturnType<typeof world>): Promise<void> => {
  await call($, { tool: 'Agent', description: 'Implement partial diff copy', prompt: QUOTING_B, subagent_type: 'general-purpose', run_in_background: true, tool_use_id: 'toolu_spawn' })
  await $.agent.spawn(spawnFor({ tool_use_id: 'toolu_spawn', description: 'Implement partial diff copy', prompt: QUOTING_B }))
  await clock.settle()
  stepUsage.value = { input_tokens: 2_000, output_tokens: 1_000, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 3_000, model: 'claude-sonnet-5-5' }
  await stepIn($, 'ta', 0, 'ag-diff')
  await call($, { tool: 'Read', file_path: '/repo/hooks/view/diff.tsx', agentId: 'ag-diff', tool_use_id: 'toolu_r' })
  await call($, { tool: 'Grep', pattern: 'select', agentId: 'ag-diff', tool_use_id: 'toolu_g' })
  await call($, { tool: 'Edit', file_path: '/repo/hooks/view/diff.tsx', old_string: 'a', new_string: 'b', agentId: 'ag-diff', tool_use_id: 'toolu_e' })
  await clock.settle()
}

describe('the pane: a prompt typed while a turn runs', () => {
  test("taken into the running turn, it gets a task of its own: the sub-agent spawned for it files its calls, requests and cost there, not under the turn's prompt", { timeoutMs: 30_000 }, async ($, on) => {
    on('agent.list', () => ({ value: [] }))
    on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'ag-diff' }))
    on('classic.Stop', () => ({}))
    promptEvents(on)
    const clock = world(on)
    await typedDuringTurn($, clock)
    const [a, b] = await promptIds($)
    const aKey = `prm:${keyOf(a ?? '')}`
    const bKey = `prm:${keyOf(b ?? '')}`
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:prompts' })
    // Typed while A runs, B waits.
    expect((await textsIn(ui, bKey)).join('\n')).toContain('○ Queued')

    // The turn's next request carries it: folded in, it runs, with no turn of its own.
    await $.prompt.attachment({ type: 'queued_command', text: folded(TYPED_PROMPT), origin: { kind: 'engine' } })
    await clock.settle()
    expect((await textsIn(ui, bKey)).join('\n')).toContain('● Running')
    await agentForB($, clock)

    // B's card holds the sub-agent's calls, its request's tokens and cost, and the agent.
    const running = (await textsIn(ui, bKey)).join('\n')
    for (const text of ['● Running', 'Tool calls\n3', 'Read ×1', 'Grep ×1', 'Edit ×1', 'Requests\n1', '45k in (40k cached) · 1k out', '≈ $0.03', 'Agents 1\n·\nImplement partial diff copy\ngeneral-purpose', 'typed · into a running turn']) {
      expect(running).toContain(text)
    }
    expect(running).not.toContain('Queued')
    // A's holds its own: its call and the Agent call its loop made, not the sub-agent's.
    const turn = (await textsIn(ui, aKey)).join('\n')
    for (const text of ['● Running', 'Tool calls\n2', 'Bash ×1', 'Agent ×1']) {
      expect(turn).toContain(text)
    }
    // Its Agent call spawned the agent for B, so A's card has no Agents section.
    for (const text of ['Read ×1', 'Grep ×1', 'Edit ×1', 'into a running turn', 'Agents ']) {
      expect(turn).not.toContain(text)
    }

    // The turn ends; B's agent works on, and B with it.
    await clock.advance(3_000)
    await $.turn.complete({ answer: 'ok', durationMs: 5_000, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.settle()
    expect((await textsIn(ui, aKey)).join('\n')).toContain('✓ Done')
    expect((await textsIn(ui, bKey)).join('\n')).toContain('● Running')
    // Its agent ends: B ends with it, its time from sent to then, the 5-hour window read again then; A's is not.
    await clock.advance(5_000)
    limits.percentUsed = 41
    await $.turn.complete({ answer: 'done', durationMs: 8_000, isAborted: false, turnId: 'ta', reason: 'answer', agentId: 'ag-diff' })
    await clock.settle()
    const done = (await textsIn(ui, bKey)).join('\n')
    expect(done).toContain('✓ Done')
    expect(done).toContain(`Ended\n${fmtClock(NOW + 10_000, NOW + 10_000)}`)
    expect(done).toContain('Duration\n8.0s')
    expect(done).toContain('5-hour window\n+1.0% (40.0% → 41.0%)')
    expect((await textsIn(ui, aKey)).join('\n')).toContain('5-hour window\n+0.0% (40.0% → 40.0%)')

    // The Commands tab: the sub-agent's calls under B's group, A's own under A's.
    await ui.press({ key: 'tab:commands' })
    const groups = await drawnGroups(ui)
    expect([...(groups.get(`grp:${keyOf(deliveredTaskId(b ?? ''))}`) ?? [])].sort()).toEqual(['cmd:toolu_e', 'cmd:toolu_g', 'cmd:toolu_r'])
    expect([...(groups.get(`grp:${keyOf('t1')}`) ?? [])].sort()).toEqual(['cmd:toolu_a', 'cmd:toolu_spawn'])
    // Overview's card for B counts them too.
    await ui.press({ key: 'tab:overview' })
    expect((await textsIn(ui, `ovp:${keyOf(b ?? '')}`)).join('\n')).toContain('3 calls')
    await ui.unmount()
    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await desktop.press({ key: 'tab:prompts' })
    expect((await textsIn(desktop, bKey)).join('\n')).toContain('✓ Done')
  })

  test('with no word that the turn took it in, a sub-agent spawned with its words shows the turn did, and serves it', { timeoutMs: 30_000 }, async ($, on) => {
    on('agent.list', () => ({ value: [] }))
    on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'ag-diff' }))
    promptEvents(on)
    const clock = world(on)
    await typedDuringTurn($, clock)
    await agentForB($, clock)
    const [, b] = await promptIds($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:prompts' })
    const card = (await textsIn(ui, `prm:${keyOf(b ?? '')}`)).join('\n')
    for (const text of ['● Running', 'Tool calls\n3', 'Read ×1', 'into a running turn']) {
      expect(card).toContain(text)
    }
    await ui.press({ key: 'tab:commands' })
    expect([...((await drawnGroups(ui)).get(`grp:${keyOf(deliveredTaskId(b ?? ''))}`) ?? [])].sort()).toEqual(['cmd:toolu_e', 'cmd:toolu_g', 'cmd:toolu_r'])
  })

  test("a workflow's later agents serve the prompt its first agent serves, and an agent's own agents its prompt", { timeoutMs: 30_000 }, async ($, on) => {
    on('agent.list', () => ({ value: [] }))
    on('agent.spawn', ($, e) => ({ model: 'claude-sonnet-5-5', agentId: e.workflow !== undefined ? `wf-${e.workflow.agentIndex}` : 'nested' }))
    promptEvents(on)
    const clock = world(on)
    await typedDuringTurn($, clock)
    await $.prompt.attachment({ type: 'queued_command', text: folded(TYPED_PROMPT), origin: { kind: 'engine' } })
    await clock.settle()
    // The workflow's first agent restates B.
    await call($, { tool: 'Workflow', script: "export const meta = { name: 'diff-copy' }", tool_use_id: 'toolu_wf' })
    await $.agent.spawn(spawnFor({ tool_use_id: 'toolu_wf', description: 'Read the diff view', prompt: QUOTING_B, workflow: { runId: 'wf_run2', agentIndex: 1 } }))
    await clock.settle()
    // C is typed and taken in; the workflow's next agent says nothing of either, and the first agent starts one of its own.
    const changelog = 'and write the changelog entry for the release notes once that works'
    await clock.advance(1_000)
    await $.prompt.submit({ text: changelog, turnId: 't1', wait: false, origin: { kind: 'composer' } })
    await $.prompt.attachment({ type: 'queued_command', text: folded(changelog), origin: { kind: 'engine' } })
    await $.agent.spawn(spawnFor({ tool_use_id: 'toolu_wf', description: 'Judge it', prompt: 'Judge the result', workflow: { runId: 'wf_run2', agentIndex: 2 } }))
    await $.agent.spawn(spawnFor({ tool_use_id: 'toolu_inner', description: 'Look around', prompt: 'List the files', parentAgentId: 'wf-1' }))
    await clock.settle()
    for (const [agentId, id] of [['wf-1', 'toolu_1'], ['wf-2', 'toolu_2'], ['nested', 'toolu_3']] as const) {
      await call($, { tool: 'Read', file_path: `/repo/${id}`, agentId, tool_use_id: id })
    }
    await clock.settle()
    const [, b, c] = await promptIds($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:prompts' })
    // B's three agents, the workflow's two under it, one name to a line.
    const named = await textsIn(ui, promptAgentsKey(b ?? ''))
    expect(named.filter(text => !['·', '⎇', 'general-purpose'].includes(text))).toEqual(['Agents 3 · 1 workflow', 'review-pr', 'workflow · 2 agents', 'Read the diff view', 'Judge it', 'Look around'])
    const taken = (await textsIn(ui, `prm:${keyOf(c ?? '')}`)).join('\n')
    expect(taken).toContain('into a running turn')
    expect(await ui.find({ key: promptAgentsKey(c ?? '') })).toBeUndefined()
    await ui.press({ key: 'tab:commands' })
    const groups = await drawnGroups(ui)
    expect([...(groups.get(`grp:${keyOf(deliveredTaskId(b ?? ''))}`) ?? [])].sort()).toEqual(['cmd:toolu_1', 'cmd:toolu_2', 'cmd:toolu_3'])
    expect(groups.has(`grp:${keyOf(deliveredTaskId(c ?? ''))}`)).toBe(false)
  })

  test('not taken in, it waits for the turn to end; then a turn of its own runs it', { timeoutMs: 30_000 }, async ($, on) => {
    promptEvents(on)
    const clock = world(on)
    await typedDuringTurn($, clock)
    await clock.advance(1_000)
    await $.turn.complete({ answer: 'ok', durationMs: 3_000, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.settle()
    const [, b] = await promptIds($)
    const bKey = `prm:${keyOf(b ?? '')}`
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:prompts' })
    expect((await textsIn(ui, bKey)).join('\n')).toContain('○ Queued')
    // Its own turn starts: it runs, and the calls of that turn are its.
    await $.turn.start({ text: TYPED_PROMPT, turnId: 't2' })
    await clock.settle()
    await call($, { tool: 'Edit', file_path: '/repo/hooks/view/diff.tsx', old_string: 'a', new_string: 'b', tool_use_id: 'toolu_own' })
    await clock.settle()
    const card = (await textsIn(ui, bKey)).join('\n')
    expect(card).toContain('● Running')
    expect(card).toContain('Edit ×1')
    expect(card).not.toContain('into a running turn')
    await clock.advance(4_000)
    await $.turn.complete({ answer: 'ok', durationMs: 4_000, isAborted: false, turnId: 't2', reason: 'answer' })
    await clock.settle()
    expect((await textsIn(ui, bKey)).join('\n')).toContain('✓ Done')
    await ui.press({ key: 'tab:commands' })
    expect((await drawnGroups(ui)).get(`grp:${keyOf('t2')}`)).toEqual(['cmd:toolu_own'])
  })

  test('two prompts of the same words typed during a turn: the turn takes in one, the other waits for a turn of its own', { timeoutMs: 30_000 }, async ($, on) => {
    promptEvents(on)
    const clock = world(on)
    await typedDuringTurn($, clock)
    await clock.advance(1_000)
    await $.prompt.submit({ text: TYPED_PROMPT, turnId: 't1', wait: false, origin: { kind: 'composer' } })
    await clock.settle()
    await $.prompt.attachment({ type: 'queued_command', text: folded(TYPED_PROMPT), origin: { kind: 'engine' } })
    await clock.settle()
    await $.turn.complete({ answer: 'ok', durationMs: 4_000, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.settle()
    const [, first, second] = await promptIds($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:prompts' })
    const taken = (await textsIn(ui, `prm:${keyOf(first ?? '')}`)).join('\n')
    expect(taken).toContain('✓ Done')
    expect(taken).toContain('into a running turn')
    expect((await textsIn(ui, `prm:${keyOf(second ?? '')}`)).join('\n')).toContain('○ Queued')
    // The other's own turn runs it: no new record of the same words, nothing left waiting.
    await $.turn.start({ text: TYPED_PROMPT, turnId: 't2' })
    await clock.settle()
    const own = (await textsIn(ui, `prm:${keyOf(second ?? '')}`)).join('\n')
    expect(own).toContain('● Running')
    expect(own).not.toContain('into a running turn')
    expect(await promptIds($)).toHaveLength(3)
  })
})

describe('the pane: what a prompt used', () => {
  const SOON = new Date(NOW + 3_600_000).toISOString()
  const SMALL = { input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 2_000, model: 'claude-opus-5-5' }

  test("its card: the context its own requests carried, and how far the 5-hour and weekly windows rose while it ran", { timeoutMs: 30_000 }, async ($, on) => {
    promptEvents(on)
    const clock = world(on)
    limits.percentUsed = 24.8
    limits.resetsAt = SOON
    weekly.percentUsed = 61.2
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await $.turn.start({ text: 'fetch the data', turnId: 't1' })
    await clock.settle()
    stepUsage.value = SMALL
    await stepIn($, 't1', 0)
    limits.percentUsed = 26
    weekly.percentUsed = 61.5
    stepUsage.value = { ...SMALL, input_tokens: 2_000, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 3_000 }
    await stepIn($, 't1', 1)
    await clock.advance(5_000)
    await $.turn.complete({ answer: 'done', durationMs: 5_000, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.settle()
    const [first] = await promptIds($)
    const firstKey = `prm:${keyOf(first ?? '')}`

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:prompts' })
    const card = (await textsIn(ui, firstKey)).join('\n')
    expect(card).toContain('Context\n35k (18% of 200k) · +12k')
    expect(card).toContain('5-hour window\n+1.2% (24.8% → 26.0%)')
    expect(card).toContain('Weekly window\n+0.3% (61.2% → 61.5%)')
    expect(await ui.find({ type: 'Text', text: /other sessions running then move them too/ })).toBeDefined()

    // The next prompt costs something while the windows stand still: the 5-hour figure is its cost at the
    // session's measured rate, the weekly one under a step; a measurement that moves the window while it runs counts.
    await clock.advance(10_000)
    await $.turn.start({ text: 'and add a retry', turnId: 't2' })
    await clock.settle()
    stepUsage.value = SMALL
    await stepIn($, 't2', 0)
    await clock.settle()
    const [, second] = await promptIds($)
    const secondKey = `prm:${keyOf(second ?? '')}`
    const still = (await textsIn(ui, secondKey)).join('\n')
    expect(still).toContain('Context\n23k (12% of 200k) · +0')
    expect(still).toMatch(/5-hour window\n≈ \d\.\d+% \(26\.0% → 26\.0%\)/)
    expect(still).toContain('Weekly window\n< 0.1% (61.5% → 61.5%)')
    // Overview's small card has the 5-hour figure; it reads no spend, so no estimate there: read in whole
    // points at both ends (26 → 26), the window is taken to rise a point at a time.
    await ui.press({ key: 'tab:overview' })
    expect((await textsIn(ui, `ovp:${keyOf(first ?? '')}`)).join('\n')).toContain('5h +1.2%')
    expect((await textsIn(ui, `ovp:${keyOf(second ?? '')}`)).join('\n')).toContain('5h < 1%')

    limits.percentUsed = 27.5
    await $.session.measure({ context: { window: 200_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 27.5, resetsAt: SOON }], changed: ['rateLimits'] })
    await clock.settle()
    await ui.press({ key: 'tab:prompts' })
    expect((await textsIn(ui, secondKey)).join('\n')).toContain('5-hour window\n+1.5% (26.0% → 27.5%)')
    // The first prompt had ended: the measurement is not its.
    expect((await textsIn(ui, firstKey)).join('\n')).toContain('5-hour window\n+1.2% (24.8% → 26.0%)')
  })
})

/** This session's prompt ids, oldest first, as the project's history keeps them. */
const promptIds = async ($: Engine): Promise<string[]> => {
  expect($).toBeDefined()
  return readStored(memoryStore.get(storeKey('/repo')))
    .filter(one => one.sessionId === SESSION_ID)
    .map(one => one.id)
}

describe('Find in conversation presses the keys', () => {
  test('the script presses ⌘F, ⌘A, ⌘V and Return, and only while the app is in front', () => {
    const [command, flag, script] = findKeystrokes()
    expect([command, flag]).toEqual(['osascript', '-e'])
    expect(script).toContain(`is not "${FIND_APP}" then return "not-front"`)
    const order = ['keystroke "f" using command down', 'keystroke "a" using command down', 'keystroke "v" using command down', 'key code 36']
    expect(order.map(step => script?.indexOf(step) ?? -1)).toEqual([...order.map(step => script?.indexOf(step) ?? -1)].sort((a, b) => a - b))
    expect(order.every(step => (script ?? '').includes(step))).toBe(true)
  })

  test('pressed: no toast; denied: what to press and how to allow it; not in front: what to press', { timeoutMs: 30_000 }, async ($, on) => {
    const toasts: string[] = []
    const clock = world(on, toasts)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await $.turn.start({ text: 'now add a retry', turnId: 't1' })
    await clock.settle()
    const [id] = await promptIds($)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'tab:prompts' })
    const key = `pjump:${keyOf(id ?? '')}`

    keystrokes.answer = { exitCode: 0, stdout: 'pressed\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    await ui.press({ key })
    expect(keystrokes.runs).toEqual([findKeystrokes()])
    expect(clipboard.texts.at(-1)).toBe('now add a retry')
    expect(toasts).toEqual([])

    await clock.advance(1_000)
    keystrokes.answer = { exitCode: 1, stdout: '', stderr: 'System Events got an error: osascript is not allowed assistive access. (-1719)', isStdoutTruncated: false, isStderrTruncated: false }
    await ui.press({ key })
    expect(toasts.at(-1)).toBe(`${findAsked('now add a retry')} To have the button press them, switch on “Claude Code” in System Settings → Privacy & Security → Accessibility.`)

    await clock.advance(1_000)
    keystrokes.answer = { exitCode: 0, stdout: 'not-front\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    await ui.press({ key })
    expect(toasts.at(-1)).toBe(findAsked('now add a retry'))
  })
})
