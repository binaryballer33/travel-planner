// List rows: a command's title in the title colour; a row's stats under its
// title when its line is too narrow for them; its second line plain text under
// its region, which can be selected; an opened call's Flow and Context & cost
// as panels of their own; and room between a list's calls.

import { describe, expect, test, type Engine } from 'claude-code/testing'

import { startRecord } from '../hooks/lib/commands'

import { keyOf } from '../hooks/lib/format'
import { agentCallsKey, agentCardKey, agentCostKey, agentKey } from '../hooks/view/agents'
import { callRuns, COST_ACCENT, commandCardKey, commandGap, LOOP_COLOR, PROGRAM_COLORS, programColor, VARIABLE_COLOR, costPanelKey, FLOW_ACCENT, flowPanelKey, groupCallsKey, groupCardKey } from '../hooks/view/commands'
import { callCardKey, callEdge, CARD_BACKGROUND, rowBoxKey, seg, spaceFor, TITLE_COLOR, titleSeg } from '../hooks/view/kit'
import { BAR_CELLS, isStacked, OPEN_BAR, statGap, textCells, TITLE_ROOM } from '../hooks/view/row'
import { call, clickRow, COMMAND, hoverRow, isOpenRow, keysIn, PANE, start, stepReply, textsIn, world, type Drawable } from './world'

/** A Bash call a sub-agent made, which no Agent call launched: the Agents tab lists the agent with it. */
const AGENT = 'ag-hi'
const AGENT_CALL = 'toolu_hi'

/** The world, the scripted session and one call a sub-agent made: its agent is a row of the Agents tab, the call a row of its card. */
const begin = async ($: Engine, on: Parameters<typeof world>[0]): Promise<ReturnType<typeof world>> => {
  on('agent.list', () => ({ value: [] }))
  on('classic.Stop', () => ({}))
  const clock = world(on)
  await start($, clock)
  await call($, { tool: 'Bash', command: 'echo hi', description: 'Prints a greeting', agentId: AGENT, tool_use_id: AGENT_CALL })
  await clock.settle()
  return clock
}

/** A second click on a row, past the window in which it would count as the first's double: what it opened closes. */
const clickAgain = async (ui: Parameters<typeof clickRow>[0], clock: ReturnType<typeof world>, key: string): Promise<void> => {
  await clock.advance(1_000)
  await clickRow(ui, key)
  await clock.settle()
}

type Regions = { drawn: (scope?: { in?: string }) => Promise<unknown> }

/** What a row's region drew, read as `textsIn` reads the pane's tree. */
const region = (ui: Regions, key: string): Drawable => ({ drawn: () => ui.drawn({ in: key }) })

