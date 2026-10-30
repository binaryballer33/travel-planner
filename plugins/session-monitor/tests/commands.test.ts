import { describe, expect, test } from 'claude-code/testing'

import type { CommandRecord, GroupSample } from '../types'
import {
  ALERT_NET_BYTES,
  ALERT_SLOW_MS,
  alertsOf,
  applyTickToCommands,
  applyTickToLive,
  clipOutput,
  emptyLive,
  finishRecord,
  matchScore,
  MAX_OUTPUT_CHARS,
  parseExitCode,
  startRecord,
  summarizeInput,
} from '../hooks/lib/commands'
import { BOLD_WEIGHT_CHARS, costOf, cutTextOf, DESKTOP_LIMITS, ENGINE_CUT_NOTE_CHARS, ENGINE_TEXT_CHARS, fitList, isDrawable, isSentAsLink, keptRun, LIST_BUDGET, listShareOf, PLUGIN_NAME_CHARS, sentCostOf, shareOf } from '../hooks/lib/fit'
import { fmtMemory, keyOf } from '../hooks/lib/format'
import { LineBuffer, parseMessage, ZERO_RATES, ZERO_TOTALS, type SamplerTick } from '../hooks/lib/sampler'
import { activeRate, byAccess, byTool, runningOrRecent, timeStats } from '../hooks/lib/stats'
import { COMMANDS_SUMMARY_KEY, commandCardKey, groupCardKey, listEnd, MEMORY_CELLS, shownOutput } from '../hooks/view/commands'
import { CARD_BACKGROUND } from '../hooks/view/kit'
import { desktopSizeOf } from './heavy'
import { call, clickRow, isOpenRow, keysIn, keysOf, laterTicks, NOW, PANE, RAM, seconds, start, textsIn, TICK, world } from './world'

const T0 = 1_700_000_000_000

/** Floating sums compared to six places. */
const near = (value: number | undefined, expected: number): void => {
  expect(Math.round((value ?? Number.NaN) * 1e6) / 1e6).toBe(expected)
}

const shell = (id: string, cmd: string | undefined, startedAt: number, extra: Partial<GroupSample> = {}): GroupSample => ({
  ...ZERO_RATES,
  id,
  kind: 'bash',
  label: cmd ?? 'shell',
  pid: 1,
  procs: 1,
  startedAt,
  mem: 1_000_000,
  peakMem: 2_000_000,
  tot: { ...ZERO_TOTALS, cpuS: 0.5, energyJ: 1.2, netIn: 5_000, netOut: 700, netActiveS: 2.5 },
  cmd,
  ...extra,
})

const tick = (t: number, groups: GroupSample[], ended: GroupSample[] = [], reapedCpuS = 0): SamplerTick => ({
  type: 'tick',
  t,
  groups,
  ended,
  session: { ...ZERO_TOTALS, ...ZERO_RATES, mem: 0, netIn: 100, cpuPct: 12, netInBps: 50 },
  reaped: { cpuS: reapedCpuS, energyEstJ: reapedCpuS * 2 },
  system: { netInBps: 0, netOutBps: 0, netIn: 0, netOut: 0 },
  jPerCpuS: 2,
})

const bash = (id: string, command: string, startedAt: number, extra: Record<string, unknown> = {}): CommandRecord =>
  startRecord(id, 'Bash', { command, description: 'desc', ...extra }, startedAt)

describe('summarizeInput', () => {
  test('names each kind of tool call by what it acts on', () => {
    expect(summarizeInput('Bash', { command: 'ls -la', description: 'List', run_in_background: true })).toEqual({
      title: 'ls -la',
      description: 'List',
      isBackground: true,
    })
    expect(summarizeInput('Edit', { file_path: '/a/b.py' })).toEqual({ title: '/a/b.py', filePath: '/a/b.py', isBackground: false })
    expect(summarizeInput('Grep', { pattern: 'TODO', path: 'src' }).title).toBe('TODO  in src')
    expect(summarizeInput('WebSearch', { query: 'spy options' }).title).toBe('spy options')
    expect(summarizeInput('mcp__github__get_issue', { tool: 'x', repo: 'a/b' }).title).toBe('github › get_issue  a/b')
  })
})

