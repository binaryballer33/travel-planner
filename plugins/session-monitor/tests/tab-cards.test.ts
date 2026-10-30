// The card look on Overview, Files, Commits, Sources and Resources: each
// section a card (rounded, softly filled on the desktop, plain in the
// terminal), an opened item a card under its row, key numbers as figures,
// and memory with its share of the Mac's RAM. Overview's live figures are the
// header's alone.

import { expect, test } from 'claude-code/testing'

import { keyOf } from '../hooks/lib/format'
import { WORKTREE } from '../hooks/lib/git'
import { COMMITS_CARD_KEY, commitCardKey, commitKey, fileKey, NET_CARD_KEY } from '../hooks/view/commits'
import { DIFF_PANEL_KEY } from '../hooks/view/diff'
import { FILES_CARD_KEY, touchedKey } from '../hooks/view/files'
import { CALL_BACKGROUND, CALL_EDGE, callCardKey, callEdge, CARD_BACKGROUND, TITLE_COLOR } from '../hooks/view/kit'
import { OVERVIEW_CARDS } from '../hooks/view/overview'
import { BOARD_CARD_KEY, GROUPS_CARD_KEY } from '../hooks/view/resources'
import { SEARCHES_CARD_KEY, SOURCES_SUMMARY_KEY, WEBSITES_CARD_KEY } from '../hooks/view/sources'
import { taskCardKey, TASKS_CARD_KEY, taskKey } from '../hooks/view/sources-tasks'
import { call, clickRow, isOpenRow, keysIn, keysOf, laterTicks, NOW, PANE, seconds, SHA, start, textsIn, TICK, world, rowsIn, tabButton } from './world'

type Surface = 'terminal' | 'desktop'

type Finds = { find: (query: { key: string }) => Promise<{ props: Record<string, unknown> } | undefined> }

/** Whether the element keyed `key` is drawn as a card: a rounded box, softly filled on the desktop alone. */
const isCard = async (ui: Finds, key: string, surface: Surface): Promise<boolean> => {
  const props = (await ui.find({ key }))?.props
  return props?.borderStyle === 'round' && props.backgroundColor === (surface === 'desktop' ? CARD_BACKGROUND : undefined)
}

/** The texts drawn in a card, one per line. */
const cardText = async (ui: Parameters<typeof textsIn>[0], key: string): Promise<string> => (await textsIn(ui, key)).join('\n')

/** The shell of a `make build` in the background, as the sampler sees it a second after the first tick: 1.2 GB now, 1.3 GB at its peak. */
const BUILD = {
  id: 'p:50:1',
  kind: 'bash',
  label: 'make build',
  cmd: 'make build',
  pid: 50,
  procs: 2,
  startedAt: seconds(NOW),
  mem: 1.2e9,
  peakMem: 1.3e9,
  cpuPct: 80,
  watts: 2,
  netInBps: 0,
  netOutBps: 0,
  tot: { cpuS: 3, energyJ: 4 },
}