type Node = { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The first element of a tree keyed `key`, depth first. */
const keyed = (node: unknown, key: string): Node | undefined => {
  if (!isNode(node)) {
    return undefined
  }
  if (node.props?.key === key) {
    return node
  }
  for (const child of node.children ?? []) {
    const found = keyed(child, key)
    if (found !== undefined) {
      return found
    }
  }
  return undefined
}

/** Every element of a tree, depth first. */
const elementsOf = (node: unknown): Node[] => (isNode(node) ? [node, ...(node.children ?? []).flatMap(elementsOf)] : [])

type Finds = Drawable & { find: (query: { in?: string; type?: string; text?: string }) => Promise<unknown> }

/** The scripted session's download: the row of its prompt's group whose title is the call's description. */
const downloadRow = async (ui: Finds): Promise<string> => {
  for (const key of await keysIn(ui, groupCardKey('t1'), 'cmd:')) {
    if ((await ui.find({ in: key, type: 'Text', text: 'Fetch the data' })) !== undefined) {
      return key
    }
  }
  return ''
}

describe("a row's line at a width", () => {
  test('a character is a cell, a wide one two, a mark that joins the one before none', () => {
    expect(textCells('Fetch the data')).toBe(14)
    expect(textCells('≈2.9 J')).toBe(6)
    expect(textCells('⇅ 480 kB')).toBe(8)
    expect(textCells('▣ 34.2 MB (0.0%)')).toBe(16)
    expect(textCells('日本語')).toBe(6)
    expect(textCells('👍 ok')).toBe(5)
    expect(textCells('é')).toBe(1)
    expect(textCells('')).toBe(0)
  })

  test('the stats stay on the line while it holds every cell and the title its room; past that they go under the title', () => {
    const lead = seg('✓', { bold: true })
    const stats = [seg('6:46:05 PM', { dim: true, role: 'stat' }), seg('▣ 9.00 MB', { width: 17, role: 'stat' })]
    const long = [lead, titleSeg('x'.repeat(60), false), ...stats]
    // The open bar, the cells but the title's (1 + 10 + 17), the title's room and three gaps of 3.
    const fits = BAR_CELLS + 28 + TITLE_ROOM + 3 * 3
    expect(isStacked(long, 3, fits)).toBe(false)
    expect(isStacked(long, 3, fits - 1)).toBe(true)
    // A wider gap needs more room.
    expect(isStacked(long, 4, fits)).toBe(true)
    // A title shorter than its room needs only its own.
    const short = [lead, titleSeg('Read it', false), ...stats]
    expect(isStacked(short, 3, BAR_CELLS + 28 + 7 + 3 * 3)).toBe(false)
    expect(isStacked(short, 3, BAR_CELLS + 28 + 7 + 3 * 3 - 1)).toBe(true)
    // Not laid out yet, or nothing that may move: one line, however narrow.
    expect(isStacked(long, 3, 0)).toBe(false)
    expect(isStacked([lead, titleSeg('x'.repeat(60), false), seg('6:46:05 PM')], 3, 10)).toBe(false)
  })
})

describe('command rows', () => {
  test("a command's title is drawn in the title colour, bold while open and inverted under the terminal's pointer, in Commands and in an agent's calls", { timeoutMs: 30_000 }, async ($, on) => {
    const clock = await begin($, on)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'tab:commands' })
      const fetch = await downloadRow(ui)
      const title = async (key: string, text: string): Promise<Record<string, unknown> | undefined> => (await ui.find({ in: key, type: 'Text', text }))?.props
      expect(await title(fetch, 'Fetch the data')).toMatchObject({ color: TITLE_COLOR, bold: false })
      expect(await title(`cmd:${AGENT_CALL}`, 'Prints a greeting')).toMatchObject({ color: TITLE_COLOR, bold: false })
      // Under the pointer the terminal inverts it, its colour kept; the desktop lights the row's Box instead.
      await hoverRow(ui, fetch, 'enter')
      expect(await title(fetch, 'Fetch the data')).toMatchObject({ color: TITLE_COLOR, inverse: surface === 'terminal' })
      await hoverRow(ui, fetch, 'leave')
      // Open, it is bold and keeps its colour.
      await clickRow(ui, fetch)
      await clock.settle()
      expect(await isOpenRow(ui, fetch)).toBe(true)
      expect(await title(fetch, 'Fetch the data')).toMatchObject({ color: TITLE_COLOR, bold: true })
      await clickAgain(ui, clock, fetch)

      // The Agents tab draws the agent's calls with the same rows.
      await ui.press({ key: 'tab:agents' })
      await clickRow(ui, agentKey(AGENT))
      await clock.settle()
      expect(await keysIn(ui, agentCardKey(AGENT), 'cmd:')).toEqual([`cmd:${AGENT_CALL}`])
      expect(await title(`cmd:${AGENT_CALL}`, 'Prints a greeting')).toMatchObject({ color: TITLE_COLOR, bold: false })
      await clickRow(ui, `cmd:${AGENT_CALL}`)
      await clock.settle()
      expect(await title(`cmd:${AGENT_CALL}`, 'Prints a greeting')).toMatchObject({ color: TITLE_COLOR, bold: true })
      await clickAgain(ui, clock, `cmd:${AGENT_CALL}`)
      await clickAgain(ui, clock, agentKey(AGENT))
      await clock.advance(1_000)
      await ui.unmount()
    }
  })

  test('a narrow row draws its stats under its title, wrapping onto as many lines as they need; a wide one keeps them on its line', { timeoutMs: 30_000 }, async ($, on) => {
    const clock = await begin($, on)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'tab:commands' })
      const fetch = await downloadRow(ui)
      const stats = async (key: string): Promise<Record<string, unknown> | undefined> => (await ui.find({ in: key, type: 'Box', key: 'stats' }))?.props
      // Before the region is laid out, and while it is wide enough, one line as ever.
      expect(await stats(fetch)).toBeUndefined()
      await ui.resize({ columns: 200, rows: 1, in: fetch })
      expect(await stats(fetch)).toBeUndefined()
      const wide = await textsIn(region(ui, fetch), 'row')
      expect(wide.slice(-3)).toEqual(['⇅ 12.4 MB', '▣ 9.00 MB (0.1%)', 'Opus 5.5 · xhigh'])

      // Too narrow for every cell: the title keeps its line with the status, access and who ran it; every stat is under it.
      await ui.resize({ columns: 70, rows: 3, in: fetch })
      expect(await stats(fetch)).toMatchObject({ flexWrap: 'wrap', marginLeft: BAR_CELLS, columnGap: statGap(spaceFor(surface).gap) })
      // Under the title the figures keep no fixed widths, so they sit close and fit one line.
      expect((await ui.findAll({ in: fetch, type: 'Box' })).filter(box => box.props?.flexGrow !== 1 && box.props?.flexShrink === 0 && typeof box.props?.width === 'number' && box.props?.width > 1)).toHaveLength(0)
      const under = await textsIn(region(ui, fetch), 'stats')
      expect(under).toHaveLength(6)
      expect(under[0]).toMatch(/[AP]M$/)
      expect(under.slice(2)).toEqual([wide[wide.length - 4], '⇅ 12.4 MB', '▣ 9.00 MB (0.1%)', 'Opus 5.5 · xhigh'])
      const all = await textsIn(region(ui, fetch), 'row')
      expect(all.filter(text => !under.includes(text))).toEqual([' ', '✓', 'W', 'Claude', 'Fetch the data'])
      expect([...all].sort()).toEqual([...wide].sort())

      // The stats' line is the row too: a click on it opens the row.
      await ui.pointer({ type: 'down', x: 12, y: 1, button: 'left', in: fetch })
      await ui.pointer({ type: 'up', x: 12, y: 1, button: 'left', in: fetch })
      await clock.settle()
      expect(await isOpenRow(ui, fetch)).toBe(true)
      expect(await ui.find({ in: fetch, type: 'Text', text: OPEN_BAR })).toBeDefined()
      expect(await stats(fetch)).toBeDefined()
      await clickAgain(ui, clock, fetch)

      // A prompt's header does the same: its title on its line, its counts, time and cost under it.
      const header = `grp:${keyOf('t1')}`
      await ui.resize({ columns: 20, rows: 3, in: header })
      const counts = await textsIn(region(ui, header), 'stats')
      expect(counts[0]).toMatch(/[AP]M$/)
      expect(counts).toContain('6 calls')
      expect((await textsIn(region(ui, header), 'row')).filter(text => !counts.includes(text))).toEqual([OPEN_BAR, 'Fetch the data'])

      // Wide again, the stats come back onto the line.
      await ui.resize({ columns: 200, rows: 1, in: fetch })
      expect(await stats(fetch)).toBeUndefined()
      expect(await textsIn(region(ui, fetch), 'row')).toEqual(wide)
      await clock.advance(1_000)
      await ui.unmount()
    }
  })

  test('an agent row draws its figures under its label when narrow', { timeoutMs: 30_000 }, async ($, on) => {
    await begin($, on)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'tab:agents' })
      const row = agentKey(AGENT)
      await ui.resize({ columns: 200, rows: 1, in: row })
      expect(await ui.find({ in: row, type: 'Box', key: 'stats' })).toBeUndefined()
      await ui.resize({ columns: 24, rows: 3, in: row })
      const under = await textsIn(region(ui, row), 'stats')
      expect(under[0]).toMatch(/[AP]M$/)
      expect(under).toContain('1 tool')
      await ui.unmount()
    }
  })
})

