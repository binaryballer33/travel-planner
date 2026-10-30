import type { SessionCompactResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { fmtClock, mdText } from '../hooks/lib/format'
import { DEFAULT_COLUMNS, DEFAULT_UI, FAULT_WAIT_MAX_MS, FAULT_WAIT_MS, faultKey, heardFault, isModuleUsable, noteFault, usableRegions, type ModuleFault } from '../hooks/register'
import { closedAll, fitsPane, PANE_SAFE, QUICK_TABS, tabOfKey, TABS, tooBigText } from '../hooks/view/pane'
import { DESKTOP_LIMITS } from '../hooks/lib/fit'
import { readTabPress, TAB_BAR_KEY } from '../hooks/view/tab-bar'
import { tabOfHotkey } from '../hooks/lib/hotkeys'
import { commitKey, fileKey } from '../hooks/view/commits'
import { COMPACT_ARMED_LABEL, COMPACT_LABEL } from '../hooks/view/compact'
import { FILES_CARD_KEY, touchedKey } from '../hooks/view/files'
import { ROW_HIGHLIGHT, rowBoxKey } from '../hooks/view/kit'
import { OPEN_BAR } from '../hooks/view/row'
import { THEME } from '../hooks/lib/codeview'
import { call, clickRow, COMMAND, git, hoverRow, isOpenRow, memoryStore, NOW, PANE, paneOpens, run, SHA, shownCode, start, textsIn, world, type FindsAll, tabButton, keysOf } from './world'

/** Any trace of the old open/close control: its arrows or its words. */
const ARROW = /[▶▼🔽]|\bOpen\b|\bClose\b/u

const isNode = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The first element of a drawn tree that matches, depth first: `find` leaves out an element's `hover`, the tree keeps it. */
const nodeWhere = (node: unknown, match: (node: Record<string, unknown>) => boolean): Record<string, unknown> | undefined => {
  if (!isNode(node)) {
    return undefined
  }
  if (match(node)) {
    return node
  }
  for (const child of Array.isArray(node.children) ? node.children : []) {
    const found = nodeWhere(child, match)
    if (found !== undefined) {
      return found
    }
  }
  return undefined
}

const keyed =
  (key: string) =>
  (node: Record<string, unknown>): boolean =>
    isNode(node.props) && node.props.key === key

const showing =
  (text: string) =>
  (node: Record<string, unknown>): boolean =>
    node.type === 'Text' && Array.isArray(node.children) && node.children.includes(text)

/** What a compaction leaves: at least one message, the summary. */
const COMPACTED: SessionCompactResult = { messages: [{ role: 'user', text: 'The summary.', toolUses: [] }] }

test('overview: live internet, time spent by access class, session figures', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = world(on)
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await tabButton(ui, 'files')).toBeDefined()
    expect(await tabButton(ui, 'sources')).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /12\.8 MB/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /↓ 2\.10 MB\/s/ }))?.props.color).toBe('error')
    // 14.4 MB moved in 27.5 s of network activity.
    expect(await ui.find({ type: 'Text', text: '28s' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /525 kB\/s/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Execute' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\$1\.23/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /4 URLs on 3 sites/ })).toBeDefined()
    // The header: total data used, and counts on the tabs.
    expect(await ui.find({ type: 'Text', text: '⇅ 14.4 MB' })).toBeDefined()
    expect((await tabButton(ui, 'commands'))?.props.label).toBe('Commands 5')
    expect((await tabButton(ui, 'sources'))?.props.label).toBe('Sources 4')
    // Tokens read as k and M.
    expect(await ui.find({ type: 'Text', text: /50k \/ 200k tokens/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '🔋 49%' })).toBeDefined()
    // Which model and effort did the work.
    expect(await ui.find({ type: 'Text', text: 'Opus 5.5' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'xhigh' })).toBeDefined()
    // The charts are Compute's: Overview keeps its live figures and a way there.
    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    await ui.press({ key: 'ov:compute' })
    expect((await tabButton(ui, 'compute'))?.props.variant).toBe('primary')
    // The battery before and after, and the share of the drop the work explains.
    expect(await ui.find({ type: 'Text', text: '7% of the drop' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '7% from the work' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Whole Mac now ↓ 2\.50 MB\/s/ })).toBeDefined()
    await ui.press({ key: 'tab:overview' })
  }
})