describe('finishing a call', () => {
  test('reads the exit code and keeps a one-line preview', () => {
    const done = finishRecord(bash('1', 'false', T0), { isDenied: false, isError: true, isReadOnly: false, text: '\nboom\nExit code 2' }, T0 + 50)
    expect(done.status).toBe('error')
    expect(done.exitCode).toBe(2)
    expect(done.preview).toBe('boom')
    expect(done.outputLines).toBe(3)
    expect(done.endedAt).toBe(T0 + 50)
  })

  test('a successful Bash call exits 0 and a background one keeps running', () => {
    expect(finishRecord(bash('1', 'true', T0), { isDenied: false, isError: false, isReadOnly: false, text: '' }, T0).exitCode).toBe(0)
    const bg = finishRecord(bash('2', 'sleep 9', T0, { run_in_background: true }), { isDenied: false, isError: false, isReadOnly: false, text: 'started' }, T0)
    expect(bg.status).toBe('background')
  })

  test("records the access class, and the engine's read-only verdict refines it", () => {
    const record = bash('1', 'python check.py', T0)
    expect(record.access).toBe('execute')
    expect(finishRecord(record, { isDenied: false, isError: false, isReadOnly: true, text: '' }, T0).access).toBe('read')
    expect(finishRecord(record, { isDenied: false, isError: false, isReadOnly: false, text: '' }, T0).access).toBe('execute')
    expect(startRecord('2', 'Edit', { file_path: '/a' }, T0).access).toBe('write')
  })

  test('a denied call is denied, not failed', () => {
    expect(finishRecord(bash('1', 'rm -rf /', T0), { isDenied: true, isError: false, isReadOnly: false, text: 'no' }, T0).status).toBe('denied')
  })

  test('parses exit codes in the forms tools print them', () => {
    expect(parseExitCode('Exit code 127')).toBe(127)
    expect(parseExitCode('exited with code 1')).toBe(1)
    expect(parseExitCode('all good')).toBeUndefined()
  })

  test('long output keeps its head and its tail', () => {
    const long = `HEAD${'x'.repeat(MAX_OUTPUT_CHARS * 2)}TAIL`
    const clipped = clipOutput(long)
    expect(clipped.startsWith('HEAD')).toBe(true)
    expect(clipped.endsWith('TAIL')).toBe(true)
    expect(clipped).toContain('characters omitted')
    expect(clipped.length).toBeLessThan(MAX_OUTPUT_CHARS + 100)
  })
})

describe('matching shells to calls', () => {
  test('scores exact, prefix and unrelated commands', () => {
    const record = bash('1', 'npm test  -- --watch=false', T0)
    expect(matchScore('npm test -- --watch=false', record)).toBe(3)
    expect(matchScore('npm test -- --watch=false && echo done', record)).toBe(2)
    expect(matchScore('cargo build', record)).toBe(0)
    expect(matchScore(undefined, record)).toBe(0)
  })

  test('a tick attaches a shell to its call by command and folds its metrics', () => {
    const records = [bash('a', 'make build', T0), bash('b', 'curl -O https://x', T0 + 10)]
    const result = applyTickToCommands(records, tick(T0 + 1_000, [shell('g1', 'curl -O https://x', T0 + 20, { cpuPct: 40, netInBps: 9_000 })]))
    expect(result.changed).toBe(true)
    const [build, curl] = result.commands
    expect(build?.groups).toHaveLength(0)
    expect(curl?.groups.map(group => group.id)).toEqual(['g1'])
    expect(curl?.metrics).toMatchObject({ cpuS: 0.5, energyJ: 1.2, netIn: 5_000, netOut: 700, netActiveS: 2.5, cpuPct: 40, netInBps: 9_000, mem: 1_000_000, isSampled: true })
  })

  test('a finished call keeps totals but drops live rates when its shell ends', () => {
    const started = bash('a', 'make', T0)
    const first = applyTickToCommands([started], tick(T0 + 1_000, [shell('g1', 'make', T0, { cpuPct: 90 })])).commands
    const finished = first.map(record => finishRecord(record, { isDenied: false, isError: false, isReadOnly: false, text: 'ok' }, T0 + 1_500))
    const ended = shell('g1', 'make', T0, { endedAt: T0 + 1_400, tot: { ...ZERO_TOTALS, cpuS: 1.4, energyJ: 3 } })
    const [record] = applyTickToCommands(finished, tick(T0 + 2_000, [], [ended])).commands
    expect(record?.metrics.cpuS).toBe(1.4)
    expect(record?.metrics.cpuPct).toBe(0)
    expect(record?.metrics.mem).toBe(0)
    expect(record?.status).toBe('ok')
  })

  test('a background call turns ok once its shell ends', () => {
    const bg = finishRecord(bash('a', 'server', T0, { run_in_background: true }), { isDenied: false, isError: false, isReadOnly: false, text: 'id 1' }, T0 + 100)
    const live = applyTickToCommands([bg], tick(T0 + 1_000, [shell('g1', 'server', T0)])).commands
    expect(live[0]?.status).toBe('background')
    const [done] = applyTickToCommands(live, tick(T0 + 9_000, [], [shell('g1', 'server', T0, { endedAt: T0 + 8_500 })])).commands
    expect(done?.status).toBe('ok')
    expect(done?.endedAt).toBe(T0 + 8_500)
  })

  test('a shell no call ran is reported as unclaimed once it ends', () => {
    const result = applyTickToCommands([], tick(T0, [], [shell('g9', 'top', T0 - 500, { endedAt: T0 })]))
    expect(result.unclaimed.cpuS).toBe(0.5)
    expect(result.changed).toBe(false)
  })
})