describe('selectable text', () => {
  test("a row's second line is plain text under its region, so it can be selected; a click on the line above still opens the row", { timeoutMs: 30_000 }, async ($, on) => {
    const clock = await begin($, on)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'tab:commands' })
      const fetch = await downloadRow(ui)
      // The row's Box holds its region, then its second line: the command's outline, each program bold in its colour.
      const box = await ui.find({ key: rowBoxKey(fetch) })
      const [first, second] = box?.children ?? []
      expect(isNode(first) ? [first.type, first.props?.key] : []).toEqual(['Client', fetch])
      expect(isNode(second) ? second.type : undefined).toBe('Box')
      const line = await textsIn(ui, rowBoxKey(fetch))
      expect(line).toHaveLength(1)
      expect(line[0]?.startsWith('curl')).toBe(true)
      expect((await ui.findAll({ type: 'Text' })).find(text => text.text === 'curl' && text.props?.color !== undefined)?.props).toMatchObject({ bold: true, color: programColor('curl') })
      expect(await ui.find({ in: fetch, type: 'Text', text: COMMAND })).toBeUndefined()
      // A prompt's header: its prompt, quoted.
      expect(await textsIn(ui, rowBoxKey(`grp:${keyOf('t1')}`))).toEqual(['“fetch the data”'])
      // The region still opens the row; the line stays where it was, under it.
      await clickRow(ui, fetch)
      await clock.settle()
      expect(await isOpenRow(ui, fetch)).toBe(true)
      expect(await textsIn(ui, rowBoxKey(fetch))).toEqual(line)
      await clickAgain(ui, clock, fetch)

      // An agent row's second line, what it is doing, is plain text too.
      await ui.press({ key: 'tab:agents' })
      const doing = await textsIn(ui, rowBoxKey(agentKey(AGENT)))
      expect(doing).toHaveLength(1)
      expect(doing[0]).toMatch(/^▸ /)
      expect(await ui.find({ in: agentKey(AGENT), type: 'Text', text: doing[0] ?? '' })).toBeUndefined()
      await clock.advance(1_000)
      await ui.unmount()
    }
  })

  test("an opened call's card holds no region: its command, figures, Flow, Context & cost and output are plain text and code", { timeoutMs: 30_000 }, async ($, on) => {
    const clock = await begin($, on)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'tab:commands' })
      const fetch = await downloadRow(ui)
      await clickRow(ui, fetch)
      await clock.settle()
      const card = keyed(await ui.drawn(), commandCardKey(fetch.slice('cmd:'.length)))
      const elements = elementsOf(card)
      expect(elements.length).toBeGreaterThan(0)
      expect(elements.filter(element => element.type === 'Client')).toEqual([])
      // The command and the output are Code; everything else is Text, but for the buttons.
      expect(elements.filter(element => element.type === 'Code').map(element => element.props?.source)).toEqual([COMMAND, 'downloaded data.zip\n12.4 MB'])
      const texts = await textsIn(ui, commandCardKey(fetch.slice('cmd:'.length)))
      for (const text of ['Claude ran it · Fetch the data', 'Peak memory', '9.00 MB (0.1%)', 'Energy', 'Network', 'Model', 'Opus 5.5', 'Effort', 'xhigh', 'Flow', 'Context & cost']) {
        expect(texts).toContain(text)
      }
      expect([...new Set(elements.map(element => String(element.type)))].sort()).toEqual(['Box', 'Button', 'Code', 'Text'])
      await clickAgain(ui, clock, fetch)
      await clock.advance(1_000)
      await ui.unmount()
    }
  })
})