test("overview: the live figures are the header's alone; its sections are cards, in the order asked for", { timeoutMs: 20_000 }, async ($, on) => {
  const clock = world(on)
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // The header strip above every tab carries the live rates; Overview repeats none of them.
    expect(await ui.find({ type: 'Text', text: '⇅ 14.4 MB' })).toBeDefined()
    for (const gone of ['Live stats', 'Down', 'Up', 'Power', 'Memory', 'Running']) {
      expect(await ui.find({ type: 'Text', text: new RegExp(`^${gone}$`) })).toBeUndefined()
    }
    // Its sections are cards, in order: Prompts right under Models & effort, right above Agents;
    // Running now right under Commands; Session right above Heaviest commands.
    const cards: string[] = Object.values(OVERVIEW_CARDS)
    expect(cards).toEqual([
      OVERVIEW_CARDS.controls,
      OVERVIEW_CARDS.models,
      OVERVIEW_CARDS.prompts,
      OVERVIEW_CARDS.agents,
      OVERVIEW_CARDS.recent,
      OVERVIEW_CARDS.commands,
      OVERVIEW_CARDS.running,
      OVERVIEW_CARDS.session,
      OVERVIEW_CARDS.top,
      OVERVIEW_CARDS.tools,
      OVERVIEW_CARDS.time,
      OVERVIEW_CARDS.artifacts,
    ])
    expect((await keysOf(ui, 'card:ov:')).filter(key => cards.includes(key))).toEqual(cards)
    for (const key of cards) {
      expect(await isCard(ui, key, surface)).toBe(true)
    }
    // The models as figures.
    const models = await cardText(ui, OVERVIEW_CARDS.models)
    expect(models).toContain('Model\nOpus 5.5')
    expect(models).toContain('Effort\nxhigh')
    expect(models).toContain('Tool calls\n5')
    // Session keeps what only Live stats had: the 5-hour window, and the way to the charts.
    const session = await cardText(ui, OVERVIEW_CARDS.session)
    expect(session).toContain('Cost\n$1.23')
    expect(session).toContain('50k / 200k tokens')
    expect(session).toMatch(/5-hour window\n.*40%\nused/)
    expect(session).toContain('Sources\n4 URLs on 3 sites\n1 search')
    expect(session).toContain('[Charts in Compute]')
    expect(session).toContain('[Compact]')
    // Running now keeps the calls running and the agents working, even with none.
    const running = await cardText(ui, OVERVIEW_CARDS.running)
    expect(running).toContain('Calls running\n0')
    expect(running).toContain('Agents working\n0')
    expect(running).toContain('Nothing running. A call shows here while it runs, and for a few seconds after it ends.')
    // Time spent as figures.
    const time = await cardText(ui, OVERVIEW_CARDS.time)
    expect(time).toContain('Internet active\n28s\n100% of the time')
    expect(time).toContain('Moved\n14.4 MB\nat 525 kB/s while active')
    // Charts in Compute opens the charts.
    await ui.press({ key: 'ov:compute' })
    expect((await tabButton(ui, 'compute'))?.props.variant).toBe('primary')
    await ui.press({ key: 'tab:overview' })
  }
})

test('overview: Most recent commands are blue-titled rows, each in a card of its own, edged by its status, with room between them', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = world(on)
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // The five calls of the session, the newest first, each in its card.
    const rows = (await keysIn(ui, OVERVIEW_CARDS.recent, 'recent')).filter(key => key.startsWith('recent:'))
    expect(rows).toHaveLength(5)
    for (const key of rows) {
      const id = key.slice('recent:'.length)
      const box = await ui.find({ key: callCardKey(id) })
      expect(box?.props.borderStyle).toBe('round')
      expect(box?.props.borderColor).toBe(callEdge('ok', surface))
      expect(box?.props.backgroundColor).toBe(surface === 'terminal' ? undefined : CALL_BACKGROUND)
      expect(box?.props.paddingX).toBe(surface === 'terminal' ? 1 : 2)
    }
    // No rules any more: the cards' own edges part them.
    expect(await ui.findAll({ type: 'Text', text: /^─+$/ })).toHaveLength(0)
    // Their titles in the title blue, as the Commands tab's are: the shell command's, for one.
    const titles = await Promise.all(rows.map(async key => (await ui.findAll({ in: key, type: 'Text' })).find(text => text.text === 'Fetch the data')))
    expect(titles.find(found => found !== undefined)?.props.color).toBe(TITLE_COLOR)
    await ui.unmount()
  }
})

test('a call card is edged by its status: red when it failed, amber while it runs, grey when stopped, the faint title blue when done', () => {
  expect(callEdge('error', 'desktop')).toBe('error')
  expect(callEdge('running', 'desktop')).toBe('warning')
  expect(callEdge('background', 'terminal')).toBe('warning')
  expect(callEdge('denied', 'desktop')).toBe('inactive')
  expect(callEdge('ok', 'desktop')).toBe(CALL_EDGE)
  expect(callEdge('ok', 'terminal')).toBe('subtle')
})