test('commands: each row is one click target with no arrow; a double click opens it once', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = world(on)
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:commands' })
    const row = (await ui.findAll({ type: 'Client' })).find(client => client.key?.startsWith('cmd:') === true)
    const key = row?.key ?? ''
    expect(key).toMatch(/^cmd:/)
    expect(await ui.find({ in: key, type: 'Text', text: ARROW })).toBeUndefined()
    expect(await isOpenRow(ui, key)).toBe(false)
    // The title says what it does and who ran it; the line under it outlines the command (its programs), plain text outside the region (it can be selected).
    expect(await ui.find({ in: key, type: 'Text', text: 'Fetch the data' })).toBeDefined()
    expect(await ui.find({ in: key, type: 'Text', text: 'Claude' })).toBeDefined()
    expect(await ui.find({ in: key, type: 'Text', text: COMMAND })).toBeUndefined()
    expect((await textsIn(ui, rowBoxKey(key))).some(text => text.startsWith('curl') && !text.includes(COMMAND))).toBe(true)
    expect(await ui.find({ in: key, type: 'Text', text: 'Opus 5.5 · xhigh' })).toBeDefined()
    expect(await ui.find({ in: key, type: 'Text', text: fmtClock(NOW, NOW) })).toBeDefined()
    expect(await ui.find({ in: key, type: 'Text', text: 'W' })).toBeDefined()
    expect(await ui.find({ in: key, type: 'Text', text: /12\.4 MB/ })).toBeDefined()
    // A double click anywhere on the row: opens once, stays open.
    await clickRow(ui, key)
    await clickRow(ui, key)
    await clock.settle()
    expect(await isOpenRow(ui, key)).toBe(true)
    expect(await ui.find({ in: key, type: 'Text', text: ARROW })).toBeUndefined()
    expect(await ui.find({ type: 'Code', text: /downloaded data\.zip/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Started' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Effort' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Write' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '6.5s' })).toBeDefined()
    // A later click on the far end of the row closes it.
    await clock.advance(1_000)
    await clickRow(ui, key, 100)
    expect(await isOpenRow(ui, key)).toBe(false)
    expect(await ui.find({ type: 'Code', text: /downloaded data\.zip/ })).toBeUndefined()
    await clock.advance(1_000)
    await ui.select({ key: 'access', value: 'read' })
    expect((await ui.findAll({ type: 'Client' })).some(client => client.key === key)).toBe(false)
    await ui.select({ key: 'access', value: 'all' })
  }
})

test('rows fall back to a title button, with no arrow, where no Client is drawn', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = world(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.press({ key: 'tab:commands' })
  const buttons = (await ui.findAll({ type: 'Button' })).filter(button => button.key?.startsWith('cmd:') === true)
  // One button per row: its title, the summary of what it does. No arrow button, no Open or Close.
  expect(buttons.map(button => button.props.label)).toContain('Fetch the data')
  expect(buttons.some(button => ARROW.test(String(button.props.label)))).toBe(false)
  const key = buttons.find(button => button.props.label === 'Fetch the data')?.key ?? ''
  // Who ran it beside it, and the command's outline on the line under it.
  expect(await ui.find({ type: 'Text', text: 'Claude' })).toBeDefined()
  expect((await ui.findAll({ type: 'Text' })).some(text => text.text.startsWith('curl') && !text.text.includes(COMMAND))).toBe(true)
  const box = async (): Promise<Record<string, unknown> | undefined> => (await ui.find({ type: 'Box', key: rowBoxKey(key) }))?.props
  expect(nodeWhere(await ui.drawn(), keyed(rowBoxKey(key)))?.hover).toEqual({ backgroundColor: ROW_HIGHLIGHT })
  expect((await box())?.backgroundColor).toBeUndefined()
  await ui.press({ key })
  expect(await ui.find({ type: 'Code', text: /downloaded data\.zip/ })).toBeDefined()
  // Open: the accent bar leads the row, and the row stays lit.
  expect(await ui.find({ type: 'Text', text: OPEN_BAR })).toBeDefined()
  expect((await box())?.backgroundColor).toBe(ROW_HIGHLIGHT)
})

/**
 * The world's diff of src/app.py: the engine's diff view on the terminal; on
 * the desktop the code view, numbered, the added line tinted with its marker.
 */
const expectDiff = async (ui: FindsAll, surface: 'terminal' | 'desktop'): Promise<void> => {
  const shown = await shownCode(ui)
  if (surface === 'terminal') {
    expect(shown.kind).toBe('code')
    expect(shown.format).toBe('diff')
    expect(shown.text).toMatch(/\+new line/)
    return
  }
  expect(shown.kind).toBe('view')
  expect(shown.text).toContain('app.py')
  expect(shown.text).toContain('new line')
  expect(shown.text).toContain('old line')
  expect(shown.svg).toContain(`fill="${THEME.addMarker}" font-weight="bold">+</text>`)
  expect(shown.svg).toContain(`fill="${THEME.delMarker}" font-weight="bold">−</text>`)
}

test('commits: a click on a commit opens its message and files, a click on a file its diff', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = world(on)
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:commits' })
    const commit = commitKey(SHA)
    expect(await ui.find({ in: commit, type: 'Text', text: 'feat: add the thing' })).toBeDefined()
    expect(await ui.find({ in: commit, type: 'Text', text: fmtClock(NOW - 60_000, NOW) + ' · 1m ago' })).toBeDefined()
    await clickRow(ui, commit)
    expect(await ui.find({ type: 'Text', text: 'Why it matters.' })).toBeDefined()
    const file = fileKey(SHA, 'src/app.py')
    expect(file).toMatch(/^file:[0-9a-z]+$/)
    await clickRow(ui, file)
    await clickRow(ui, file) // clicked again while it loads: stays open
    await clock.settle()
    await expectDiff(ui, surface)
    await ui.press({ key: 'diff:close' })
    await clock.advance(1_000)
    await clickRow(ui, commit)
    expect(await ui.find({ type: 'Text', text: 'Why it matters.' })).toBeUndefined()
    await clock.advance(1_000)
  }
})