describe("an opened call's card", () => {
  const step = async ($: Engine, turnId: string, index: number): Promise<void> => {
    for await (const chunk of $.turn.step({ turnId, index, model: 'claude-opus-5-5', effort: 'high', messageCount: 3 })) {
      expect(chunk).toBeDefined()
    }
  }

  test('its Flow and its Context & cost are panels edged and headed in accents of their own; the Flow points its arrows in its accent', { timeoutMs: 30_000 }, async ($, on) => {
    const clock = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await $.turn.start({ text: 'find the flow file', turnId: 't1' })
    // A Glob, whose output Claude read and reused in the Read it ran next.
    stepReply.toolUses = [{ name: 'Glob', input: { pattern: '**/*.ts' } }]
    await step($, 't1', 0)
    await call($, { tool: 'Glob', pattern: '**/*.ts', tool_use_id: 'toolu_glob' })
    await clock.advance(1_000)
    stepReply.answer = 'Two files; reading the flow one.'
    stepReply.toolUses = [{ name: 'Read', input: { file_path: 'hooks/lib/flow.ts' } }]
    await step($, 't1', 1)
    await call($, { tool: 'Read', file_path: 'hooks/lib/flow.ts', tool_use_id: 'toolu_read' })
    await clock.settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'tab:commands' })
      const isTerminal = surface === 'terminal'
      const heading = async (title: string): Promise<Record<string, unknown> | undefined> =>
        (await ui.findAll({ type: 'Text', text: title })).find(text => text.text === title)?.props
      const arrows = async (arrow: string): Promise<Record<string, unknown>[]> =>
        (await ui.findAll({ type: 'Text', text: arrow })).filter(text => text.text === arrow).map(text => text.props)

      // The Glob: what Claude ran next, under a label in the Flow's accent, its arrow in it too.
      await clickRow(ui, 'cmd:toolu_glob')
      await clock.settle()
      const card = commandCardKey('toolu_glob')
      expect(await keysIn(ui, card, 'cmdflow:')).toEqual([flowPanelKey('toolu_glob')])
      expect(await keysIn(ui, card, 'cmdcost:')).toEqual([costPanelKey('toolu_glob')])
      const flow = (await ui.find({ key: flowPanelKey('toolu_glob') }))?.props
      expect(flow).toMatchObject({ borderStyle: 'round', borderColor: FLOW_ACCENT, paddingX: isTerminal ? 1 : 2 })
      expect(flow?.backgroundColor).toBe(isTerminal ? undefined : CARD_BACKGROUND)
      expect((await textsIn(ui, flowPanelKey('toolu_glob')))[0]).toBe('Flow')
      expect(await heading('Flow')).toMatchObject({ bold: true, color: FLOW_ACCENT })
      expect(await heading('Next')).toMatchObject({ color: FLOW_ACCENT })
      expect(await textsIn(ui, flowPanelKey('toolu_glob'))).toContain('Next (calls Claude made after reading this output)')
      expect(await arrows('→')).toEqual([expect.objectContaining({ color: FLOW_ACCENT, bold: true })])
      const cost = (await ui.find({ key: costPanelKey('toolu_glob') }))?.props
      expect(cost).toMatchObject({ borderStyle: 'round', borderColor: COST_ACCENT })
      expect(COST_ACCENT).not.toBe(FLOW_ACCENT)
      expect((await textsIn(ui, costPanelKey('toolu_glob')))[0]).toBe('Context & cost')
      expect(await heading('Context & cost')).toMatchObject({ bold: true, color: COST_ACCENT })
      await clock.advance(1_000)

      // The Read: what it came after, the other way.
      await clickRow(ui, 'cmd:toolu_read')
      await clock.settle()
      expect(await heading('Came after')).toMatchObject({ color: FLOW_ACCENT })
      expect(await arrows('←')).toEqual([expect.objectContaining({ color: FLOW_ACCENT, bold: true })])
      expect(await arrows('→')).toEqual([])
      await clock.advance(1_000)
      await ui.unmount()
    }
  })

  test("an agent's Context & cost is a panel in the same accent", { timeoutMs: 30_000 }, async ($, on) => {
    const clock = await begin($, on)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'tab:agents' })
      await clickRow(ui, agentKey(AGENT))
      await clock.settle()
      expect(await keysIn(ui, agentCardKey(AGENT), 'agentcost:')).toEqual([agentCostKey(AGENT)])
      expect((await ui.find({ key: agentCostKey(AGENT) }))?.props).toMatchObject({ borderStyle: 'round', borderColor: COST_ACCENT })
      expect(await textsIn(ui, agentCostKey(AGENT))).toEqual(expect.arrayContaining(['Context & cost', 'Window used']))
      await clickAgain(ui, clock, agentKey(AGENT))
      await clock.advance(1_000)
      await ui.unmount()
    }
  })
})