describe('reaped CPU', () => {
  test('goes to a call too quick to sample', () => {
    const quick = finishRecord(bash('q', 'git status', T0), { isDenied: false, isError: false, isReadOnly: false, text: '' }, T0 + 80)
    const result = applyTickToCommands([quick], tick(T0 + 900, [], [], 0.03))
    near(result.commands[0]?.metrics.cpuS, 0.03)
    near(result.commands[0]?.metrics.energyEstJ, 0.06)
    expect(result.commands[0]?.metrics.isEstimate).toBe(true)
    expect(result.unclaimed.cpuS).toBe(0)
  })

  test('is unclaimed when no call was active', () => {
    const old = finishRecord(bash('o', 'ls', T0), { isDenied: false, isError: false, isReadOnly: false, text: '' }, T0 + 10)
    const result = applyTickToCommands([old], tick(T0 + 60_000, [], [], 0.2))
    near(result.unclaimed.cpuS, 0.2)
    expect(result.changed).toBe(false)
  })

  test('never goes to a long call whose shell is still being sampled', () => {
    const running = applyTickToCommands([bash('r', 'pytest', T0)], tick(T0 + 1_000, [shell('g1', 'pytest', T0)])).commands
    const result = applyTickToCommands(running, tick(T0 + 2_000, [shell('g1', 'pytest', T0)], [], 0.1))
    expect(result.commands[0]?.reapedCpuS).toBe(0)
    near(result.unclaimed.cpuS, 0.1)
  })
})

describe('live metrics', () => {
  test('a tick sets the session figures, keeps history and adds unclaimed totals', () => {
    const live = applyTickToLive(emptyLive(T0), tick(T0 + 1_000, []), { ...ZERO_TOTALS, cpuS: 0.2 })
    expect(live.status).toBe('running')
    expect(live.session.cpuPct).toBe(12)
    expect(live.history).toHaveLength(1)
    near(live.shortLived.cpuS, 0.2)
    let rolling = live
    for (let index = 0; index < 200; index += 1) {
      rolling = applyTickToLive(rolling, tick(T0 + index, []), ZERO_TOTALS)
    }
    expect(rolling.history).toHaveLength(120)
  })
})

describe('the sampler protocol', () => {
  test('parses a tick, converting seconds to milliseconds', () => {
    const message = parseMessage(
      JSON.stringify({
        type: 'tick',
        t: 1_700_000_001.5,
        groups: [{ id: 'p:1', kind: 'bash', label: 'ls', pid: 9, procs: 1, startedAt: 1_700_000_001, mem: 5, peakMem: 6, tot: { cpuS: 1 }, cmd: 'ls', cpuPct: 3 }],
        ended: [{ id: 'bad', kind: 'nope' }],
        session: { netIn: 10, mem: 3 },
        reaped: { cpuS: 0.1, energyEstJ: 0.2 },
        system: { netInBps: 1 },
        jPerCpuS: 1.1,
      }),
    )
    if (message?.type !== 'tick') {
      throw new Error('expected a tick')
    }
    expect(message.t).toBe(1_700_000_001_500)
    expect(message.groups[0]).toMatchObject({ id: 'p:1', kind: 'bash', startedAt: 1_700_000_001_000, cmd: 'ls', cpuPct: 3 })
    expect(message.groups[0]?.tot.netIn).toBe(0)
    expect(message.ended).toEqual([])
    expect(message.session.netIn).toBe(10)
  })

  test('ignores lines that are not messages', () => {
    expect(parseMessage('not json')).toBeUndefined()
    expect(parseMessage('[1,2]')).toBeUndefined()
    expect(parseMessage('{"type":"other"}')).toBeUndefined()
    expect(parseMessage('{"type":"error","message":"x"}')).toEqual({ type: 'error', message: 'x' })
  })

  test('the line buffer holds a partial line back', () => {
    const buffer = new LineBuffer()
    expect(buffer.push('{"a":1}\n{"b"')).toEqual(['{"a":1}'])
    expect(buffer.push(':2}\n\n')).toEqual(['{"b":2}'])
  })
})