test('files: created, modified and read files with times; a click shows the diff or the current text', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = world(on)
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:files' })
    const outside = touchedKey('/outside/notes.md')
    const inside = touchedKey('/repo/src/app.py')
    expect(await ui.find({ in: outside, type: 'Text', text: '/outside/notes.md' })).toBeDefined()
    expect(await ui.find({ in: outside, type: 'Text', text: 'edited' })).toBeDefined()
    expect(await ui.find({ in: inside, type: 'Text', text: 'src/app.py' })).toBeDefined()
    expect(await ui.find({ in: inside, type: 'Text', text: fmtClock(NOW - 5_000, NOW) })).toBeDefined()
    expect(await ui.find({ in: inside, type: 'Text', text: /read ×1 · Read/ })).toBeDefined()
    expect(await ui.find({ in: touchedKey('/repo/notes.md'), type: 'Text', text: 'notes.md' })).toBeDefined()
    // The counts are the Files card's figures: two created.
    const figures = await textsIn(ui, FILES_CARD_KEY)
    expect(figures.slice(figures.indexOf('Created'), figures.indexOf('Created') + 2)).toEqual(['Created', '2'])
    await clickRow(ui, outside)
    await clock.settle()
    const content = await shownCode(ui)
    expect(content.kind).toBe(surface === 'terminal' ? 'code' : 'view')
    expect(content.text).toContain('first line')
    await ui.press({ key: 'diff:close' })
    await clickRow(ui, inside)
    await clock.settle()
    await expectDiff(ui, surface)
    await ui.press({ key: 'diff:close' })
    await clock.advance(1_000)
  }
})

test('sources: every website and search, with links', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = world(on)
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:sources' })
    expect(await ui.find({ type: 'Text', text: 'docs.example.com' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'learn.example.org' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'spy options' })).toBeDefined()
    const links = await ui.findAll({ type: 'Link' })
    expect(links.map(link => link.props.href)).toContain('https://docs.example.com/guide')
    expect(links.map(link => link.props.href)).toContain('https://example.com/data.zip')
    expect(await ui.find({ type: 'Text', text: '200' })).toBeDefined()
    await ui.press({ key: 'copyurls' })
  }
})

test('a failed command raises a toast; /monitor off and on pause and resume; the report sums the session', { timeoutMs: 20_000 }, async ($, on) => {
  const toasts: string[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', ($, e) => ({ value: git(e.argv) }))
  on('process.spawn', async function* () {
    await clock.sleep(1e9)
    return { value: { code: 0, signal: null } }
  })
  on('fs.exists', () => ({ value: true }))
  on('session.usage', () => ({ value: { startedAt: NOW - 60_000, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 1 }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', () => ({ isError: true as const, result: 'boom', text: 'boom\nExit code 3' }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await call($, { tool: 'Bash', command: 'make test', description: 'Run the tests' })
  await clock.settle()
  expect(toasts.some(text => text.includes('exit 3') && text.includes('make test'))).toBe(true)

  expect(await run($, 'session-monitor', 'off')).toContain('paused')
  expect(await run($, 'session-monitor', '')).toContain('/session-monitor on')
  // /monitor stays as an alias.
  expect(await run($, 'monitor', '')).toContain('Session Monitor is open')
  expect(await run($, 'monitor', 'on')).toBe('Session Monitor is open.')

  const report = await run($, 'monitor-report', '')
  expect(report).toContain('1 run in')
  expect(report).toContain('Execute: 1')
  expect(report).toContain('1 commits this session')
})

test('rows light under the pointer, and an open row keeps its bar and its light', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = world(on)
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:commits' })
    const commit = commitKey(SHA)
    const subject = 'feat: add the thing'
    // The row's Box, around its region: the desktop lights it, its second line and all, by a hover style it paints itself.
    const rowBox = async (): Promise<Record<string, unknown> | undefined> => (await ui.find({ type: 'Box', key: rowBoxKey(commit) }))?.props
    const box = async (): Promise<Record<string, unknown> | undefined> => (await ui.find({ in: commit, type: 'Box', key: 'row' }))?.props
    const title = async (): Promise<Record<string, unknown> | undefined> => (await ui.find({ in: commit, type: 'Text', text: subject }))?.props
    const isInverted = async (): Promise<boolean> => (await title())?.inverse === true
    expect(await ui.find({ in: commit, type: 'Text', text: ARROW })).toBeUndefined()
    expect(await ui.find({ in: 'commit:worktree', type: 'Text', text: ARROW })).toBeUndefined()
    expect(nodeWhere(await ui.drawn(), keyed(rowBoxKey(commit)))?.hover).toEqual(surface === 'desktop' ? { backgroundColor: ROW_HIGHLIGHT } : undefined)
    expect((await rowBox())?.backgroundColor).toBeUndefined()
    // The region lights nothing of its own on either surface: no background, no hover background.
    const drawn = await ui.drawn({ in: commit })
    expect(nodeWhere(drawn, keyed('row'))?.hover).toBeUndefined()
    expect((await box())?.backgroundColor).toBeUndefined()
    // The terminal inverts the title under the pointer (also set as a hover style); the desktop does not.
    expect(nodeWhere(drawn, showing(subject))?.hover).toEqual(surface === 'terminal' ? { inverse: true } : undefined)
    expect(await isInverted()).toBe(false)
    await hoverRow(ui, commit, 'enter')
    expect(await isInverted()).toBe(surface === 'terminal')
    expect((await box())?.backgroundColor).toBeUndefined()
    await hoverRow(ui, commit, 'leave')
    expect(await isInverted()).toBe(false)
    // A move with no button down lights it too (a surface that reports no enter).
    await hoverRow(ui, commit, 'move')
    expect(await isInverted()).toBe(surface === 'terminal')
    await hoverRow(ui, commit, 'leave')
    // Open: the accent bar leads it and the title is bold; on the desktop the row's Box stays lit with the pointer gone.
    expect(await isOpenRow(ui, commit)).toBe(false)
    await clickRow(ui, commit)
    expect(await isOpenRow(ui, commit)).toBe(true)
    expect((await title())?.bold).toBe(true)
    expect((await rowBox())?.backgroundColor).toBe(surface === 'desktop' ? ROW_HIGHLIGHT : undefined)
    expect((await box())?.backgroundColor).toBeUndefined()
    // The commit's files are rows of their own, also without arrows.
    const file = fileKey(SHA, 'src/app.py')
    expect(await ui.find({ in: file, type: 'Text', text: 'src/app.py' })).toBeDefined()
    expect(await ui.find({ in: file, type: 'Text', text: ARROW })).toBeUndefined()
    expect(await isOpenRow(ui, file)).toBe(false)
    await clock.advance(1_000)
    await clickRow(ui, commit)
    expect(await isOpenRow(ui, commit)).toBe(false)
    expect((await rowBox())?.backgroundColor).toBeUndefined()
    await clock.advance(1_000)
  }
})

test('files: rows open without arrows and show the open bar', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = world(on)
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:files' })
    const outside = touchedKey('/outside/notes.md')
    expect(await ui.find({ in: outside, type: 'Text', text: ARROW })).toBeUndefined()
    await clickRow(ui, outside)
    await clock.settle()
    expect(await isOpenRow(ui, outside)).toBe(true)
    await ui.press({ key: 'diff:close' })
    expect(await isOpenRow(ui, outside)).toBe(false)
    await clock.advance(1_000)
  }
})

