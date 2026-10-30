import type { On, ToolCallResult } from 'claude-code'
import { describe, expect, test, type Engine } from 'claude-code/testing'

import { keyOf } from '../hooks/lib/format'
import { storeKey } from '../hooks/lib/prompts'
import type { TranscriptCall, TranscriptSession } from '../hooks/lib/transcripts'
import { commitCardKey, commitKey } from '../hooks/view/commits'
import { DIFF_PANEL_KEY } from '../hooks/view/diff'
import { TOO_BIG_KEY } from '../hooks/view/pane'
import { taskKey } from '../hooks/view/sources-tasks'
import { touchedKey } from '../hooks/view/files'
import {
  EARLIER_OLDER_KEY,
  EARLIER_PAGE,
  overviewTitleKey,
  PROMPT_CALLS_SHOWN,
  promptCallsKey,
  PROMPTS_NEWER_KEY,
  PROMPTS_OLDER_KEY,
  PROMPTS_PAGE,
  promptKey,
} from '../hooks/view/prompts'
import { bigCommitLog, bigDiff, commitsLog, desktopSizeOf, HEAVY_PROMPTS, heavyHistory, heavySession, HUGE_PROMPT, isDesktopDrawn, type DesktopSize } from './heavy'
import { REVEAL_WAITS_MS } from '../hooks/register'
import { call, clickRow, clipboard, COMMAND, debugLines, fail, gitScript, isOpenRow, keysIn, keysOf, limits, memoryStore, NOW, ok, pageScrollAsked, PANE, promptEvents, searchScript, SESSION_ID, SHA, stepUsage, tabButton, textsIn, transcripts, weekly, world, type Drawable, type ToolArgs, regionText } from './world'

/**
 * Under the desktop app's bounds with room to spare: the engine adds to each
 * element what the kit leaves out (a press's handle, a region's plugin), and
 * a live figure grows by a few characters as it counts up.
 */
const MARGIN = { nodes: 1_600, chars: 220_000 } as const

/** This session after a long day, its transcript read back as the pane opens, and the project's history beside it. */
const longDay = async ($: Engine, on: On, prepare: () => void = () => undefined, session: TranscriptSession = heavySession()): Promise<ReturnType<typeof world>> => {
  const clock = world(on)
  prepare()
  memoryStore.set(storeKey('/repo'), heavyHistory())
  transcripts.sessions.set(SESSION_ID, session)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await clock.settle()
  return clock
}

/** heavySession with a short call of each of six tools under every prompt: cards that list six tools, so ten of them pass a page's budget. */
const busySession = (): TranscriptSession => {
  const session = heavySession()
  const tools = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']
  const extra = session.prompts.flatMap(prompt =>
    tools.map(
      (name, index): TranscriptCall => ({
        id: `toolu_${prompt.id}_${index}`,
        name,
        input: name === 'Bash' ? { command: 'git status', description: 'Status' } : { file_path: `/repo/src/${prompt.id}_${index}.py` },
        startedAt: prompt.at + 1_000 + index,
        endedAt: prompt.at + 1_500 + index,
        isError: false,
        output: 'out\n',
        model: 'claude-opus-5-5',
        promptId: prompt.id,
      }),
    ),
  )
  return { ...session, calls: [...session.calls, ...extra] }
}

/** `on('tool.call')` for WebFetch alone: typed over every tool's input, it is deeper than the checker instantiates. */
type FetchHook = (event: 'tool.call', filter: { tool: 'WebFetch' }, handler: (engine: unknown, args: { url?: unknown }) => ToolCallResult) => void

/** Each fetch answers with its own URL, so every one is a source of its own. */
const answerEachFetch = (on: On): void => {
  const hook = on as unknown as FetchHook
  hook('tool.call', { tool: 'WebFetch' }, (_engine, args) => ({
    result: { url: String(args.url), code: 200, codeText: 'OK', bytes: 5_120, durationMs: 340, result: 'summary' },
    text: 'summary',
    isReadOnly: true,
  }))
}

const DESKTOP_PANE = { ...PANE, surface: 'desktop' as const, props: { ...PANE.props, bodyColumns: 54 } }

/** What the engine draws in place of the text past its 100,000 characters of a drawing (rows past it go blank). */
const ENGINE_CUT = 'more characters, not drawn'

/** The drawing as the desktop app's renderer counts it, said with what was drawn, so a failure names the state. */
const sizeIn = async (ui: Drawable, state: string): Promise<{ state: string; size: DesktopSize; isDrawn: boolean; isInMargin: boolean; isCut: boolean }> => {
  const tree = await ui.drawn()
  const size = desktopSizeOf(tree)
  return { state, size, isDrawn: isDesktopDrawn(size), isInMargin: size.nodes < MARGIN.nodes && size.chars < MARGIN.chars, isCut: JSON.stringify(tree).includes(ENGINE_CUT) }
}

/** Drawn by the desktop app, with room to spare, and whole: nothing of it past the engine's own text budget. */
const expectDrawn = async (ui: Drawable, state: string): Promise<void> => {
  const measured = await sizeIn(ui, state)
  expect({ ...measured, size: undefined }).toEqual({ state, size: undefined, isDrawn: true, isInMargin: true, isCut: false })
}

/** The long day, each prompt with a call of a dozen tools besides: a closed card lists eight tools and more, so a page fills before its ten. */
const manyTools = (): TranscriptSession => {
  const session = heavySession()
  const tools = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'NotebookEdit', 'TodoWrite', 'Task', 'Skill']
  const extra = session.prompts.flatMap(prompt =>
    tools.map(
      (name, index): TranscriptCall => ({
        id: `toolu_${prompt.id}_${index}`,
        name,
        input: { file_path: `/repo/src/${prompt.id}_${index}.py` },
        startedAt: prompt.at + 1_000 + index,
        endedAt: prompt.at + 1_500 + index,
        isError: false,
        output: 'out\n',
        promptId: prompt.id,
      }),
    ),
  )
  return { ...session, calls: [...session.calls, ...extra] }
}