describe('time stats', () => {
  const done = (id: string, command: string, ms: number, isError = false): CommandRecord =>
    finishRecord(bash(id, command, T0), { isDenied: false, isError, isReadOnly: false, text: '' }, T0 + ms)

  test('sum, average and longest per access class, live ones counted to now', () => {
    const records = [done('1', 'ls', 100), done('2', 'git status', 300), done('3', 'echo x > f', 1_000, true), bash('4', 'pytest', T0)]
    const classes = byAccess(records, T0 + 5_000)
    expect(classes.read).toMatchObject({ count: 2, totalMs: 400, avgMs: 200, failed: 0 })
    expect(classes.read.longest?.id).toBe('2')
    expect(classes.write).toMatchObject({ count: 1, totalMs: 1_000, failed: 1 })
    expect(classes.execute).toMatchObject({ count: 1, totalMs: 5_000 })
    expect(timeStats([], T0)).toMatchObject({ count: 0, totalMs: 0, avgMs: 0 })
  })

  test('tools are ranked by total time, and throughput counts only active seconds', () => {
    const records = [done('1', 'ls', 100), startRecord('2', 'WebFetch', { url: 'https://a.b' }, T0)]
    expect(byTool(records, T0 + 2_000)).toEqual([
      { tool: 'WebFetch', count: 1, totalMs: 2_000 },
      { tool: 'Bash', count: 1, totalMs: 100 },
    ])
    expect(activeRate(10_000_000, 4)).toBe(2_500_000)
    expect(activeRate(10, 0)).toBe(0)
  })
})

describe('running now', () => {
  test('a finished call stays listed for five seconds after it ends', () => {
    const quick = finishRecord(bash('q', 'git status', T0), { isDenied: false, isError: false, isReadOnly: true, text: '' }, T0 + 80)
    const long = bash('l', 'pytest', T0)
    expect(runningOrRecent([quick, long], T0 + 4_000).map(record => record.id)).toEqual(['q', 'l'])
    expect(runningOrRecent([quick, long], T0 + 5_079).map(record => record.id)).toEqual(['q', 'l'])
    expect(runningOrRecent([quick, long], T0 + 5_080).map(record => record.id)).toEqual(['l'])
    expect(runningOrRecent([quick], T0 + 6_000, 10_000).map(record => record.id)).toEqual(['q'])
  })
})