test("overview: a call's memory reads with its share of the RAM, in Running now and the heaviest commands; their rows open it", { timeoutMs: 20_000 }, async ($, on) => {
  const clock = world(on)
  laterTicks.value = [{ ...TICK, t: seconds(NOW + 2_000), groups: [...TICK.groups, BUILD], ended: [] }]
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await call($, { tool: 'Bash', command: 'make build', description: 'Build the app', run_in_background: true, tool_use_id: 'toolu_build' })
  await clock.advance(1_000)
  await clock.advance(1_000)
  await clock.settle()
  const heaviest = `top:${keyOf('Most memory')}`
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // The build runs on in the background, holding 1.2 GB of the world's 16 GB.
    expect(await ui.find({ in: 'run:toolu_build', type: 'Text', text: '1.20 GB (7.0%)' })).toBeDefined()
    expect(await ui.find({ in: 'run:toolu_build', type: 'Text', text: 'Build the app' })).toBeDefined()
    expect(await cardText(ui, OVERVIEW_CARDS.running)).toContain('Calls running\n1')
    // The most memory any command used: its peak.
    expect(await ui.find({ in: heaviest, type: 'Text', text: '1.30 GB (7.6%)' })).toBeDefined()
    expect(await ui.find({ in: heaviest, type: 'Text', text: 'Most memory' })).toBeDefined()
    // Resources: the shell's group and the whole session, and the commands by memory.
    await ui.press({ key: 'tab:resources' })
    expect(await ui.find({ type: 'Text', text: '1.20 GB (7.0%)' })).toBeDefined()
    // The header strip shows the session's memory too, plain; the whole-session row's is bold.
    expect((await ui.findAll({ type: 'Text', text: '439 MB (2.6%)' })).some(found => found.props.bold === true)).toBe(true)
    await ui.select({ key: 'sort', value: 'mem' })
    expect(await cardText(ui, BOARD_CARD_KEY)).toMatch(/Commands by memory\ntop 1\n[^]*1\.30 GB \(7\.6%\)/)
    await ui.select({ key: 'sort', value: 'energy' })
    await ui.press({ key: 'tab:overview' })
    await ui.unmount()
  }
  // A click on a Running now row opens the call in Commands.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clickRow(ui, 'run:toolu_build')
  expect((await tabButton(ui, 'commands'))?.props.variant).toBe('primary')
  expect(await isOpenRow(ui, 'cmd:toolu_build')).toBe(true)
  // Where no Client is drawn, a heaviest command's title is a button that opens it the same way.
  await clock.advance(1_000)
  const plain = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await plain.press({ key: 'tab:overview' })
  await plain.press({ key: heaviest })
  expect((await tabButton(plain, 'commands'))?.props.variant).toBe('primary')
})