test('section titles are markdown headings, drawn larger, with their dim aside beside them', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = world(on)
  await start($, clock)
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:overview' })
    const headings = (await ui.findAll({ type: 'Markdown' })).map(found => String(found.props.text))
    // Overview's sections, in the order asked for: Prompts under Models & effort, above Agents;
    // Running now right under Commands; Session right above Heaviest commands.
    const order = ['Models & effort', 'Prompts', 'Agents', 'Most recent commands', 'Commands', 'Running now', 'Session', 'Heaviest commands', 'By tool', 'Time spent', 'Artifacts']
    const at = order.map(title => headings.indexOf(`## ${mdText(title, 200)}`))
    expect(at.every(index => index >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    const next = (above: string, below: string): void => expect(at[order.indexOf(below)]).toBe((at[order.indexOf(above)] ?? 0) + 1)
    next('Models & effort', 'Prompts')
    next('Prompts', 'Agents')
    next('Commands', 'Running now')
    next('Session', 'Heaviest commands')
    // The live figures are the header's, on every tab: Overview has no Live stats of its own.
    expect(headings).not.toContain('## Live stats')
    // The charts left for Compute.
    for (const gone of ['## Internet', '## Energy', '## Compute']) {
      expect(headings).not.toContain(gone)
    }
    // Compute's sections, in order; Battery sits inside Power & energy.
    await ui.press({ key: 'tab:compute' })
    const charts = (await ui.findAll({ type: 'Markdown' })).map(found => String(found.props.text))
    const sections = ['Now', 'CPU', 'Memory', 'Power & energy', 'Internet', 'Disk', 'Where it went', 'By prompt', 'Heaviest commands']
    const where = sections.map(title => charts.indexOf(`## ${mdText(title, 200)}`))
    expect(where.every(index => index >= 0)).toBe(true)
    expect([...where].sort((a, b) => a - b)).toEqual(where)
    expect((await ui.find({ type: 'Markdown', text: /Battery/ }))?.props.text).toBe('### Battery')
    expect(charts.indexOf('### Battery')).toBeGreaterThan(charts.indexOf(`## ${mdText('Power & energy', 200)}`))
    expect(charts.indexOf('### Battery')).toBeLessThan(charts.indexOf('## Internet'))
    expect((await ui.find({ type: 'Text', text: 'before the work, now, and how much of the drop the work explains' }))?.props.dimColor).toBe(true)
    // The old title texts are gone: the heading carries them now.
    expect(await ui.find({ type: 'Text', text: 'Battery' })).toBeUndefined()
    await ui.press({ key: 'tab:resources' })
    expect(await ui.find({ type: 'Markdown', text: /^## Commands by / })).toBeDefined()
    await ui.press({ key: 'tab:sources' })
    expect(await ui.find({ type: 'Markdown', text: '## Websites' })).toBeDefined()
    await ui.press({ key: 'tab:commits' })
    expect(await ui.find({ type: 'Markdown', text: '## Net change this session' })).toBeDefined()
  }
})

test('in the terminal, which draws no heading larger, section titles stay bold accent text', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = world(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  const isTitle = async (title: string): Promise<boolean> =>
    // The title, among any plain labels of the same word.
    (await ui.findAll({ type: 'Text', text: title })).filter(text => text.text === title).some(text => text.props.bold === true && text.props.color === 'claude')
  for (const title of ['Models & effort', 'Time spent', 'Session', 'By tool', 'Running now']) {
    expect(await isTitle(title)).toBe(true)
  }
  expect(await ui.find({ type: 'Text', text: 'Live stats' })).toBeUndefined()
  await ui.press({ key: 'tab:compute' })
  for (const title of ['Now', 'CPU', 'Memory', 'Power & energy', 'Internet', 'Disk', 'Where it went']) {
    expect(await isTitle(title)).toBe(true)
  }
  // Battery is a part of Power & energy: bold, not a section's accent title.
  const battery = (await ui.findAll({ type: 'Text', text: 'Battery' })).find(text => text.text === 'Battery')
  expect(battery?.props.bold).toBe(true)
  expect(battery?.props.color).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: 'before the work, now, and how much of the drop the work explains' }))?.props.dimColor).toBe(true)
  await ui.press({ key: 'tab:commits' })
  expect((await ui.findAll({ type: 'Text', text: 'Net change this session' })).find(text => text.text === 'Net change this session')?.props.color).toBe('claude')
})