describe('what one drawing can hold', () => {
  test('the first items while they fit and the pinned ones always; the first that does not fit ends the list', () => {
    const sizes: Readonly<Record<string, number>> = { a: 40, b: 30, c: 50, d: 10, e: 20 }
    const items = ['a', 'b', 'c', 'd', 'e']
    const weighed: string[] = []
    const weigh = (item: string): number => {
      weighed.push(item)
      return sizes[item] ?? 0
    }
    // c would pass 100, so the list ends there: d, small enough, is not taken after the cut; nothing past it is weighed.
    expect(fitList(items, weigh, () => false, 100)).toEqual(['a', 'b'])
    expect(weighed).toEqual(['a', 'b', 'c'])
    expect(fitList(items, weigh, () => false, 1_000)).toEqual(items)
    // A pinned item (the open row) stays wherever it is, its room kept first.
    expect(fitList(items, weigh, item => item === 'e', 100)).toEqual(['a', 'b', 'e'])
    expect(fitList(items, weigh, item => item === 'e', 60)).toEqual(['a', 'e'])
    // A pinned item's room is kept before the others are weighed: without e's 20 kept first, b would fit in 75 too.
    expect(fitList(items, weigh, item => item === 'e', 75)).toEqual(['a', 'e'])
    expect(fitList(items, weigh, item => item === 'c', 10)).toEqual(['c'])
    // How many kept are the list's own newest run.
    expect(keptRun(['a', 'b', 'e'], items)).toBe(2)
    expect(keptRun(['a', 'b'], items)).toBe(2)
    expect(keptRun(['c'], items)).toBe(0)
    expect(keptRun(items, items)).toBe(5)
  })

  test('a drawing is weighed as the engine sends it: past its 100,000 characters of text it cuts strings, code and regions, never an Svg', () => {
    // A folder of 250 rows, each a region of 1,400 characters of props: more than the app draws, as the kit builds it.
    const row = (index: number): unknown => ({ type: 'Box', props: { flexDirection: 'column' }, children: [{ type: 'Client', props: { key: `tree:${index}`, module: './view/row.tsx', props: { title: 'x'.repeat(1_400) } } }] })
    const rows = { type: 'Box', props: { key: 'card' }, children: [{ type: 'Text', children: ['Items'] }, ...Array.from({ length: 250 }, (_, index) => row(index))] }
    const whole = costOf(rows)
    expect(isDrawable(whole)).toBe(false)
    // The engine holds the strings and each region's key, module and props; only ENGINE_TEXT_CHARS of them are sent, and its note.
    const region = (index: number): number => `tree:${index}./view/row.tsx`.length + JSON.stringify({ title: 'x'.repeat(1_400) }).length
    const text = 'Items'.length + Array.from({ length: 250 }, (_, index) => region(index)).reduce((total, size) => total + size, 0)
    expect(cutTextOf(rows)).toBe(text)
    const sent = sentCostOf(rows)
    expect(sent).toEqual({ nodes: whole.nodes, depth: whole.depth, chars: whole.chars - text + ENGINE_TEXT_CHARS + ENGINE_CUT_NOTE_CHARS })
    expect(isDrawable(sent)).toBe(true)
    // Under the cut, it is the drawing's whole cost.
    const few = { ...rows, children: rows.children.slice(0, 20) }
    expect(sentCostOf(few)).toEqual(costOf(few))
    // A Code's source and a Markdown's text are cut; an Svg's source, a Box's other props and a button's plugin are sent whole.
    expect(cutTextOf({ type: 'Box', children: [{ type: 'Code', props: { source: 'ls', path: '/a' } }, { type: 'Markdown', props: { key: 'm', text: 'hi' } }] })).toBe('lshi'.length)
    const svgs = { type: 'Box', props: { flexDirection: 'column' }, children: Array.from({ length: 3 }, () => ({ type: 'Svg', props: { source: `<svg>${'x'.repeat(100_000)}</svg>`, alt: 'chart' } })) }
    expect(cutTextOf(svgs)).toBe(0)
    expect(sentCostOf(svgs)).toEqual(costOf(svgs))
    expect(isDrawable(sentCostOf(svgs))).toBe(false)
    // The engine walks into Boxes, Texts and Links only: a string in anything else is not counted as cut.
    expect(cutTextOf({ type: 'Button', props: { key: 'k', label: 'Open' }, children: ['Open'] })).toBe(0)
  })

  test('a Link the engine will not send an app is weighed as the Text it sends in its place, a node and a level more', () => {
    // An https: URL (or http://localhost) of printable ASCII, no user or raw @, as URL writes it, goes as a link.
    for (const href of ['https://a.com/docs/page-1', 'https://a.com', 'https://a.com/?q=1', 'http://localhost:3000/x']) {
      expect([href, isSentAsLink(href)]).toEqual([href, true])
    }
    for (const href of ['http://a.com/docs', 'http://127.0.0.1:8080/', 'https://medium.com/@ada/post', 'https://ada:pw@a.com/', 'https://a.com/a b', 'https://a.com/é', 'https://A.com/x', 'not a url', 'ftp://a.com/']) {
      expect([href, isSentAsLink(href)]).toEqual([href, false])
    }
    const box = (href: string): unknown => ({ type: 'Box', children: [{ type: 'Text', children: ['see '] }, { type: 'Link', props: { href, label: 'the page' } }] })
    expect(sentCostOf(box('https://a.com/x'))).toEqual(costOf(box('https://a.com/x')))
    // Sent plain: a Text of its label, a node more; its href is not sent.
    expect(costOf(box('http://a.com/x'))).toEqual({ nodes: 4, depth: 3, chars: 'see '.length + 'http://a.com/x'.length + 'the page'.length })
    expect(sentCostOf(box('http://a.com/x'))).toEqual({ nodes: 5, depth: 3, chars: 'see '.length + 'the page'.length })
    // A level deeper too; no label: its href is the text; children: they are, as many nodes as the Link's.
    expect(costOf({ type: 'Link', props: { href: 'http://a.com/x' } })).toEqual({ nodes: 1, depth: 1, chars: 'http://a.com/x'.length })
    expect(sentCostOf({ type: 'Link', props: { href: 'http://a.com/x' } })).toEqual({ nodes: 2, depth: 2, chars: 'http://a.com/x'.length })
    expect(sentCostOf({ type: 'Link', props: { href: 'http://a.com/x' }, children: ['here'] })).toEqual({ nodes: 2, depth: 2, chars: 'here'.length })
    // The desktop counter the tests hold the tabs to, written apart, counts each as the mod does.
    for (const href of ['https://a.com/x', 'https://a.com', 'http://localhost:3000/x', 'http://a.com/x', 'https://medium.com/@ada/post', 'https://a.com/é', 'https://A.com/x', 'not a url']) {
      const { nodes, depth } = sentCostOf(box(href))
      expect([href, desktopSizeOf(box(href))]).toEqual([href, { nodes, depth, chars: desktopSizeOf(box(href)).chars }])
    }
  })

  test("a drawing costs what the desktop app's renderer counts: nodes, depth and characters; an output's card draws its tail, cut to a size", () => {
    // Each element and each string is a node; a Box's or Text's props count their names and string values.
    const text = { type: 'Text', props: { color: 'claude', bold: true }, children: ['hi ', { type: 'Text', props: { dimColor: true }, children: ['there'] }] }
    // The bold Text also the weight the engine gives it.
    expect(costOf(text)).toEqual({ nodes: 4, depth: 3, chars: 'colorclaudebold'.length + BOLD_WEIGHT_CHARS + 'hi '.length + 'dimColor'.length + 'there'.length })
    // A Button its key and label, and the plugin's name the engine writes into its press; a Code its source.
    const box = { type: 'Box', props: { key: 'card', borderStyle: 'round', paddingX: 3 }, children: [text, { type: 'Button', props: { key: 'k', label: 'Open' } }, { type: 'Code', props: { source: 'ls -la' } }] }
    expect(PLUGIN_NAME_CHARS).toBe('session-monitor'.length)
    expect(costOf(box)).toEqual({ nodes: 7, depth: 4, chars: 'keycardborderStyleroundpaddingX'.length + costOf(text).chars + 'kOpen'.length + PLUGIN_NAME_CHARS + 'ls -la'.length })
    // A Client region its key, its module, the plugin's name and its props as JSON, whole.
    const props = { segments: [{ text: '✓', color: 'success' }], subtitle: 'ls -la' }
    expect(costOf({ type: 'Client', props: { key: 'cmd:1', module: './view/row.tsx', props, width: '100%' } })).toEqual({ nodes: 1, depth: 1, chars: 'cmd:1./view/row.tsx'.length + PLUGIN_NAME_CHARS + JSON.stringify(props).length })
    // A Select's options and a Markdown's links are nodes too; an Svg counts its whole source.
    expect(costOf({ type: 'Select', props: { key: 's', value: 'a', options: [{ value: 'a', label: 'A' }, { value: 'bb' }] } })).toEqual({ nodes: 3, depth: 1, chars: 'sa'.length + PLUGIN_NAME_CHARS + 'aA'.length + 'bb'.length })
    expect(costOf({ type: 'Markdown', props: { key: 'm', text: 'hi', pressableLinks: ['https://x'] } })).toEqual({ nodes: 2, depth: 1, chars: 'hi'.length + 'm'.length + 'https://x'.length })
    expect(costOf({ type: 'Svg', props: { source: '<svg/>', alt: 'x' } }).chars).toBe('<svg/>x'.length)
    // A bold Text the weight the engine gives it; one with a weight of its own, as it is.
    expect(BOLD_WEIGHT_CHARS).toBe('weightsemibold'.length)
    expect(costOf({ type: 'Text', props: { bold: true }, children: ['x'] }).chars).toBe('bold'.length + BOLD_WEIGHT_CHARS + 1)
    expect(costOf({ type: 'Text', props: { bold: true, weight: 'bold' }, children: ['x'] }).chars).toBe('boldweightbold'.length + 1)
    expect(costOf(undefined)).toEqual({ nodes: 0, depth: 0, chars: 0 })
    // A share of the list budget is the larger of the two; the renderer draws a tree under each of its bounds.
    expect(shareOf({ nodes: LIST_BUDGET.nodes / 2, depth: 0, chars: 10 })).toBe(0.5)
    expect(shareOf({ nodes: 10, depth: 0, chars: LIST_BUDGET.chars })).toBe(1)
    expect(listShareOf(box)).toBe(shareOf(costOf(box)))
    expect(isDrawable({ nodes: DESKTOP_LIMITS.nodes - 1, depth: DESKTOP_LIMITS.depth - 1, chars: DESKTOP_LIMITS.chars - 1 })).toBe(true)
    expect(isDrawable({ nodes: DESKTOP_LIMITS.nodes, depth: 1, chars: 1 })).toBe(false)
    expect(isDrawable({ nodes: 1, depth: DESKTOP_LIMITS.depth, chars: 1 })).toBe(false)
    expect(isDrawable({ nodes: 1, depth: 1, chars: DESKTOP_LIMITS.chars })).toBe(false)
    const lines = Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n')
    expect(shownOutput(lines, false)).toMatchObject({ hidden: 20, cut: 0 })
    expect(shownOutput(lines, false).text.startsWith('line 20\n')).toBe(true)
    expect(shownOutput(lines, true)).toEqual({ text: lines, hidden: 0, cut: 0 })
    // A few very long lines: the tail is cut to 20,000 characters, the full view to 30,000.
    const wide = Array.from({ length: 4 }, (_, index) => `${index}`.repeat(10_000)).join('\n')
    expect(shownOutput(wide, false)).toMatchObject({ hidden: 0, cut: wide.length - 20_000 })
    expect(shownOutput(wide, false).text).toBe(wide.slice(-20_000))
    expect(shownOutput(wide, true)).toMatchObject({ hidden: 0, cut: wide.length - 30_000 })
  })
})