test('overview: a call holding a sliver of the RAM reads <0.1% in Running now, never 0.0%', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = world(on)
  // A shell waiting in the background holds 5 MB of the world's 16 GB: 0.03% of it.
  const idle = { ...BUILD, id: 'p:60:1', label: 'sleep 600', cmd: 'sleep 600', pid: 60, procs: 1, mem: 5e6, peakMem: 5e6, cpuPct: 0, watts: 0 }
  laterTicks.value = [{ ...TICK, t: seconds(NOW + 2_000), groups: [...TICK.groups, idle], ended: [] }]
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await call($, { tool: 'Bash', command: 'sleep 600', description: 'Wait ten minutes', run_in_background: true, tool_use_id: 'toolu_sleep' })
  await clock.advance(1_000)
  await clock.advance(1_000)
  await clock.settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ in: 'run:toolu_sleep', type: 'Text', text: '5.00 MB (<0.1%)' })).toBeDefined()
    expect(await ui.find({ in: 'run:toolu_sleep', type: 'Text', text: /\(0\.0%\)/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('files: the counts and the list are one card, and the open file a card under its row', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = world(on)
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:files' })
    expect(await isCard(ui, FILES_CARD_KEY, surface)).toBe(true)
    const files = await cardText(ui, FILES_CARD_KEY)
    expect(files).toContain('3 this session, the latest first')
    expect(files).toContain('Created\n2\nModified\n1\nDeleted\n0\nRead\n0')
    // The filter narrows the list, and the card says how many it shows.
    await ui.select({ key: 'filefilter', value: 'created' })
    expect(await cardText(ui, FILES_CARD_KEY)).toContain('2 of 3 shown, the latest first')
    await ui.select({ key: 'filefilter', value: 'all' })
    // Opened, a file's diff is a card of its own inside the list's, its buttons first.
    await clickRow(ui, touchedKey('/repo/src/app.py'))
    await clock.settle()
    expect(await isCard(ui, DIFF_PANEL_KEY, surface)).toBe(true)
    expect(await textsIn(ui, DIFF_PANEL_KEY)).toEqual(expect.arrayContaining(['[Changes only]', '[Whole file]', '[Copy diff]', '[Close]']))
    expect(await cardText(ui, FILES_CARD_KEY)).toContain('[Copy diff]')
    await ui.press({ key: 'diff:close' })
    expect(await keysOf(ui, DIFF_PANEL_KEY)).toEqual([])
    await clock.advance(1_000)
  }
})

test('commits: the net change is a card of figures, the list a card, an opened commit a card under its row', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = world(on)
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:commits' })
    expect(await keysOf(ui, 'card:commits:')).toEqual([NET_CARD_KEY, COMMITS_CARD_KEY])
    expect(await isCard(ui, NET_CARD_KEY, surface)).toBe(true)
    expect(await isCard(ui, COMMITS_CARD_KEY, surface)).toBe(true)
    const net = await cardText(ui, NET_CARD_KEY)
    for (const name of ['Added', 'Modified', 'Deleted', 'Lines added', 'Lines removed']) {
      expect(net).toContain(name)
    }
    expect(net).toContain("2 files · this session's commits and what is not committed yet")
    expect(await cardText(ui, COMMITS_CARD_KEY)).toContain('This session · 1 commit')
    // The session's commit opens to a card edged in the accent, its message and files inside.
    await clickRow(ui, commitKey(SHA))
    const commit = commitCardKey(SHA)
    expect(await isCard(ui, commit, surface)).toBe(true)
    expect((await ui.find({ key: commit }))?.props.borderColor).toBe('claude')
    const detail = await cardText(ui, commit)
    expect(detail).toContain('feat: add the thing')
    expect(detail).toContain('Why it matters.')
    // Its file's diff is a card inside the commit's.
    await clickRow(ui, fileKey(SHA, 'src/app.py'))
    await clock.settle()
    expect(await cardText(ui, commit)).toContain('[Copy diff]')
    await ui.press({ key: 'diff:close' })
    await clock.advance(1_000)
    await clickRow(ui, commitKey(SHA))
    expect(await keysOf(ui, commit)).toEqual([])
    // The uncommitted changes open to a card edged in the warning tone.
    await clock.advance(1_000)
    await clickRow(ui, 'commit:worktree')
    expect((await ui.find({ key: commitCardKey(WORKTREE) }))?.props.borderColor).toBe('warning')
    await clock.advance(1_000)
    await clickRow(ui, 'commit:worktree')
    await clock.advance(1_000)
  }
})

test('sources: the counts are a card of figures; searches, websites and tasks are cards, an opened task one too', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = world(on)
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:sources' })
    expect(await keysOf(ui, 'card:sources:')).toEqual([SOURCES_SUMMARY_KEY, SEARCHES_CARD_KEY, WEBSITES_CARD_KEY])
    for (const key of [SOURCES_SUMMARY_KEY, SEARCHES_CARD_KEY, WEBSITES_CARD_KEY]) {
      expect(await isCard(ui, key, surface)).toBe(true)
    }
    const summary = await cardText(ui, SOURCES_SUMMARY_KEY)
    expect(summary).toContain('URLs\n4\non 3 websites')
    expect(summary).toContain('Searches\n1')
    expect(summary).toContain('Pages opened\n1\n5.12 kB')
    expect(await cardText(ui, SEARCHES_CARD_KEY)).toContain('1 search, the latest first')
    expect(await cardText(ui, WEBSITES_CARD_KEY)).toContain('3 websites, the busiest first')
    // Fetched pages only: no searches card.
    await ui.select({ key: 'sourcefilter', value: 'fetch' })
    expect(await keysOf(ui, 'card:sources:')).toEqual([SOURCES_SUMMARY_KEY, WEBSITES_CARD_KEY])
    await ui.select({ key: 'sourcefilter', value: 'all' })
    // By task: the tasks are a card; an opened task's sources a card under its row, which shows the open bar.
    await ui.select({ key: 'sourceview', value: 'task' })
    await clock.settle()
    expect(await keysOf(ui, 'card:sources:')).toEqual([SOURCES_SUMMARY_KEY, TASKS_CARD_KEY])
    expect(await isCard(ui, TASKS_CARD_KEY, surface)).toBe(true)
    await clickRow(ui, taskKey('t1'))
    await clock.settle()
    expect(await isCard(ui, taskCardKey('t1'), surface)).toBe(true)
    expect(await isOpenRow(ui, taskKey('t1'))).toBe(true)
    expect(await cardText(ui, taskCardKey('t1'))).toContain('spy options')
    await clock.advance(1_000)
    await clickRow(ui, taskKey('t1'))
    await clock.settle()
    expect(await keysOf(ui, taskCardKey('t1'))).toEqual([])
    await ui.select({ key: 'sourceview', value: 'site' })
    await clock.advance(1_000)
  }
})