describe('room between calls', () => {
  test("a list's calls sit a line further apart than other rows: in a prompt's group, and in an agent's calls", { timeoutMs: 30_000 }, async ($, on) => {
    const clock = await begin($, on)
    for (const surface of ['terminal', 'desktop'] as const) {
      const space = spaceFor(surface)
      expect(commandGap(space)).toBe(space.row + 1)
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'tab:commands' })
      const calls = groupCallsKey('t1')
      expect(await keysIn(ui, groupCardKey('t1'), 'grpcalls:')).toEqual([calls])
      expect((await ui.find({ key: calls }))?.props.rowGap).toBe(commandGap(space))
      // The scripted prompt's five calls, and the sub-agent's made while it was the latest.
      expect(await keysIn(ui, calls, 'cmd:')).toHaveLength(6)
      // The header and the jump keep the card's own room above them.
      expect((await ui.find({ key: groupCardKey('t1') }))?.props.rowGap).toBe(space.row)

      await ui.press({ key: 'tab:agents' })
      await clickRow(ui, agentKey(AGENT))
      await clock.settle()
      const agentCalls = agentCallsKey(AGENT)
      expect((await ui.find({ key: agentCalls }))?.props.rowGap).toBe(commandGap(space))
      expect(await keysIn(ui, agentCalls, 'cmd:')).toEqual([`cmd:${AGENT_CALL}`])
      await clickAgain(ui, clock, agentKey(AGENT))
      await clock.advance(1_000)
      await ui.unmount()
    }
  })
})