describe('the Commands tab', () => {
  test("a summary card, then a card per prompt's calls; an opened call is a card inside its group's", { timeoutMs: 30_000 }, async ($, on) => {
    const clock = world(on)
    await start($, clock)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'tab:commands' })
      // The summary's figures: each access class's calls and their time, how many run, and how many failed.
      const summary = await textsIn(ui, COMMANDS_SUMMARY_KEY)
      for (const name of ['Read', 'Write', 'Execute']) {
        expect(summary[summary.indexOf(name) + 1]).toMatch(/^\d+ · /)
      }
      expect(summary[summary.indexOf('Live') + 1]).toBe('0')
      expect(summary[summary.indexOf('Failed') + 1]).toBe('0')

      // One card holds the prompt's group: its header row, its jump, then its five calls, the newest first.
      const group = groupCardKey('t1')
      const header = `grp:${keyOf('t1')}`
      expect(await keysOf(ui, 'grpcard:')).toEqual([group])
      expect(await keysIn(ui, group, 'grp:')).toEqual([header])
      expect(await keysIn(ui, group, 'gojump:')).toHaveLength(1)
      const rows = await keysIn(ui, group, 'cmd:')
      expect(rows).toHaveLength(5)
      expect(rows).toEqual(await keysOf(ui, 'cmd:'))
      const box = await ui.find({ key: group })
      expect(box?.props.borderStyle).toBe('round')
      expect(box?.props.backgroundColor).toBe(surface === 'terminal' ? undefined : CARD_BACKGROUND)

      // The newest is the download: its peak memory with its share of the Mac's 16 GB, in a cell wide enough for any.
      const bash = rows[0] ?? ''
      expect(await ui.find({ in: bash, type: 'Text', text: 'Fetch the data' })).toBeDefined()
      expect(fmtMemory(9e6, RAM)).toBe('9.00 MB (0.1%)')
      expect(await ui.find({ in: bash, type: 'Text', text: '▣ 9.00 MB (0.1%)' })).toBeDefined()
      expect((await ui.find({ key: bash }))?.props).toMatchObject({
        props: { segments: expect.arrayContaining([expect.objectContaining({ text: '▣ 9.00 MB (0.1%)', width: MEMORY_CELLS })]) },
      })

      // Opened, it is a card of its own inside the group's, edged in its status's colour: its figures as tiles, its flow, cost and output.
      await clickRow(ui, bash)
      await clock.settle()
      const detail = commandCardKey(bash.slice('cmd:'.length))
      expect(await isOpenRow(ui, bash)).toBe(true)
      expect(await keysIn(ui, group, 'cmdcard:')).toEqual([detail])
      expect((await ui.find({ key: detail }))?.props.borderColor).toBe('success')
      const texts = await textsIn(ui, detail)
      for (const name of ['Access', 'Started', 'Ended', 'Time', 'Model', 'Effort', 'CPU', 'Peak memory', 'Energy', 'Network', 'Net time', 'Disk', 'Flow', 'Context & cost']) {
        expect(texts).toContain(name)
      }
      expect(texts[texts.indexOf('Peak memory') + 1]).toBe('9.00 MB (0.1%)')
      expect(texts[texts.indexOf('Network') + 1]).toBe('⇅ 12.4 MB · ↓ 12.4 MB ↑ 30.0 kB')
      expect(await ui.find({ type: 'Code', text: /downloaded data\.zip/ })).toBeDefined()

      // A click on the header closes the group to the header alone; another opens it again.
      await clickRow(ui, header)
      await clock.settle()
      expect(await keysIn(ui, group, 'cmd:')).toEqual([])
      expect(await keysIn(ui, group, 'grp:')).toEqual([header])
      await clock.advance(1_000)
      await clickRow(ui, header)
      await clickRow(ui, bash)
      await clock.settle()
      expect(await keysIn(ui, group, 'cmd:')).toHaveLength(5)
      expect(await isOpenRow(ui, bash)).toBe(false)
      await clock.advance(1_000)
      await ui.unmount()
    }
  })

  test("a running call's memory now and at its peak, each with its share of the Mac's RAM; its group's card is edged as running", { timeoutMs: 30_000 }, async ($, on) => {
    const clock = world(on)
    // A dev server's shell, seen running by the second tick.
    const shell = {
      id: 'p:50:1',
      kind: 'bash',
      label: 'npm run dev',
      cmd: 'npm run dev',
      pid: 50,
      procs: 2,
      startedAt: seconds(NOW + 10),
      mem: 1.3e9,
      peakMem: 2.1e9,
      cpuPct: 30,
      watts: 1.5,
      tot: { cpuS: 2, energyJ: 3, netIn: 0, netOut: 0, netActiveS: 0 },
    }
    laterTicks.value = [{ ...TICK, t: seconds(NOW + 2_000), groups: [...TICK.groups, shell], ended: [] }]
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await call($, { tool: 'Bash', command: 'npm run dev', description: 'Dev server', run_in_background: true, tool_use_id: 'toolu_dev' })
    await clock.advance(1_000)
    await clock.advance(1_000)
    await clock.settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'tab:commands' })
      const summary = await textsIn(ui, COMMANDS_SUMMARY_KEY)
      expect(summary[summary.indexOf('Live') + 1]).toBe('1')
      expect((await ui.find({ key: groupCardKey('') }))?.props.borderColor).toBe('warning')
      expect(await ui.find({ in: 'cmd:toolu_dev', type: 'Text', text: '▣ 2.10 GB (12%)' })).toBeDefined()
      await clickRow(ui, 'cmd:toolu_dev')
      await clock.settle()
      const texts = await textsIn(ui, commandCardKey('toolu_dev'))
      expect(texts[texts.indexOf('Memory now') + 1]).toBe('1.30 GB (7.6%)')
      expect(texts[texts.indexOf('Peak memory') + 1]).toBe('2.10 GB (12%)')
      expect((await ui.find({ key: commandCardKey('toolu_dev') }))?.props.borderColor).toBe('suggestion')
      await clock.advance(1_000)
      await clickRow(ui, 'cmd:toolu_dev')
      await clock.settle()
      expect(await ui.find({ key: commandCardKey('toolu_dev') })).toBeUndefined()
      await clock.advance(1_000)
      await ui.unmount()
    }
  })

  test('the list ends in a note that the pane is full, Show more with what it adds, or nothing', () => {
    expect(listEnd(true, 10, 0)).toBe('full')
    // It hides some, but none of them would fit: no button that adds nothing.
    expect(listEnd(false, 10, 0)).toBe('full')
    expect(listEnd(false, 10, 4)).toBe('more')
    expect(listEnd(false, 0, 0)).toBe('none')
  })

  test('a long list stops short of what the pane can draw, and the filters find the rest', { timeoutMs: 30_000 }, async ($, on) => {
    const clock = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
    const id = (n: number): string => `toolu_b${String(n).padStart(3, '0')}`
    for (let n = 0; n < 130; n += 1) {
      await call($, { tool: 'Bash', command: `npm test -- --grep "case ${n}" && echo done with case number ${n} of the long suite`, description: `Run test case ${n}`, tool_use_id: id(n) })
    }
    await clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:commands' })
    expect(await keysOf(ui, 'cmd:')).toHaveLength(40)
    // 90 such rows are more than one drawing may carry (the desktop app would draw nothing new of the pane): Show more says how many of them it adds.
    const label = String((await ui.find({ key: 'more' }))?.props.label)
    const more = Number(/^Show (\d+) more of 90$/.exec(label)?.[1] ?? NaN)
    expect([more > 0, more < 50]).toEqual([true, true])
    await ui.press({ key: 'more' })
    await clock.settle()
    // The newest that fit, as many as it said, and a note.
    const rows = await keysOf(ui, 'cmd:')
    expect(rows.length).toBe(40 + more)
    expect(rows).toEqual(Array.from({ length: rows.length }, (_, index) => `cmd:${id(129 - index)}`))
    expect(await ui.find({ type: 'Text', text: `The newest ${rows.length} calls fill the pane; the filters above find older ones.` })).toBeDefined()
    expect(await ui.find({ key: 'more' })).toBeUndefined()
    // The filter finds an older one.
    await ui.input({ key: 'filter', text: 'case 7"' })
    expect(await keysOf(ui, 'cmd:')).toEqual([`cmd:${id(7)}`])
  })
})