test('a title reads as written inside markdown', () => {
  expect(mdText('Compute & energy', 100)).toBe('Compute \\& energy')
  expect(mdText('fix *all* the [links](x) #1 <b> a_b `c` ~d~ | e \\ f!', 200)).toBe(
    'fix \\*all\\* the \\[links\\](x) \\#1 \\<b\\> a\\_b \\`c\\` \\~d\\~ \\| e \\\\ f\\!',
  )
  expect(mdText('two\nlines', 100)).toBe('two …')
})

test('compact: a first press arms the button, a second within 6 s compacts; a double click is one press', { timeoutMs: 20_000 }, async ($, on) => {
  const toasts: string[] = []
  const clock = world(on, toasts)
  let compactions = 0
  on('session.compact', (): SessionCompactResult => {
    compactions += 1
    return COMPACTED
  })
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:overview' })
    const before = compactions
    const labels = async (): Promise<unknown[]> => [(await ui.find({ key: 'compact' }))?.props.label, (await ui.find({ key: 'compact:session' }))?.props.label]
    // Beside the context figure: in the header and in the Session section.
    expect(await ui.find({ type: 'Text', text: 'ctx 25%' })).toBeDefined()
    expect(await labels()).toEqual([COMPACT_LABEL, COMPACT_LABEL])
    await ui.press({ key: 'compact' })
    expect(compactions).toBe(before)
    expect(await labels()).toEqual([COMPACT_ARMED_LABEL, COMPACT_ARMED_LABEL])
    // The second click of a double click is the same press: still armed, nothing compacted.
    await ui.press({ key: 'compact' })
    expect(compactions).toBe(before)
    expect(await labels()).toEqual([COMPACT_ARMED_LABEL, COMPACT_ARMED_LABEL])
    await clock.advance(1_000)
    await ui.press({ key: 'compact:session' })
    expect(compactions).toBe(before + 1)
    expect(toasts.at(-1)).toBe('Session compacted')
    expect(await labels()).toEqual([COMPACT_LABEL, COMPACT_LABEL])
    // The header carries it on every tab.
    await ui.press({ key: 'tab:commits' })
    expect((await ui.find({ key: 'compact' }))?.props.label).toBe(COMPACT_LABEL)
    expect(await ui.find({ key: 'compact:session' })).toBeUndefined()
    await clock.advance(1_000)
  }
})

test('compact: a press after the window arms again; a busy session or a veto says why', { timeoutMs: 20_000 }, async ($, on) => {
  const toasts: string[] = []
  const clock = world(on, toasts)
  let compactions = 0
  let reply: 'compact' | 'busy' | 'veto' = 'compact'
  on('session.compact', (): SessionCompactResult => {
    compactions += 1
    if (reply === 'busy') {
      throw new Error('a turn is running')
    }
    return reply === 'veto' ? { skip: 'kept by policy' } : COMPACTED
  })
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const label = async (): Promise<unknown> => (await ui.find({ key: 'compact' }))?.props.label
    const before = compactions
    await ui.press({ key: 'compact' })
    expect(await label()).toBe(COMPACT_ARMED_LABEL)
    // The window closes: the label goes back, and the next press only arms again.
    await clock.advance(6_500)
    expect(await label()).toBe(COMPACT_LABEL)
    await ui.press({ key: 'compact' })
    expect(compactions).toBe(before)
    expect(await label()).toBe(COMPACT_ARMED_LABEL)
    // While Claude works the engine refuses: a toast says to wait.
    reply = 'busy'
    await clock.advance(1_000)
    await ui.press({ key: 'compact' })
    expect(compactions).toBe(before + 1)
    expect(toasts.at(-1)).toBe("Can't compact while Claude is working — try again when it's idle")
    expect(await label()).toBe(COMPACT_LABEL)
    // A hook vetoes it: a toast says so.
    reply = 'veto'
    await clock.advance(1_000)
    await ui.press({ key: 'compact' })
    await clock.advance(1_000)
    await ui.press({ key: 'compact' })
    expect(compactions).toBe(before + 2)
    expect(toasts.at(-1)).toBe('Not compacted: a hook vetoed it (kept by policy)')
    expect(toasts).not.toContain('Session compacted')
    reply = 'compact'
    await clock.advance(1_000)
  }
})

test('network: every call shows its own, every prompt its calls’ summed, in Commands, on its group, its card and Overview', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = world(on)
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:commands' })
    const rows = (await ui.findAll({ type: 'Client' })).map(client => client.key ?? '').filter(key => key.startsWith('cmd:'))
    expect(rows.length).toBe(5)
    for (const row of rows) {
      // The Bash call measured; a call inside Claude Code (Read, Write, the web tools) not on its own.
      expect(await ui.find({ in: row, type: 'Text', text: /^⇅ / })).toBeDefined()
    }
    // The prompt's group sums its calls: the one shell call's 12.4 MB.
    const group = (await ui.findAll({ type: 'Client' })).map(client => client.key ?? '').find(key => key.startsWith('grp:')) ?? ''
    expect(await ui.find({ in: group, type: 'Text', text: '⇅ 12.4 MB' })).toBeDefined()
    // Its card on Prompts, and its line on Overview.
    await ui.press({ key: 'tab:prompts' })
    const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text)
    expect(texts[texts.indexOf('Network of its calls') + 1]).toBe('⇅ 12.4 MB · ↓ 12.4 MB ↑ 30.0 kB')
    await ui.press({ key: 'tab:overview' })
    expect((await ui.findAll({ type: 'Text' })).some(text => text.text.includes(' · ⇅ 12.4 MB'))).toBe(true)
    await clock.advance(1_000)
    await ui.unmount()
  }
})