describe('nothing in a card is cut off', () => {
  const TABS = ['overview', 'prompts', 'agents', 'commands', 'commits', 'files', 'sources', 'resources', 'compute', 'ports'] as const

  test('no text in any tab is cut short with an ellipsis, and every box that takes the free room may shrink below its text, so it wraps', { timeoutMs: 60_000 }, async ($, on) => {
    const clock = world(on)
    await start($, clock)
    for (const surface of ['terminal', 'desktop'] as const) {
      // A narrow pane, where a cut would show.
      const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: 60 } })
      for (const tab of TABS) {
        await ui.press({ key: `tab:${tab}` })
        await clock.settle()
        // Rows opened too, where their cards draw the Flow and the Context lines.
        const rows = (await ui.findAll({ type: 'Client' })).map(client => client.key ?? '').filter(key => key.startsWith('cmd:'))
        if (rows[0] !== undefined) {
          await clickRow(ui, rows[0])
          await clock.settle()
        }
        // The pane's own elements, and those each row's clickable region draws.
        const regions = (await ui.findAll({ type: 'Client' })).map(client => client.key ?? '').filter(key => key !== '')
        const texts = [...(await ui.findAll({ type: 'Text' })), ...(await Promise.all(regions.map(key => ui.findAll({ in: key, type: 'Text' })))).flat()]
        const boxes = [...(await ui.findAll({ type: 'Box' })), ...(await Promise.all(regions.map(key => ui.findAll({ in: key, type: 'Box' })))).flat()]
        expect(texts.length).toBeGreaterThan(0)
        const cut = texts.filter(text => String(text.props?.wrap ?? '').startsWith('truncate'))
        expect([tab, surface, cut.map(text => text.text)]).toEqual([tab, surface, []])
        const rigid = boxes.filter(box => box.props?.flexGrow === 1 && box.props?.flexShrink === 1 && box.props?.minWidth !== 0)
        expect([tab, surface, rigid.length]).toEqual([tab, surface, 0])
        if (rows[0] !== undefined) {
          await clock.advance(1_000)
          await clickRow(ui, rows[0])
        }
      }
      await clock.advance(1_000)
      await ui.unmount()
    }
  })
})