describe('alerts', () => {
  const bash = (fields: Partial<CommandRecord>, metrics: Partial<CommandRecord['metrics']> = {}): CommandRecord => {
    const record = startRecord('toolu_a', 'Bash', { command: 'make data' }, NOW, undefined, 'engine')
    return { ...record, ...fields, metrics: { ...record.metrics, ...metrics } }
  }

  test('a shell call raises a toast when it moves 50 MB or runs past two minutes; never for its energy', () => {
    expect(alertsOf(bash({ status: 'ok' }, { energyJ: 500, energyEstJ: 40 }), NOW + 1_000)).toEqual([])
    expect(alertsOf(bash({ status: 'ok' }, { netIn: ALERT_NET_BYTES - 1_000, netOut: 999 }), NOW)).toEqual([])
    expect(alertsOf(bash({ status: 'ok' }, { netIn: ALERT_NET_BYTES, energyJ: 500 }), NOW).map(one => one.kind)).toEqual(['net'])
    expect(alertsOf(bash({ status: 'running' }), NOW + ALERT_SLOW_MS - 1)).toEqual([])
    expect(alertsOf(bash({ status: 'running' }), NOW + ALERT_SLOW_MS)).toEqual([{ kind: 'slow', text: '⏱ running 2m 00s: make data' }])
    expect(alertsOf({ ...bash({ status: 'running' }, { netIn: ALERT_NET_BYTES }), tool: 'WebFetch' }, NOW + ALERT_SLOW_MS)).toEqual([])
  })
})