/** The row among `prefix`'s whose second line starts with `lead`: the shell call's. */
const rowLeading = async (ui: FindsAll & Parameters<typeof textsIn>[0], prefix: string, lead: string): Promise<string> => {
  const keys = (await ui.findAll({ type: 'Client' })).map(client => client.key ?? '').filter(key => key.startsWith(prefix))
  for (const key of keys) {
    if ((await textsIn(ui, rowBoxKey(key))).some(line => line.startsWith(lead))) {
      return key
    }
  }
  return ''
}

test("Overview's recent calls show their network and model and outline their command; an opened call still shows it whole", { timeoutMs: 30_000 }, async ($, on) => {
  const clock = world(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The Bash call's second line: its outline, not the whole command.
  const recent = await rowLeading(ui, 'recent:', 'curl')
  expect(recent).not.toBe('')
  expect((await textsIn(ui, rowBoxKey(recent))).some(line => line.includes(COMMAND))).toBe(false)
  const texts = (await ui.findAll({ in: recent, type: 'Text' })).map(text => text.text)
  expect(texts).toContain('⇅ 12.4 MB')
  expect(texts).toContain('Opus 5.5 · xhigh')
  // Opened in Commands, its card shows the command whole.
  await ui.press({ key: 'tab:commands' })
  const row = await rowLeading(ui, 'cmd:', 'curl')
  await clickRow(ui, row)
  await clock.settle()
  const opened = [...(await ui.findAll({ type: 'Text' })).map(text => text.text), ...(await ui.findAll({ type: 'Code' })).map(code => code.text)]
  expect(opened.some(text => text.includes(COMMAND))).toBe(true)
  await clock.advance(1_000)
  await ui.unmount()
})

test('every open asks for 57 columns, whatever width the pane was drawn at; no width of its own is kept', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = world(on)
  // What an earlier version kept of the width it was drawn at.
  memoryStore.set('paneColumns', 54)
  memoryStore.set('paneColumnsDefault', 57)
  await start($, clock)
  expect([memoryStore.has('paneColumns'), memoryStore.has('paneColumnsDefault')]).toEqual([false, false])
  // About 400 px of the desktop app's text: the dock honours it, the desktop app sizes its panel itself.
  await run($, 'monitor', '')
  expect(paneOpens.at(-1)).toBe(DEFAULT_COLUMNS)
  expect(DEFAULT_COLUMNS).toBe(57)
  // Drawn at 54 columns (what the desktop app gave), a moment passes: the next open still asks for 57.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 54 } })
  await clock.advance(2_500)
  await clock.settle()
  expect(memoryStore.has('paneColumns')).toBe(false)
  await run($, 'monitor', '')
  expect(paneOpens.at(-1)).toBe(DEFAULT_COLUMNS)
  await clock.advance(1_000)
  await ui.unmount()
})

test('a tab press lands by its key alone, before the button’s own closure, so a click between redraws still switches the tab', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = world(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The press hook switches the tab by the element key, whatever the button's closure does.
  await $.ui.press({ plugin: 'session-monitor', key: 'tab:compute', requestId: 'session-monitor', surface: 'terminal' })
  await clock.settle()
  expect((await tabButton(ui, 'compute'))?.props.variant).toBe('primary')
  expect(tabOfKey('tab:agents')).toBe('agents')
  expect(tabOfKey('cmd:x')).toBeUndefined()
  await clock.advance(1_000)
  await ui.unmount()
})

test("an app's pane is drawn only well under its bounds; past them, a notice and a button to close what is open", () => {
  // Short of the desktop app's every bound, by what the engine adds (handles, a region's plugin) and live figures' growth.
  expect(PANE_SAFE.nodes).toBeLessThan(DESKTOP_LIMITS.nodes)
  expect(PANE_SAFE.depth).toBeLessThan(DESKTOP_LIMITS.depth)
  expect(PANE_SAFE.chars).toBeLessThan(DESKTOP_LIMITS.chars)
  expect(fitsPane({ nodes: PANE_SAFE.nodes - 1, depth: PANE_SAFE.depth - 1, chars: PANE_SAFE.chars - 1 })).toBe(true)
  expect(fitsPane({ nodes: PANE_SAFE.nodes, depth: 1, chars: 1 })).toBe(false)
  expect(fitsPane({ nodes: 1, depth: PANE_SAFE.depth, chars: 1 })).toBe(false)
  expect(fitsPane({ nodes: 1, depth: 1, chars: PANE_SAFE.chars })).toBe(false)
})

test('Close what is open closes every call, output, prompt, commit, agent and task, and leaves the rest of the pane as it was', () => {
  const open = {
    ...DEFAULT_UI,
    tab: 'sources' as const,
    expandedCommand: 'toolu_1',
    fullOutput: 'toolu_1',
    openPrompt: 'p1',
    markedPrompt: 'p1',
    openCommit: SHA,
    expandedAgent: 'ag-1',
    openTask: 't1',
    listLimit: 90,
    sourceView: 'task' as const,
  }
  expect(closedAll(open)).toEqual({ ...open, expandedCommand: null, fullOutput: null, openPrompt: null, markedPrompt: null, openCommit: null, expandedAgent: null, openTask: null })
})