describe('each call is a card of its own', () => {
  test('in Commands every call sits in its own edged card, open or closed; an open one holds its details inside', { timeoutMs: 30_000 }, async ($, on) => {
    const clock = world(on)
    await start($, clock)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'tab:commands' })
      const rows = (await ui.findAll({ type: 'Client' })).map(client => client.key ?? '').filter(key => key.startsWith('cmd:'))
      expect(rows).toHaveLength(5)
      for (const key of rows) {
        const id = key.slice('cmd:'.length)
        const box = await ui.find({ key: callCardKey(id) })
        expect([key, box?.props.borderStyle, box?.props.borderColor]).toEqual([key, 'round', callEdge('ok', surface)])
        expect((await keysIn(ui, callCardKey(id), 'cmd:'))).toContain(key)
      }
      // Opened, the call's details are inside its own card.
      const first = rows[0] ?? ''
      await clickRow(ui, first)
      await clock.settle()
      expect(await keysIn(ui, callCardKey(first.slice('cmd:'.length)), 'cmdcard:')).not.toHaveLength(0)
      await clock.advance(1_000)
      await clickRow(ui, first)
      await clock.advance(1_000)
      await ui.unmount()
    }
  })
})

describe("a call's line in colour", () => {
  test('cd blue, git green, tail purple, wc orange; any other program a colour by its name, the same in every row', () => {
    expect([programColor('cd'), programColor('git'), programColor('tail'), programColor('wc')]).toEqual(['#58a6ff', '#3fb950', '#bc8cff', '#f0883e'])
    expect(PROGRAM_COLORS).toContain(programColor('rsync'))
    expect(programColor('rsync')).toBe(programColor('rsync'))
    // An interpreter's script takes the interpreter's colour.
    expect(programColor('python3 fetch.py')).toBe(programColor('python3'))
  })

  test('each part of the outline is its own run: programs bold in their colours, variables and loops in theirs, dim dots between', () => {
    const record = startRecord('toolu_c', 'Bash', { command: 'W=1; cd /x && for f in *; do wc -l "$f"; done | tail -1' }, 0, undefined, 'engine')
    expect(callRuns(record)).toEqual([
      { text: 'W=', color: VARIABLE_COLOR, bold: false },
      { text: ' · ', color: '', bold: false },
      { text: 'cd', color: '#58a6ff', bold: true },
      { text: ' · ', color: '', bold: false },
      { text: 'for loop', color: LOOP_COLOR, bold: false },
      { text: ' · ', color: '', bold: false },
      { text: 'wc', color: '#f0883e', bold: true },
      { text: ' · ', color: '', bold: false },
      { text: 'tail', color: '#bc8cff', bold: true },
    ])
    // Another tool keeps its title, dim.
    expect(callRuns(startRecord('toolu_r', 'Read', { file_path: '/repo/a.py' }, 0, undefined, 'engine'))).toEqual([{ text: '/repo/a.py', color: '', bold: false }])
  })
})