/** This session's prompt cards and the earlier sessions', by their keys. */
const SESSION_KEYS = heavySession().prompts.map(prompt => promptKey(`t:${prompt.id}`))
const EARLIER_KEYS = heavyHistory().map(prompt => promptKey(prompt.id))

/** How many prompts the live session sends; more than a page. */
const LIVE_PROMPTS = 12

/** A call of each of a dozen tools: a card lists eight of them and says how many more, and counts the files written. */
const LIVE_CALLS: readonly ToolArgs[] = [
  { tool: 'Read', file_path: '/repo/src/app.py' },
  { tool: 'Write', file_path: '/repo/src/notes.md', content: '# Notes' },
  { tool: 'Edit', file_path: '/repo/src/app.py', old_string: 'a', new_string: 'b' },
  { tool: 'Glob', pattern: '**/*.py' },
  { tool: 'Grep', pattern: 'pnl', path: '/repo' },
  { tool: 'WebFetch', url: 'https://docs.example.com/guide', prompt: 'summarize' },
  { tool: 'WebSearch', query: 'spy options', mode: 'standard' },
  { tool: 'Bash', command: 'cd /repo && git status && tail -n 40 log.txt | wc -l', description: 'Count the log' },
  { tool: 'NotebookEdit', notebook_path: '/repo/n.ipynb', new_source: 'x' },
  { tool: 'TodoWrite', todos: [] },
  { tool: 'Skill', skill: 'commit-msg' },
  { tool: 'ToolSearch', query: 'x', max_results: 1 },
]

const LIVE_USAGE = { input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 2_000, model: 'claude-opus-5-5' }

const liveStep = async ($: Engine, turnId: string, index: number): Promise<void> => {
  for await (const chunk of $.turn.step({ turnId, index, model: 'claude-opus-5-5', effort: 'high', messageCount: 3 })) {
    expect(chunk).toBeDefined()
  }
}

/**
 * This session's prompts sent and run while the pane watched: each card has
 * every figure a live prompt carries (cost, tokens, requests, context, the
 * 5-hour and weekly windows, model, energy, files, a dozen tools), so ten of
 * them weigh more than the list budget; the earlier sessions' history beside.
 */
const liveDay = async ($: Engine, on: On): Promise<ReturnType<typeof world>> => {
  promptEvents(on)
  const clock = world(on)
  memoryStore.set(storeKey('/repo'), heavyHistory())
  limits.percentUsed = 20
  limits.resetsAt = new Date(NOW + 3_600_000).toISOString()
  weekly.percentUsed = 50
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await clock.settle()
  for (let index = 0; index < LIVE_PROMPTS; index += 1) {
    const turnId = `t${index}`
    await $.turn.start({ text: `look at finding ${index} and fix what it shows, then tell me what moved and why`, turnId })
    await clock.settle()
    stepUsage.value = LIVE_USAGE
    await liveStep($, turnId, 0)
    for (const args of LIVE_CALLS) {
      await call($, args.tool === 'Write' ? { ...args, file_path: `/repo/src/notes_${index}.md` } : args)
    }
    limits.percentUsed = 20 + index * 0.3
    weekly.percentUsed = 50 + index * 0.1
    stepUsage.value = { ...LIVE_USAGE, input_tokens: 2_000 + index }
    await liveStep($, turnId, 1)
    await clock.advance(5_000)
    await $.turn.complete({ answer: 'done', durationMs: 5_000, isAborted: false, turnId, reason: 'answer' })
    await clock.settle()
    await clock.advance(10_000)
  }
  await clock.settle()
  return clock
}