test('resources: the process groups and the ranked commands are cards; memory reads with its share of the RAM', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = world(on)
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:resources' })
    expect(await keysOf(ui, 'card:resources:')).toEqual([GROUPS_CARD_KEY, BOARD_CARD_KEY])
    expect(await isCard(ui, GROUPS_CARD_KEY, surface)).toBe(true)
    expect(await isCard(ui, BOARD_CARD_KEY, surface)).toBe(true)
    // The Claude engine holds 300 MB of 16 GB; the whole session 439 MB, in bold.
    const groups = await cardText(ui, GROUPS_CARD_KEY)
    expect(groups).toContain('300 MB (1.7%)')
    expect(groups).toContain('19.0 MB (0.1%)')
    // The header strip shows the session's memory too, plain; the whole-session row's is bold.
    expect((await ui.findAll({ type: 'Text', text: '439 MB (2.6%)' })).some(found => found.props.bold === true)).toBe(true)
    // Sorted by memory, a command's peak with its share.
    await ui.select({ key: 'sort', value: 'mem' })
    expect(await cardText(ui, BOARD_CARD_KEY)).toContain('9.00 MB (0.1%)')
    expect(await cardText(ui, GROUPS_CARD_KEY)).toContain('by memory')
    await ui.select({ key: 'sort', value: 'energy' })
    await ui.unmount()
  }
  // In a narrow terminal the rule over the whole session's row stays inside its card, on one line.
  const narrow = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 90 } })
  await narrow.press({ key: 'tab:resources' })
  const rule = (await textsIn(narrow, GROUPS_CARD_KEY)).find(text => text.startsWith('─')) ?? ''
  expect(rule.length).toBeGreaterThan(10)
  expect(rule.length).toBeLessThanOrEqual(90 - 4)
})

test('overview: in a narrow pane no text is crushed: rows with fixed columns wrap, and their text starts at a readable width', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = world(on)
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: 50 } })
    for (const card of [OVERVIEW_CARDS.commands, OVERVIEW_CARDS.tools, OVERVIEW_CARDS.recent]) {
      for (const row of await rowsIn(ui, card)) {
        const fixed = row.boxes.filter(box => typeof box.width === 'number' && box.flexShrink === 0)
        const growing = row.boxes.filter(box => box.flexGrow === 1)
        if (fixed.length > 0 && growing.length > 0) {
          // A row of fixed columns and free text wraps, so the text moves under them rather than shrinking.
          expect([card, row.props.flexWrap]).toEqual([card, 'wrap'])
          for (const box of growing) {
            // Free text never shrinks below the width it starts at.
            expect([card, box.flexShrink, typeof box.width === 'number' && box.width >= 1]).toEqual([card, 0, true])
          }
        }
      }
    }
    // A call row's title starts at its room and never shrinks below it.
    const recent = (await ui.findAll({ type: 'Client' })).map(client => client.key ?? '').find(key => key.startsWith('recent:')) ?? ''
    const titleBoxes = (await ui.findAll({ in: recent, type: 'Box' })).filter(box => box.props?.flexGrow === 1 && box.props?.flexDirection !== 'row')
    expect(titleBoxes.length).toBeGreaterThan(0)
    expect(titleBoxes.every(box => box.props?.flexShrink === 0 && typeof box.props?.width === 'number')).toBe(true)
    await ui.unmount()
  }
})