test("the too-big notice names only the bounds the drawing reached, with the pane's own and the app's above it", () => {
  const fmt = (value: number): string => value.toLocaleString('en-US')
  // Too many elements only: no word of characters or levels.
  const nodes = tooBigText({ nodes: PANE_SAFE.nodes + 3, depth: 9, chars: 30_000 })
  expect(nodes.startsWith(`It came to ${fmt(PANE_SAFE.nodes + 3)} elements;`)).toBe(true)
  expect(nodes).toContain(`the pane draws fewer than ${fmt(PANE_SAFE.nodes)}, short of the app's ${fmt(DESKTOP_LIMITS.nodes)}`)
  expect(nodes).not.toContain('characters')
  expect(nodes).not.toContain('levels')
  // Too deep only.
  expect(tooBigText({ nodes: 100, depth: PANE_SAFE.depth, chars: 1_000 }).startsWith(`It came to ${PANE_SAFE.depth} levels;`)).toBe(true)
  // Both elements and characters, each against its own bound.
  const both = tooBigText({ nodes: 2_049, depth: 9, chars: 260_000 })
  expect(both.startsWith(`It came to 2,049 elements and 260,000 characters;`)).toBe(true)
  expect(both).toContain(`fewer than ${fmt(PANE_SAFE.nodes)} and ${fmt(PANE_SAFE.chars)}, short of the app's ${fmt(DESKTOP_LIMITS.nodes)} and ${fmt(DESKTOP_LIMITS.chars)}`)
})

test('a region whose module failed on a surface is left out there for a while, then tried again; a teardown counts once', () => {
  // The fault names the module by its path under the plugin's folder; the drawing by its path from hooks/.
  expect(faultKey('desktop', './view/tab-bar.tsx')).toBe(faultKey('desktop', 'hooks/view/tab-bar.tsx'))
  const first = noteFault(undefined, NOW)
  expect(first).toEqual({ faults: 1, until: NOW + FAULT_WAIT_MS })
  const faulted = new Map<string, ModuleFault>([[faultKey('desktop', 'hooks/view/tab-bar.tsx'), first]])
  // Left out on the desktop while the wait lasts; the terminal, and the other modules, keep theirs.
  expect(isModuleUsable('desktop', './view/tab-bar.tsx', faulted, NOW + 1_000)).toBe(false)
  expect(isModuleUsable('terminal', './view/tab-bar.tsx', faulted, NOW + 1_000)).toBe(true)
  expect(isModuleUsable('desktop', './view/row.tsx', faulted, NOW + 1_000)).toBe(true)
  expect(isModuleUsable('desktop', './view/tab-bar.tsx', faulted, NOW + FAULT_WAIT_MS)).toBe(true)
  // The desktop app reports every instance of a torn-down frame: the reports while it is left out change nothing.
  expect(noteFault(first, NOW + 10)).toBe(first)
  // Failing again after the wait doubles it, up to FAULT_WAIT_MAX_MS.
  const second = noteFault(first, NOW + FAULT_WAIT_MS)
  expect(second).toEqual({ faults: 2, until: NOW + FAULT_WAIT_MS + 2 * FAULT_WAIT_MS })
  const waits: number[] = []
  let fault = second
  for (let failure = 3; failure <= 8; failure += 1) {
    const at = fault.until
    fault = noteFault(fault, at)
    waits.push(fault.until - at)
  }
  expect(waits).toEqual([4, 8, 16, 32, 32, 32].map(times => Math.min(FAULT_WAIT_MAX_MS, times * FAULT_WAIT_MS)))
  expect(waits.at(-1)).toBe(FAULT_WAIT_MAX_MS)
})

test('a fault the hook hears leaves that region out of the drawings on its surface, the plain elements in its place, until the redraw it asks for', () => {
  const ALL = { row: true, effortSlider: true, titleLink: true, tabBar: true }
  const faulted = new Map<string, ModuleFault>()
  // Nothing failed: every region where a Client is drawn, the tab bar in the desktop app only.
  expect(usableRegions('desktop', faulted, NOW)).toEqual(ALL)
  expect(usableRegions('terminal', faulted, NOW)).toEqual({ ...ALL, tabBar: false })
  // The tab bar fails in the desktop app (the fault names it under the plugin's folder): the hook records it and asks for a redraw after the wait.
  expect(heardFault(faulted, { surface: 'desktop', module: 'hooks/view/tab-bar.tsx' }, NOW)).toBe(FAULT_WAIT_MS)
  expect(usableRegions('desktop', faulted, NOW + 1)).toEqual({ ...ALL, tabBar: false })
  expect(usableRegions('terminal', faulted, NOW + 1)).toEqual({ ...ALL, tabBar: false })
  // The frame's other instances, reported while it is left out: nothing more recorded, no second redraw.
  expect(heardFault(faulted, { surface: 'desktop', module: 'hooks/view/tab-bar.tsx' }, NOW + 10)).toBeUndefined()
  // A list row failing there too leaves the rows out, and only there.
  expect(heardFault(faulted, { surface: 'desktop', module: 'hooks/view/row.tsx' }, NOW + 20)).toBe(FAULT_WAIT_MS)
  expect(usableRegions('desktop', faulted, NOW + 30)).toEqual({ ...ALL, row: false, tabBar: false })
  expect(usableRegions('terminal', faulted, NOW + 30).row).toBe(true)
  // At the redraw the wait asked for, the tab bar is drawn again; failing again then waits twice as long.
  expect(usableRegions('desktop', faulted, NOW + FAULT_WAIT_MS).tabBar).toBe(true)
  expect(heardFault(faulted, { surface: 'desktop', module: 'hooks/view/tab-bar.tsx' }, NOW + FAULT_WAIT_MS)).toBe(2 * FAULT_WAIT_MS)
  expect(usableRegions('desktop', faulted, NOW + FAULT_WAIT_MS + 1).tabBar).toBe(false)
})