describe("a long session's pane is one the desktop app draws, on every tab and every page", () => {
  test('Prompts: a page at a time, each drawn; Older and Newer reach every prompt, this session’s and the earlier ones', { timeoutMs: 120_000 }, async ($, on) => {
    const clock = await longDay($, on)
    const ui = await $.ui.mount(DESKTOP_PANE)
    await ui.press({ key: 'tab:prompts' })
    await clock.settle()
    const drawnKeys = async (): Promise<string[]> => keysOf(ui, 'prm:')
    const first = await drawnKeys()
    expect(first.filter(key => SESSION_KEYS.includes(key))).toHaveLength(PROMPTS_PAGE)
    expect(first.filter(key => EARLIER_KEYS.includes(key))).toHaveLength(EARLIER_PAGE)
    // The newest first: #95 down.
    expect(first[0]).toBe(SESSION_KEYS.at(-1))
    await expectDrawn(ui, 'prompts page 1')

    const seen = new Set(first)
    for (let page = 2; (await ui.find({ key: PROMPTS_OLDER_KEY })) !== undefined && page <= HEAVY_PROMPTS; page += 1) {
      // A second apart, as a person clicks: a press within BOUNCE_MS of the last is the same click.
      await clock.advance(1_000)
      await ui.press({ key: PROMPTS_OLDER_KEY })
      await clock.settle()
      await expectDrawn(ui, `prompts page ${page}`)
      for (const key of await drawnKeys()) {
        seen.add(key)
      }
    }
    expect(SESSION_KEYS.filter(key => !seen.has(key))).toEqual([])
    // The oldest page ends the list: no Older; Newer goes back.
    expect(await ui.find({ key: PROMPTS_OLDER_KEY })).toBeUndefined()
    const oldest = await drawnKeys()
    expect(oldest).toContain(SESSION_KEYS[0])
    await clock.advance(1_000)
    await ui.press({ key: PROMPTS_NEWER_KEY })
    await clock.settle()
    expect((await drawnKeys())[0]).not.toBe(oldest[0])

    // The earlier sessions' prompts page on their own.
    for (let page = 2; (await ui.find({ key: EARLIER_OLDER_KEY })) !== undefined && page <= HEAVY_PROMPTS; page += 1) {
      await clock.advance(1_000)
      await ui.press({ key: EARLIER_OLDER_KEY })
      await clock.settle()
      await expectDrawn(ui, `earlier page ${page}`)
      for (const key of await drawnKeys()) {
        seen.add(key)
      }
    }
    expect(EARLIER_KEYS.filter(key => !seen.has(key))).toEqual([])
    await ui.unmount()
  })

  test('‹ Newer after a page cut short by an open card lands on the prompts just before, skipping none', { timeoutMs: 60_000 }, async ($, on) => {
    const clock = world(on)
    memoryStore.set(storeKey('/repo'), heavyHistory())
    const session = heavySession()
    // The prompt 13th from the newest, on the second page, with 60 calls more: open, it cuts its page short.
    const busy = session.prompts[HEAVY_PROMPTS - 13]
    const [base] = session.calls
    if (busy === undefined || base === undefined) {
      throw new Error('the long day has no prompts')
    }
    for (let step = 0; step < 60; step += 1) {
      const at = busy.at + 1_000 + step * 100
      session.calls.push({ ...base, id: `toolu_busy${step}`, promptId: busy.id, startedAt: at, endedAt: at + 50, input: { command: `echo step ${step} && ls -la /repo/src/module_${step}`, description: `Busy step ${step}` } })
    }
    transcripts.sessions.set(SESSION_ID, session)
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
    await clock.settle()
    const ui = await $.ui.mount(DESKTOP_PANE)
    await ui.press({ key: 'tab:prompts' })
    await clock.settle()
    const newest = [...SESSION_KEYS].reverse()
    const drawn = async (): Promise<number[]> => (await keysOf(ui, 'prm:')).filter(key => SESSION_KEYS.includes(key)).map(key => newest.indexOf(key))
    const press = async (key: string): Promise<void> => {
      await clock.advance(1_000)
      await ui.press({ key })
      await clock.settle()
    }
    await press(PROMPTS_OLDER_KEY)
    await clock.advance(1_000)
    await clickRow(ui, `pfull:${keyOf(`t:${busy.id}`)}`)
    await clock.settle()
    const cut = await drawn()
    expect(cut.length).toBeLessThan(PROMPTS_PAGE)
    await press(PROMPTS_OLDER_KEY)
    const after = await drawn()
    expect(after[0]).toBe((cut.at(-1) ?? 0) + 1)
    // Back: the page that runs on to the one it left, the short page again; then the first.
    await press(PROMPTS_NEWER_KEY)
    const back = await drawn()
    expect(back.at(-1)).toBe((after[0] ?? 0) - 1)
    expect(back).toEqual(cut)
    await press(PROMPTS_NEWER_KEY)
    expect((await drawn())[0]).toBe(0)
    await ui.unmount()
  })

  test('Prompts: a page its cards fill before ten stops short, says so, and Older goes on from the first card it left out', { timeoutMs: 120_000 }, async ($, on) => {
    const session = busySession()
    const keys = session.prompts.map(prompt => promptKey(`t:${prompt.id}`))
    const clock = await longDay($, on, undefined, session)
    const ui = await $.ui.mount(DESKTOP_PANE)
    await ui.press({ key: 'tab:prompts' })
    await clock.settle()
    const drawnKeys = async (): Promise<string[]> => (await keysOf(ui, 'prm:')).filter(key => keys.includes(key))
    const first = await drawnKeys()
    expect(first.length).toBeGreaterThan(0)
    expect(first.length).toBeLessThan(PROMPTS_PAGE)
    expect(await ui.find({ type: 'Text', text: `#${HEAVY_PROMPTS}–#${HEAVY_PROMPTS - first.length + 1} of ${HEAVY_PROMPTS}` })).toBeDefined()
    // Older starts at the first card page 1 left out, not ten on.
    await clock.advance(1_000)
    await ui.press({ key: PROMPTS_OLDER_KEY })
    await clock.settle()
    expect((await drawnKeys())[0]).toBe(keys[HEAVY_PROMPTS - 1 - first.length])
    const seen = new Set([...first, ...(await drawnKeys())])
    for (let page = 3; (await ui.find({ key: PROMPTS_OLDER_KEY })) !== undefined && page <= HEAVY_PROMPTS; page += 1) {
      await clock.advance(1_000)
      await ui.press({ key: PROMPTS_OLDER_KEY })
      await clock.settle()
      for (const key of await drawnKeys()) {
        seen.add(key)
      }
    }
    expect(keys.filter(key => !seen.has(key))).toEqual([])
    await ui.unmount()
  })

  test("Prompts: live cards weigh more than a page's ten; the page stops at the budget, drawn open or closed, and Older goes on from the first left off", { timeoutMs: 120_000 }, async ($, on) => {
    const clock = await liveDay($, on)
    const ui = await $.ui.mount(DESKTOP_PANE)
    await ui.press({ key: 'tab:prompts' })
    await clock.settle()
    const sessionKeys = async (): Promise<string[]> => (await keysOf(ui, 'prm:')).filter(key => !EARLIER_KEYS.includes(key))
    const first = await sessionKeys()
    // Ten of these cards (1,900 nodes, and past 2,000 with one expanded) are more than the desktop app draws.
    expect(first.length).toBeGreaterThan(0)
    expect(first.length).toBeLessThan(PROMPTS_PAGE)
    await expectDrawn(ui, 'live page 1')
    // The newest expanded, its calls under it: the page gives it room and is still drawn.
    const newest = (first[0] ?? '').slice('prm:'.length)
    await clock.advance(1_000)
    await clickRow(ui, `pfull:${newest}`)
    await clock.settle()
    expect(await regionText(ui, `pfull:${newest}`)).toBe('▾ Collapse')
    await expectDrawn(ui, 'live page 1, the newest expanded')
    await clock.advance(1_000)
    await clickRow(ui, `pfull:${newest}`)
    await clock.settle()
    // Older goes on from the first card the budget left off: every prompt is reached, each page drawn.
    const seen = new Set(first)
    for (let page = 2; (await ui.find({ key: PROMPTS_OLDER_KEY })) !== undefined && page <= LIVE_PROMPTS; page += 1) {
      await clock.advance(1_000)
      await ui.press({ key: PROMPTS_OLDER_KEY })
      await clock.settle()
      await expectDrawn(ui, `live page ${page}`)
      for (const key of await sessionKeys()) {
        seen.add(key)
      }
    }
    expect(seen.size).toBe(LIVE_PROMPTS)
    await ui.unmount()
  })

  test('Older and Newer scroll the pane to the new page’s first card once it is drawn', { timeoutMs: 60_000 }, async ($, on) => {
    const clock = await longDay($, on)
    const ui = await $.ui.mount(DESKTOP_PANE)
    await ui.press({ key: 'tab:prompts' })
    await clock.settle()
    // The kit scrolls no pane: the tries, a few as the page is drawn, end in a line in the debug log, once all are spent.
    const tries = REVEAL_WAITS_MS.reduce((total, ms) => total + ms, 0)
    for (const pager of [PROMPTS_OLDER_KEY, PROMPTS_NEWER_KEY]) {
      await clock.advance(1_000)
      const before = debugLines.length
      await ui.press({ key: pager })
      await clock.settle()
      const [top] = await keysOf(ui, 'prm:')
      await clock.advance(tries - 1)
      expect(debugLines.slice(before)).toEqual([])
      await clock.advance(1)
      expect(debugLines.slice(before)).toEqual([pageScrollAsked(top ?? '')])
    }
    await ui.unmount()
  })


  test('an older prompt opened from Overview lands on its page, expanded with its calls; a whole log pasted in it is cut, still drawn', { timeoutMs: 60_000 }, async ($, on) => {
    const clock = await longDay($, on)
    const ui = await $.ui.mount(DESKTOP_PANE)
    await clock.settle()
    // A title on Overview posts the prompt it opens; this one names the prompt with a whole log pasted in.
    const newest = heavySession().prompts.at(-1)?.id ?? ''
    const huge = `t:hp-${HUGE_PROMPT}`
    await ui.post({ kind: 'prompt', id: huge }, { in: overviewTitleKey(`t:${newest}`) })
    await clock.settle()
    expect((await tabButton(ui, 'prompts'))?.props.variant).toBe('primary')
    const keys = await keysOf(ui, 'prm:')
    expect(keys[0]).toBe(promptKey(huge))
    expect(await regionText(ui, `pfull:${keyOf(huge)}`)).toBe('▾ Collapse')
    expect(await ui.find({ type: 'Text', text: /more characters; Copy prompt copies them all/ })).toBeDefined()
    await expectDrawn(ui, 'the huge prompt expanded')
    // From there the pages go on: newer ones above it, older ones below.
    expect(await ui.find({ key: PROMPTS_NEWER_KEY })).toBeDefined()
    await ui.unmount()
  })

  test('a card expanded at the foot of a full page stays on it, open: the open card is drawn before the others are weighed', { timeoutMs: 60_000 }, async ($, on) => {
    const clock = await longDay($, on, undefined, manyTools())
    const ui = await $.ui.mount(DESKTOP_PANE)
    await ui.press({ key: 'tab:prompts' })
    await clock.settle()
    const drawn = (await keysOf(ui, 'prm:')).filter(key => SESSION_KEYS.includes(key))
    expect(drawn.length).toBeGreaterThan(1)
    expect(drawn.length).toBeLessThan(PROMPTS_PAGE)
    // The last card the full page draws, expanded: it grows by its text and its calls.
    const last = drawn.at(-1) ?? ''
    const expand = last.replace(/^prm:/, 'pfull:')
    await clock.advance(1_000)
    await clickRow(ui, expand)
    await clock.settle()
    expect(await keysOf(ui, 'prm:')).toContain(last)
    expect(await regionText(ui, expand)).toBe('▾ Collapse')
    await expectDrawn(ui, 'a card expanded at the foot of a full page')
    await ui.unmount()
  })

  test("an expanded prompt's 60 long calls: the newest that fit its share, fewer than it would list, and the note says how many", { timeoutMs: 60_000 }, async ($, on) => {
    const newest = heavySession().prompts.at(-1)?.id ?? ''
    const long = Array.from({ length: 30 }, (_, part) => `grep -rn "pattern_${part}_with_a_long_name" /repo/src/module_${part}/view_with_a_long_name.py`).join(' && ')
    const calls: TranscriptCall[] = Array.from({ length: 60 }, (_, index) => ({
      id: `toolu_long${index}`,
      name: 'Bash',
      input: { command: `${long} # ${index}`, description: `A long step ${index} of the work, said at length so the row's title is as long as it may be` },
      startedAt: NOW - 60_000 + index * 100,
      endedAt: NOW - 60_000 + index * 100 + 50,
      isError: false,
      output: `line of output ${index}\n`.repeat(400),
      model: 'claude-opus-5-5',
      promptId: newest,
    }))
    const clock = world(on)
    const session = heavySession()
    memoryStore.set(storeKey('/repo'), heavyHistory())
    transcripts.sessions.set(SESSION_ID, { ...session, calls: [...session.calls, ...calls] })
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
    await clock.settle()
    const ui = await $.ui.mount(DESKTOP_PANE)
    await clock.settle()
    await ui.post({ kind: 'prompt', id: `t:${newest}` }, { in: overviewTitleKey(`t:${newest}`) })
    await clock.settle()
    const shown = await keysIn(ui, promptCallsKey(newest), 'callcard:')
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.length).toBeLessThan(PROMPT_CALLS_SHOWN)
    expect(await ui.find({ type: 'Text', text: `The newest ${shown.length} are shown; Show its commands lists them all.` })).toBeDefined()
    await expectDrawn(ui, 'a prompt with 60 long calls expanded')
    await ui.unmount()
  })

  test('a restored call whose output holds control characters opens drawn: they are cleaned as a live output is', { timeoutMs: 60_000 }, async ($, on) => {
    // A page break and a bell, as a real transcript's outputs hold: in a Code's source the engine refuses the whole pane.
    const session = heavySession()
    const last = session.calls.at(-1)
    if (last === undefined) {
      throw new Error('the long day has no calls')
    }
    const noisy = { ...last, output: 'page one\u000cpage two\u0007 done\n' }
    const clock = await longDay($, on, undefined, { ...session, calls: [...session.calls.slice(0, -1), noisy] })
    const ui = await $.ui.mount(DESKTOP_PANE)
    await ui.press({ key: 'tab:commands' })
    await clock.settle()
    await clickRow(ui, `cmd:${noisy.id}`)
    await clock.settle()
    const sources = (await ui.findAll({ type: 'Code' })).map(code => String(code.props.source ?? ''))
    expect(sources.some(source => source.includes('page one'))).toBe(true)
    expect(sources.filter(source => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source))).toEqual([])
    await expectDrawn(ui, 'a call with control characters open')
    await ui.unmount()
  })

  test('every tab, with 200 files read, a commit of 150 files and a 1,200-line diff open, is drawn whole', { timeoutMs: 120_000 }, async ($, on) => {
    const clock = await longDay($, on, () => {
      gitScript.log = bigCommitLog(150)
      gitScript.diff = bigDiff(1_200)
    })
    for (let file = 0; file < 200; file += 1) {
      await call($, { tool: 'Read', file_path: `/repo/src/module_${String(file).padStart(3, '0')}/view_with_a_long_name.py` })
    }
    await clock.settle()
    const ui = await $.ui.mount(DESKTOP_PANE)
    for (const tab of ['overview', 'commands', 'prompts', 'compute', 'agents', 'files', 'commits', 'sources', 'resources', 'ports'] as const) {
      await ui.press({ key: `tab:${tab}` })
      await clock.settle()
      expect((await tabButton(ui, tab))?.props.variant).toBe('primary')
      await expectDrawn(ui, tab)
    }
    // A command open on Commands.
    await ui.press({ key: 'tab:commands' })
    await clock.settle()
    const [firstCall] = await keysOf(ui, 'cmd:')
    await clickRow(ui, firstCall ?? '')
    await clock.settle()
    await expectDrawn(ui, 'commands with a call open')
    // A file's diff open on Files.
    await ui.press({ key: 'tab:files' })
    await clock.settle()
    const files = await keysOf(ui, 'touched:')
    expect(files.length).toBeGreaterThan(20)
    const [firstFile] = files
    await clickRow(ui, firstFile ?? '')
    await clock.settle()
    await expectDrawn(ui, 'files with a diff open')
    // The big commit open, and one of its files' diff.
    await ui.press({ key: 'tab:commits' })
    await clock.settle()
    await clickRow(ui, commitKey(SHA))
    await clock.settle()
    await expectDrawn(ui, 'commits with the big commit open')
    // As many of its 150 files as fit are listed; one of them opened.
    const commitFiles = await keysOf(ui, 'file:')
    expect(commitFiles.length).toBeGreaterThan(20)
    // The rest are counted, and only counted: the pane has no way to them (README, How big a drawing may be).
    expect(commitFiles.length).toBeLessThan(150)
    expect(await textsIn(ui, commitCardKey(SHA))).toContain(`… ${150 - commitFiles.length} more files`)
    await clickRow(ui, commitFiles[0] ?? '')
    await clock.settle()
    await expectDrawn(ui, 'commits with a file of it open')
    await ui.unmount()
  })

  test('Commits: a commit of 150 files open among 60 commits lists its files first, the later commit rows giving way, and the drawing whole', { timeoutMs: 60_000 }, async ($, on) => {
    const clock = await longDay($, on, () => {
      gitScript.log = commitsLog(60, 150)
    })
    const ui = await $.ui.mount(DESKTOP_PANE)
    await ui.press({ key: 'tab:commits' })
    await clock.settle()
    // The uncommitted changes and the 60 commits, each row a region of about 1,000 characters: 0.7 of the list budget.
    const rows = await keysOf(ui, 'commit:')
    expect(rows).toHaveLength(61)
    await clickRow(ui, commitKey(SHA))
    await clock.settle()
    await expectDrawn(ui, 'the big commit open among 60')
    // Nothing else reaches the files left out, so they come first: most of the budget, not what 60 rows leave (27 files).
    const files = await keysOf(ui, 'file:')
    expect(files.length).toBeGreaterThan(60)
    expect(await textsIn(ui, commitCardKey(SHA))).toContain(`… ${150 - files.length} more files`)
    // The commit rows past what they leave give way, the open one's kept, and are counted.
    const shown = await keysOf(ui, 'commit:')
    expect(shown).toContain(commitKey(SHA))
    expect(shown.length).toBeLessThan(61)
    expect(shown.length).toBeGreaterThan(15)
    expect(await ui.find({ type: 'Text', text: `… ${61 - shown.length} more commits, listed again when this one is closed` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /click a commit to open it/ })).toBeDefined()
    // Closed, a second later (a press within BOUNCE_MS of the last is the same click), every commit row is back.
    await clock.advance(1_000)
    await clickRow(ui, commitKey(SHA))
    await clock.settle()
    expect(await keysOf(ui, 'commit:')).toEqual(rows)
    await ui.unmount()
  })

  test('Commits: a commit of 40 files open among 60 commits lists every one of its files, and the drawing whole', { timeoutMs: 60_000 }, async ($, on) => {
    const clock = await longDay($, on, () => {
      gitScript.log = commitsLog(60, 40)
    })
    const ui = await $.ui.mount(DESKTOP_PANE)
    await ui.press({ key: 'tab:commits' })
    await clock.settle()
    await clickRow(ui, commitKey(SHA))
    await clock.settle()
    await expectDrawn(ui, 'a commit of 40 files open among 60')
    expect(await keysOf(ui, 'file:')).toHaveLength(40)
    expect((await textsIn(ui, commitCardKey(SHA))).some(text => text.includes('more files'))).toBe(false)
    const shown = await keysOf(ui, 'commit:')
    expect(await ui.find({ type: 'Text', text: `… ${61 - shown.length} more commits, listed again when this one is closed` })).toBeDefined()
    await ui.unmount()
  })

  test('Sources: 108 and 300 fetched URLs are drawn, the Show filter and View picker with them; the websites past the budget are counted', { timeoutMs: 120_000 }, async ($, on) => {
    answerEachFetch(on)
    const clock = world(on)
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
    await clock.settle()
    let fetched = 0
    for (const n of [108, 300]) {
      for (; fetched < n; fetched += 1) {
        await call($, { tool: 'WebFetch', url: `https://site${fetched % 7}.example.com/docs/page-${fetched}`, prompt: 'summarize' })
      }
      await clock.settle()
      const ui = await $.ui.mount(DESKTOP_PANE)
      await ui.press({ key: 'tab:sources' })
      await clock.settle()
      await expectDrawn(ui, `sources with ${n} URLs`)
      expect(await ui.find({ key: 'pane:toobig' })).toBeUndefined()
      expect(await ui.find({ key: 'sourcefilter' })).toBeDefined()
      expect(await ui.find({ key: 'sourceview' })).toBeDefined()
      // As many URLs as fit; the website cut short says how many more, the rest are counted.
      const links = (await ui.findAll({ type: 'Link' })).length
      expect(links).toBeGreaterThan(20)
      expect(links).toBeLessThan(n)
      expect(await ui.find({ type: 'Text', text: /^… \d+ more$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /more websites? \(\d+ URLs?\) not drawn: Show above narrows the list/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test("Files: a folder of 250 entries is drawn on every surface, its switch and Collapse all with it; the rows past the budget are counted, and with no folder open the note does not ask to close one", { timeoutMs: 120_000 }, async ($, on) => {
    const entries = Array.from({ length: 250 }, (_, index) => ({ name: `file_${index}.py`, kind: 'file', size: 1_234, isPartial: false, mode: '-rw-r--r--', mtimeMs: NOW - 60_000, isHidden: false }))
    on('process.run', { argv: /\/sampler\/tree\.py$/ }, () => ({ value: ok(JSON.stringify({ path: '/repo', entries, total: 250, hiddenTotal: 0, truncated: false })) }))
    on('process.run', { argv: 'open' }, () => ({ value: fail() }))
    on('session.cwd', () => ({ value: '/repo' }))
    const clock = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
    for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...DESKTOP_PANE, surface })
      await ui.press({ key: 'tab:files' })
      await ui.press({ key: 'files:folder' })
      await clock.settle()
      await expectDrawn(ui, `a folder of 250 entries on ${surface}`)
      expect(await ui.find({ key: 'pane:toobig' })).toBeUndefined()
      expect(await ui.find({ key: 'files:activity' })).toBeDefined()
      expect(await ui.find({ key: 'tree:collapse' })).toBeDefined()
      // Nothing is open, so there is no folder to close: the note says the pane draws no more of the folder.
      expect(await ui.find({ type: 'Text', text: /^… \d+ more rows not drawn: Open in Finder lists the whole folder$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /close a folder/ })).toBeUndefined()
      await ui.press({ key: 'files:activity' })
      await clock.settle()
      await ui.unmount()
    }
  })

  test("Sources by task: a task of 150 URLs opened on VS Code draws the searches and websites that fit, counts the rest, and keeps the tab's controls", { timeoutMs: 120_000 }, async ($, on) => {
    answerEachFetch(on)
    const clock = world(on)
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
    await clock.settle()
    await $.turn.start({ text: 'read the docs', turnId: 't1' })
    await clock.settle()
    for (let index = 0; index < 150; index += 1) {
      await call($, { tool: 'WebFetch', url: `https://site${index % 3}.example.com/docs/page-${index}`, prompt: 'summarize' })
    }
    await $.turn.complete({ answer: 'done', durationMs: 3_000, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.settle()
    const ui = await $.ui.mount({ ...DESKTOP_PANE, surface: 'vscode' })
    await ui.press({ key: 'tab:sources' })
    await ui.select({ key: 'sourceview', value: 'task' })
    await clock.settle()
    await ui.press({ key: taskKey('t1') })
    await clock.settle()
    // The tab, not the notice in its place: its View picker and Show filter can still narrow it.
    expect(await ui.find({ key: TOO_BIG_KEY })).toBeUndefined()
    expect(await ui.find({ key: 'sourceview' })).toBeDefined()
    expect(await ui.find({ key: 'sourcefilter' })).toBeDefined()
    await expectDrawn(ui, 'by task on VS Code, a task of 150 URLs open')
    // Some of its URLs as links, the rest counted.
    const links = (await ui.findAll({ type: 'Link' })).length
    expect([links > 10, links < 150]).toEqual([true, true])
    expect(await ui.find({ type: 'Text', text: /^… (\d+ more|\d+ more websites? \(\d+ URLs?\) not drawn: Show above narrows the list)$/ })).toBeDefined()
    await ui.unmount()
  })

  test('Sources by task on desktop: a task of http: URLs, which the engine sends as plain text, a node more each, is fitted as it grows, never past the app', { timeoutMs: 120_000 }, async ($, on) => {
    answerEachFetch(on)
    const clock = world(on)
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
    await clock.settle()
    await $.turn.start({ text: 'read the docs', turnId: 't1' })
    await clock.settle()
    const fetch = async (index: number): Promise<void> => {
      await call($, { tool: 'WebFetch', url: `http://site${index % 3}.example.com/docs/page-${index}`, prompt: 'summarize' })
    }
    let fetched = 0
    for (; fetched < 100; fetched += 1) {
      await fetch(fetched)
    }
    await clock.settle()
    const ui = await $.ui.mount(DESKTOP_PANE)
    await ui.press({ key: 'tab:sources' })
    await ui.select({ key: 'sourceview', value: 'task' })
    await clock.settle()
    await clickRow(ui, taskKey('t1'))
    await clock.settle()
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
    const seen: { urls: number; isNotice: boolean; isDrawn: boolean }[] = []
    for (; fetched < 125; fetched += 1) {
      await fetch(fetched)
      await clock.settle()
      seen.push({ urls: fetched + 1, isNotice: (await ui.find({ key: TOO_BIG_KEY })) !== undefined, isDrawn: isDesktopDrawn(desktopSizeOf(await ui.drawn())) })
    }
    // Every drawing is one the app draws, the task's URLs fitted to it: never the notice in its place.
    expect(seen.filter(one => !one.isDrawn)).toEqual([])
    expect(seen.filter(one => one.isNotice)).toEqual([])
    await expectDrawn(ui, 'by task on desktop, 125 http: URLs')
    await ui.unmount()
  })


  test('Sources: 40 searches of ten results each draw the latest searches and the busiest websites that fit, whole; the rest is counted, and Copy takes every URL', { timeoutMs: 60_000 }, async ($, on) => {
    const clock = world(on)
    searchScript.hits = 10
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
    await clock.settle()
    await $.turn.start({ text: 'research', turnId: 't1' })
    for (let index = 0; index < 40; index += 1) {
      await call($, { tool: 'WebSearch', query: `spy options question ${index}` })
      await clock.advance(1_000)
    }
    await clock.settle()
    const ui = await $.ui.mount(DESKTOP_PANE)
    await ui.press({ key: 'tab:sources' })
    await clock.settle()
    // The tab itself, not the notice the pane draws in place of one too big.
    expect(await ui.find({ key: TOO_BIG_KEY })).toBeUndefined()
    await expectDrawn(ui, 'sources of 40 searches')
    // The latest search first; those past the searches' share are counted.
    expect(await ui.find({ type: 'Text', text: 'spy options question 39' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'spy options question 0' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^… \d+ older searches not drawn$/ })).toBeDefined()
    // The websites have the rest: some of the 400 URLs as links, the websites past the budget counted.
    const links = (await ui.findAll({ type: 'Link' })).length
    expect(links).toBeGreaterThan(10)
    expect(links).toBeLessThan(400)
    expect(await ui.find({ type: 'Text', text: /^… \d+ more websites? \(\d+ URLs?\) not drawn: Show above narrows the list$/ })).toBeDefined()
    // The pickers are drawn, so the list can be narrowed; Copy takes every URL, drawn or not.
    expect(await ui.find({ key: 'sourcefilter' })).toBeDefined()
    await ui.press({ key: 'copyurls' })
    expect(clipboard.texts.at(-1)?.split('\n')).toHaveLength(400)
    await ui.unmount()
  })

  for (const count of [40, 120] as const) {
    test(`Sources: ${count} searches whose results are two URLs take the room the websites leave, past their share of the list`, { timeoutMs: 60_000 }, async ($, on) => {
      const clock = world(on)
      await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
      await clock.settle()
      await $.turn.start({ text: 'research', turnId: 't1' })
      for (let index = 0; index < count; index += 1) {
        await call($, { tool: 'WebSearch', query: `spy options question ${index}` })
        await clock.advance(1_000)
      }
      await clock.settle()
      const ui = await $.ui.mount(DESKTOP_PANE)
      await ui.press({ key: 'tab:sources' })
      await clock.settle()
      await expectDrawn(ui, `sources of ${count} searches on two URLs`)
      // The two websites, whole.
      expect(await ui.findAll({ type: 'Link' })).toHaveLength(2)
      expect(await ui.find({ type: 'Text', text: /not drawn: Show above narrows the list$/ })).toBeUndefined()
      // The latest searches first, more than their share alone would draw: all 40, or as many of 120 as the list budget holds, the rest counted.
      const drawn = (await ui.findAll({ type: 'Text', text: /^spy options question \d+$/ })).length
      expect(await ui.find({ type: 'Text', text: `spy options question ${count - 1}` })).toBeDefined()
      if (count === 40) {
        expect(drawn).toBe(40)
        expect(await ui.find({ type: 'Text', text: /older searches? not drawn$/ })).toBeUndefined()
      } else {
        expect(drawn).toBeGreaterThan(40)
        expect(drawn).toBeLessThan(count)
        expect(await ui.find({ type: 'Text', text: `… ${count - drawn} older searches not drawn` })).toBeDefined()
      }
      await ui.unmount()
    })
  }

  test('an open task on Sources by task stays drawn as its searches and URLs grow: the latest that fit, the rest counted', { timeoutMs: 60_000 }, async ($, on) => {
    const clock = world(on)
    searchScript.hits = 10
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
    await clock.settle()
    await $.turn.start({ text: 'research', turnId: 't1' })
    await call($, { tool: 'WebSearch', query: 'spy options question 0' })
    await clock.settle()
    // Opened in the desktop app: the pane's state is the session's, so VS Code's pane has it open too.
    const desk = await $.ui.mount(DESKTOP_PANE)
    await desk.press({ key: 'tab:sources' })
    await desk.select({ key: 'sourceview', value: 'task' })
    await clock.settle()
    await clickRow(desk, taskKey('t1'))
    await clock.settle()
    expect(await isOpenRow(desk, taskKey('t1'))).toBe(true)
    await desk.unmount()
    // The open task's searches and URLs grow past what the app would draw, were they all drawn.
    for (let index = 1; index < 40; index += 1) {
      await clock.advance(1_000)
      await call($, { tool: 'WebSearch', query: `spy options question ${index}` })
    }
    await clock.settle()
    for (const surface of ['desktop', 'vscode'] as const) {
      const ui = await $.ui.mount({ ...DESKTOP_PANE, surface })
      await clock.settle()
      expect(await ui.find({ key: TOO_BIG_KEY })).toBeUndefined()
      await expectDrawn(ui, `by task on ${surface}, the task of 40 searches open`)
      // The latest search first; the oldest past the panel's share, counted; the websites past it too.
      expect(await ui.find({ type: 'Text', text: 'spy options question 39' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'spy options question 0' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /^… \d+ older searches not drawn$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /not drawn: Show above narrows the list$/ })).toBeDefined()
      await ui.unmount()
    }
  })

  /** Sources by task, picked in the desktop app: the view is the session's, so a pane on any surface opens on it. */
  const pickByTask = async ($: Engine, clock: ReturnType<typeof world>): Promise<void> => {
    const desk = await $.ui.mount(DESKTOP_PANE)
    await desk.press({ key: 'tab:sources' })
    await desk.select({ key: 'sourceview', value: 'task' })
    await clock.settle()
    await desk.unmount()
  }

  for (const surface of ['vscode', 'mobile', 'desktop'] as const) {
    test(`Sources by task on ${surface}: 100 prompts listed, those without sources shown too, are drawn with the View picker and the switch; the rows past the budget are counted`, { timeoutMs: 120_000 }, async ($, on) => {
      answerEachFetch(on)
      const clock = world(on)
      await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
      await clock.settle()
      // 110 prompts (the task list keeps the latest 100), one of them with a fetch.
      for (let index = 0; index < 110; index += 1) {
        await $.turn.start({ text: `prompt number ${index} about the strategy and its stops`, turnId: `t${index}` })
        if (index === 105) {
          await call($, { tool: 'WebFetch', url: 'https://docs.example.com/page-105', prompt: 'summarize' })
        }
        await $.turn.complete({ answer: 'done', durationMs: 1_000, isAborted: false, turnId: `t${index}`, reason: 'answer' })
      }
      await clock.settle()
      await pickByTask($, clock)
      const ui = await $.ui.mount({ ...DESKTOP_PANE, surface })
      await clock.settle()
      expect(await keysOf(ui, 'task:')).toEqual([taskKey('t105')])
      await ui.press({ key: 'emptytasks' })
      await clock.settle()
      // The tab itself, not the notice in place of one too big: its picker and its switch with it.
      expect(await ui.find({ key: TOO_BIG_KEY })).toBeUndefined()
      await expectDrawn(ui, `by task, 100 tasks listed on ${surface}`)
      expect(await ui.find({ key: surface === 'mobile' ? 'sourceview:site' : 'sourceview' })).toBeDefined()
      expect((await ui.find({ key: 'emptytasks' }))?.props.label).toBe('Hide tasks without sources')
      // The newest first, as many as fit; on a surface whose rows are plain elements the rest are counted.
      const rows = await keysOf(ui, 'task:')
      expect(rows[0]).toBe(taskKey('t109'))
      if (rows.length < 100) {
        expect(await ui.find({ type: 'Text', text: `… ${100 - rows.length} more tasks not drawn` })).toBeDefined()
      }
      if (surface !== 'desktop') {
        expect(rows.length).toBeLessThan(100)
      }
      // The switch narrows the list again.
      await clock.advance(1_000)
      await ui.press({ key: 'emptytasks' })
      await clock.settle()
      expect(await keysOf(ui, 'task:')).toEqual([taskKey('t105')])
      await ui.unmount()
    })

    test(`Sources by task on ${surface}: 100 prompts that each fetched a page are drawn, the View picker with them`, { timeoutMs: 120_000 }, async ($, on) => {
      answerEachFetch(on)
      const clock = world(on)
      await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
      await clock.settle()
      for (let index = 0; index < 100; index += 1) {
        await $.turn.start({ text: `prompt number ${index} about the strategy and its stops`, turnId: `t${index}` })
        await call($, { tool: 'WebFetch', url: `https://site${index % 7}.example.com/docs/page-${index}`, prompt: 'summarize' })
        await $.turn.complete({ answer: 'done', durationMs: 1_000, isAborted: false, turnId: `t${index}`, reason: 'answer' })
      }
      await clock.settle()
      await pickByTask($, clock)
      const ui = await $.ui.mount({ ...DESKTOP_PANE, surface })
      await clock.settle()
      expect(await ui.find({ key: TOO_BIG_KEY })).toBeUndefined()
      await expectDrawn(ui, `by task, 100 tasks that used the web on ${surface}`)
      expect(await ui.find({ key: surface === 'mobile' ? 'sourceview:site' : 'sourceview' })).toBeDefined()
      const rows = await keysOf(ui, 'task:')
      expect(rows[0]).toBe(taskKey('t99'))
      if (rows.length < 100) {
        expect(await ui.find({ type: 'Text', text: `… ${100 - rows.length} more tasks not drawn` })).toBeDefined()
      }
      // Where a row is plain elements, the last drawn opened by its title: drawn with its row, the rows past the budget giving way.
      if (surface !== 'desktop') {
        const last = rows.at(-1) ?? ''
        await ui.press({ key: last })
        await clock.settle()
        expect(await ui.find({ key: `card:${last}` })).toBeDefined()
        expect(await ui.find({ key: TOO_BIG_KEY })).toBeUndefined()
        expect(await keysOf(ui, 'task:')).toContain(last)
        await expectDrawn(ui, `by task, an older task open on ${surface}`)
      }
      await ui.unmount()
    })
  }

  for (const surface of ['vscode', 'mobile'] as const) {
    test(`Commits on ${surface}: a commit of 150 files open among 60 commits lists some of its files, the later commit rows giving way`, { timeoutMs: 60_000 }, async ($, on) => {
      const clock = await longDay($, on, () => {
        gitScript.log = commitsLog(60, 150)
      })
      const ui = await $.ui.mount({ ...DESKTOP_PANE, surface })
      await ui.press({ key: 'tab:commits' })
      await clock.settle()
      // The uncommitted changes and the 60 commits, each row plain elements and a title button.
      const rows = await keysOf(ui, 'commit:')
      expect(rows).toHaveLength(61)
      await ui.press({ key: commitKey(SHA) })
      await clock.settle()
      await expectDrawn(ui, `the big commit open among 60 on ${surface}`)
      // Its files keep their floor of the list: some listed, the rest counted.
      const files = await keysOf(ui, 'file:')
      expect(files.length).toBeGreaterThan(5)
      expect(await textsIn(ui, commitCardKey(SHA))).toContain(`… ${150 - files.length} more files`)
      // The commit rows past what is left give way, the open one's kept, and are counted.
      const shown = await keysOf(ui, 'commit:')
      expect(shown).toContain(commitKey(SHA))
      expect(shown.length).toBeLessThan(61)
      expect(await ui.find({ type: 'Text', text: `… ${61 - shown.length} more commits, listed again when this one is closed` })).toBeDefined()
      // One of its files opens to its diff, the drawing still whole.
      await ui.press({ key: files[0] ?? '' })
      await clock.settle()
      expect(await ui.find({ key: DIFF_PANEL_KEY })).toBeDefined()
      await expectDrawn(ui, `a file of the big commit open on ${surface}`)
      // Closed, a second later (a press within BOUNCE_MS of the last is the same click), every commit row is back.
      await clock.advance(1_000)
      await ui.press({ key: commitKey(SHA) })
      await clock.settle()
      expect(await keysOf(ui, 'commit:')).toEqual(rows)
      await ui.unmount()
    })
  }
})