test('every tab has a letter of its own, which opens it with no ctrl or ⌘ held', () => {
  const letters = TABS.map(tab => tab.hotkey)
  // One lowercase letter each, as the engine takes a Button's hotkey, none shared.
  expect(letters.every(letter => /^[a-z]$/.test(letter))).toBe(true)
  expect(new Set(letters).size).toBe(TABS.length)
  for (const tab of TABS) {
    expect(tabOfHotkey({ key: tab.hotkey })).toBe(tab.id)
  }
  expect([tabOfHotkey({ key: 'P', shift: true }), tabOfHotkey({ key: 'p', ctrl: true }), tabOfHotkey({ key: 'p', meta: true }), tabOfHotkey({ key: 'x' }), tabOfHotkey({ key: 'return' })]).toEqual(['prompts', undefined, undefined, undefined, undefined])
})

test('in the desktop app the tab bar is a Client: its buttons switch the tab by its key, after any number of redraws', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = world(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // One region, keyed TAB_BAR_KEY, holds every tab's button; the pane's own tree holds none.
  expect(await ui.findAll({ type: 'Client', key: TAB_BAR_KEY })).toHaveLength(1)
  expect(await keysOf(ui, 'tab:')).toEqual([])
  expect((await ui.findAll({ type: 'Button', in: TAB_BAR_KEY })).map(button => button.key)).toEqual(TABS.map(tab => `tab:${tab.id}`))
  // In the bar's order, each with its letter.
  expect(TABS.map(tab => `${tab.text} ${tab.hotkey}`)).toEqual(['Overview o', 'Prompts p', 'Agents a', 'Commands c', 'Commits g', 'Files f', 'Explorer e', 'Sources s', 'Resources r', 'Compute m', 'Ports t', 'Cache h'])
  expect(QUICK_TABS).toEqual(['overview', 'prompts', 'agents', 'commands', 'commits', 'files', 'explorer', 'sources'])
  // Overview is live: the sampler redraws it every second, and every redraw hands its plain buttons new handles.
  await clock.advance(5_000)
  await clock.settle()
  // A press of a button in the region, as the desktop app sends it (by the Client's key and the button's).
  await ui.press({ key: 'tab:prompts' })
  await clock.settle()
  expect((await tabButton(ui, 'prompts'))?.props.variant).toBe('primary')
  // What the button's own closure posts lands the same way.
  await clock.advance(5_000)
  await ui.post({ kind: 'tab', tab: 'commits' }, { in: TAB_BAR_KEY })
  await clock.settle()
  expect((await tabButton(ui, 'commits'))?.props.variant).toBe('primary')
  // A post naming no tab changes nothing.
  await ui.post({ kind: 'tab', tab: 'nowhere' }, { in: TAB_BAR_KEY })
  await clock.settle()
  expect((await tabButton(ui, 'commits'))?.props.variant).toBe('primary')
  expect(readTabPress({ kind: 'tab', tab: 'files' })).toBe('files')
  expect(readTabPress({ kind: 'prompt', id: 'x' })).toBeUndefined()
  // The desktop app draws no hotkeys: a click gives the bar the focus, and a tab's letter opens it.
  await clock.advance(1_000)
  await ui.key({ key: 'a', in: TAB_BAR_KEY })
  await clock.settle()
  expect((await tabButton(ui, 'agents'))?.props.variant).toBe('primary')
  await clock.advance(1_000)
  await ui.key({ key: 'S', shift: true, in: TAB_BAR_KEY })
  await clock.settle()
  expect((await tabButton(ui, 'sources'))?.props.variant).toBe('primary')
  // With ⌘ or ctrl held, or a key that is no tab's, nothing changes.
  await clock.advance(1_000)
  await ui.key({ key: 'o', meta: true, in: TAB_BAR_KEY })
  await ui.key({ key: 'x', in: TAB_BAR_KEY })
  await clock.settle()
  expect((await tabButton(ui, 'sources'))?.props.variant).toBe('primary')
  // A row clicked holds the focus as well: its region hears the letters too.
  await clock.advance(1_000)
  await ui.key({ key: 'c', in: TAB_BAR_KEY })
  await clock.settle()
  const [row] = await keysOf(ui, 'cmd:')
  expect(row).toBeDefined()
  await ui.key({ key: 'p', in: row ?? '' })
  await clock.settle()
  expect((await tabButton(ui, 'prompts'))?.props.variant).toBe('primary')
  await clock.advance(1_000)
  await ui.unmount()
})

test('a click that only lands the focus ring on a tab button switches the tab, as a press would', { timeoutMs: 30_000 }, async ($, on) => {
  on('ui.focus', () => ({}))
  const clock = world(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The ring lands on the Prompts button by the person's click.
  await $.ui.focus({ component: 'Pane', requestId: 'session-monitor', plugin: 'session-monitor', element: 'tab:prompts', origin: { kind: 'person' } })
  await clock.settle()
  expect((await tabButton(ui, 'prompts'))?.props.variant).toBe('primary')
  await clock.advance(1_000)
  await ui.unmount()
})
