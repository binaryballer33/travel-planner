// Find in conversation's keys in the desktop app: which app macOS must allow
// to press them (the engine, "Claude Code", not Claude), what the probe that
// asks reads, what a refused Find says, and the Prompts tab's offer to allow
// them, which opens Privacy & Security → Accessibility and watches the switch.

import type { On, ProcessRunResult, RenderSurface } from 'claude-code'
import { describe, expect, test, type Engine } from 'claude-code/testing'

import { keyOf } from '../hooks/lib/format'
import {
  ACCESSIBILITY_SETTINGS,
  allowedKeysText,
  allowKeysText,
  ENGINE_APP,
  findAccessProbe,
  findFallbackText,
  findKeystrokes,
  findRefusal,
  findSnippet,
  readFindAccess,
  readStored,
  storeKey,
} from '../hooks/lib/prompts'
import { FIND_ACCESS_CARD, FIND_ALLOW_KEY, jumpLabel } from '../hooks/view/kit'
import { clipboard, fail, findAsked, keystrokes, memoryStore, ok, PANE, SESSION_ID, textsIn, world } from './world'

/** Where the desktop app keeps the engine it runs: an app bundle of its own. */
const APP_PATH = '/Users/you/Library/Application Support/Claude/claude-code/2.1.295/9d6405864fdc/claude.app'
const APP = { name: 'Claude Code', path: APP_PATH }

/** What the probe printed on a Mac where Accessibility is off for the engine (as it is where this was written). */
const probeSays = (trusted: boolean): ProcessRunResult => ok(JSON.stringify({ trusted, app: APP_PATH, name: 'Claude Code' }))

/** System Events' refusals, as `osascript` prints them. */
const KEYSTROKES_REFUSED = '47:52: execution error: System Events got an error: osascript is not allowed to send keystrokes. (1002)'
const ASSISTIVE_REFUSED = '40:44: execution error: System Events got an error: osascript is not allowed assistive access. (-1728)'
const EVENTS_REFUSED = '13:72: execution error: Not authorized to send Apple events to System Events. (-1743)'

const failed = (stderr: string): ProcessRunResult => ({ exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false })

describe('the probe that asks macOS', () => {
  test('asks for the app macOS holds responsible, by its bundle, and presses nothing', () => {
    const [command, language, name, flag, script] = findAccessProbe(false)
    expect([command, language, name, flag]).toEqual(['osascript', '-l', 'JavaScript', '-e'])
    // The responsible process, as macOS judges it (the engine, which Claude starts through its disclaimer helper), named by its bundle.
    expect(script).toContain('responsibility_get_pid_responsible_for_pid')
    expect(script).toContain("'.app/'")
    expect(script).toContain('CFBundleName')
    expect(script).toContain('AXTrustedCheckOptionPrompt: false')
    // Nothing is pressed and no app is scripted: no System Events, no keystroke.
    for (const word of ['System Events', 'keystroke', 'key code']) {
      expect(script).not.toContain(word)
    }
    // Asking differs only in letting macOS list the app (and perhaps show its prompt).
    const asking = findAccessProbe(true)[4] ?? ''
    expect(asking).toContain('AXTrustedCheckOptionPrompt: true')
    expect(asking.replace('AXTrustedCheckOptionPrompt: true', 'AXTrustedCheckOptionPrompt: false')).toBe(script)
  })

  test('reads whether the keys may be pressed, and for which app', () => {
    expect(readFindAccess(`${JSON.stringify({ trusted: false, app: APP_PATH, name: 'Claude Code' })}\n`)).toEqual({ isAllowed: false, app: APP })
    expect(readFindAccess(JSON.stringify({ trusted: true, app: '', name: '' }))).toEqual({ isAllowed: true, app: null })
    // A bundle that names nothing is called by its folder.
    expect(readFindAccess(JSON.stringify({ trusted: false, app: '/Applications/Utilities/Terminal.app', name: '' }))).toEqual({
      isAllowed: false,
      app: { name: 'Terminal', path: '/Applications/Utilities/Terminal.app' },
    })
    for (const junk of ['', 'pressed', '[]', 'null', '{"trusted":"yes"}', '{"app":"/x.app"}']) {
      expect(readFindAccess(junk)).toBeUndefined()
    }
  })

  test("a refusal says which list the app is missing from; anything else is no refusal", () => {
    expect(findRefusal(KEYSTROKES_REFUSED)).toBe('accessibility')
    expect(findRefusal(ASSISTIVE_REFUSED)).toBe('accessibility')
    expect(findRefusal('System Events got an error: Sending keystrokes is disabled.')).toBe('accessibility')
    expect(findRefusal(EVENTS_REFUSED)).toBe('automation')
    for (const other of ['', 'no', 'execution error: Can’t get application process 1. (-1728)']) {
      expect(findRefusal(other)).toBeUndefined()
    }
  })

  test('what a refused Find says: what to press, and what to switch on for which app', () => {
    const asked = findAsked('fix the ports tab')
    expect(findFallbackText('fix the ports tab', undefined, ENGINE_APP)).toBe(asked)
    expect(findFallbackText('fix the ports tab', 'accessibility', 'Claude Code')).toBe(
      `${asked} To have the button press them, switch on “Claude Code” in System Settings → Privacy & Security → Accessibility.`,
    )
    expect(findFallbackText('fix the ports tab', 'automation', 'Claude Code')).toBe(
      `${asked} To have the button press them, allow “Claude Code” to control System Events in System Settings → Privacy & Security → Automation.`,
    )
    expect(allowKeysText(APP, true)).toContain('Switch on “Claude Code”')
    expect(allowKeysText(APP, true)).toContain('paste its path (copied)')
    expect(allowKeysText(null, false)).toContain(`Switch on “${ENGINE_APP}”`)
    expect(allowKeysText(null, false)).not.toContain('copied')
    expect(allowedKeysText(APP)).toBe('“Claude Code” may press keys now: ⌕ Find in conversation types the search in the app\'s Find for you.')
  })
})

type AccessWorld = {
  /** The probes run, oldest first; what the next one prints. */
  probes: string[][]
  probe: { answer: ProcessRunResult }
  /** The `open` runs. */
  opened: string[][]
  /** What `$.session.surfaces()` answers. */
  surfaces: { value: RenderSurface[] }
  toasts: string[]
  clock: ReturnType<typeof world>
}

/** The shared world, with the probe, `open` and the session's surfaces beneath it. */
const accessWorld = (on: On): AccessWorld => {
  const probes: string[][] = []
  const probe = { answer: fail() }
  const opened: string[][] = []
  const surfaces: { value: RenderSurface[] } = { value: [] }
  const toasts: string[] = []
  on('process.run', { argv: /AXIsProcessTrustedWithOptions/ }, ($, e) => {
    probes.push([...e.argv])
    return { value: probe.answer }
  })
  on('process.run', { argv: 'open' }, ($, e) => {
    opened.push([...e.argv])
    return { value: ok('') }
  })
  on('session.attach', ($, e) => ({ clientId: e.clientId }))
  on('session.surfaces', () => ({ value: surfaces.value }))
  const clock = world(on, toasts)
  return { probes, probe, opened, surfaces, toasts, clock }
}

/** This session's prompt ids, oldest first, as the project's history keeps them. */
const promptIds = (): string[] =>
  readStored(memoryStore.get(storeKey('/repo')))
    .filter(one => one.sessionId === SESSION_ID)
    .map(one => one.id)

/** A session in the terminal that sent one prompt. */
const begin = async ($: Engine, clock: ReturnType<typeof world>): Promise<string> => {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.turn.start({ text: 'now add a retry', turnId: 't1' })
  await clock.settle()
  return promptIds()[0] ?? ''
}

const isAsking = (argv: readonly string[]): boolean => (argv[4] ?? '').includes('AXTrustedCheckOptionPrompt: true')

describe('the Prompts tab offers to allow the keys', () => {
  test('the desktop attaching asks macOS once; while it refuses, the desktop offers to allow them for the app it names', { timeoutMs: 30_000 }, async ($, on) => {
    const { probes, probe, opened, toasts, clock } = accessWorld(on)
    await begin($, clock)
    // Nothing asked yet: no desktop has attached.
    expect(probes).toEqual([])
    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await desktop.press({ key: 'tab:prompts' })
    expect(await desktop.find({ key: FIND_ACCESS_CARD })).toBeUndefined()

    probe.answer = probeSays(false)
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
    await clock.settle()
    expect(probes).toEqual([findAccessProbe(false)])
    const offer = (await textsIn(desktop, FIND_ACCESS_CARD)).join('\n')
    expect(offer).toContain(`${jumpLabel('desktop')} only copies a prompt's opening for now`)
    expect(offer).toContain('switch on “Claude Code” in System Settings → Privacy & Security → Accessibility')
    expect(offer).toContain('That is the engine Claude runs, which macOS holds responsible for the keys, not Claude itself.')
    expect(offer).toContain('[Allow in System Settings…]')
    // The terminal scrolls its own transcript: no offer there.
    const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await terminal.press({ key: 'tab:prompts' })
    expect(await terminal.find({ key: FIND_ACCESS_CARD })).toBeUndefined()
    await terminal.unmount()

    // Allow: macOS is asked to list the app, Accessibility opens, the app's path is copied for the + button.
    await desktop.press({ key: FIND_ALLOW_KEY })
    await clock.settle()
    expect(probes.filter(isAsking)).toHaveLength(1)
    expect(opened).toEqual([['open', ACCESSIBILITY_SETTINGS]])
    expect(clipboard.texts.at(-1)).toBe(APP_PATH)
    expect(toasts.at(-1)).toBe(allowKeysText(APP, true))
    // No keys were pressed for any of it.
    expect(keystrokes.runs).toEqual([])

    // The monitor asks again every 2 seconds: once the switch is on, the offer goes and a toast says so.
    await clock.advance(2_000)
    await clock.settle()
    expect(await desktop.find({ key: FIND_ACCESS_CARD })).toBeDefined()
    probe.answer = probeSays(true)
    await clock.advance(2_000)
    await clock.settle()
    expect(await desktop.find({ key: FIND_ACCESS_CARD })).toBeUndefined()
    expect(toasts.at(-1)).toBe(allowedKeysText(APP))
    // And then it stops asking.
    const asked = probes.length
    await clock.advance(20_000)
    await clock.settle()
    expect(probes).toHaveLength(asked)
    await desktop.unmount()
  })

  test('the watch gives up after 3 minutes; Allow while macOS already allows says so and opens nothing', { timeoutMs: 30_000 }, async ($, on) => {
    const { probes, probe, opened, toasts, clock } = accessWorld(on)
    await begin($, clock)
    probe.answer = probeSays(false)
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
    await clock.settle()
    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await desktop.press({ key: 'tab:prompts' })
    await desktop.press({ key: FIND_ALLOW_KEY })
    await clock.settle()
    const before = probes.length
    for (let tick = 0; tick < 95; tick += 1) {
      await clock.advance(2_000)
      await clock.settle()
    }
    // 90 asks, 2 seconds apart, and no more; the offer stays.
    expect(probes.length - before).toBe(90)
    expect(await desktop.find({ key: FIND_ACCESS_CARD })).toBeDefined()

    // Switched on meanwhile: the next Allow finds it so, and only says so.
    probe.answer = probeSays(true)
    await clock.advance(1_000)
    await desktop.press({ key: FIND_ALLOW_KEY })
    await clock.settle()
    expect(opened).toHaveLength(1)
    expect(toasts.at(-1)).toBe(allowedKeysText(APP))
    expect(await desktop.find({ key: FIND_ACCESS_CARD })).toBeUndefined()
    await desktop.unmount()
  })

  test('a load with the desktop already drawing asks at once', { timeoutMs: 30_000 }, async ($, on) => {
    const { probes, probe, surfaces, clock } = accessWorld(on)
    surfaces.value = ['desktop']
    probe.answer = probeSays(false)
    await begin($, clock)
    expect(probes).toEqual([findAccessProbe(false)])
    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await desktop.press({ key: 'tab:prompts' })
    expect(await desktop.find({ key: FIND_ACCESS_CARD })).toBeDefined()
    await desktop.unmount()
  })

  test('a probe that answers nothing usable offers nothing', { timeoutMs: 30_000 }, async ($, on) => {
    const { probes, probe, clock } = accessWorld(on)
    await begin($, clock)
    probe.answer = ok('pressed\n')
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
    await clock.settle()
    expect(probes).toHaveLength(1)
    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await desktop.press({ key: 'tab:prompts' })
    expect(await desktop.find({ key: FIND_ACCESS_CARD })).toBeUndefined()
    await desktop.unmount()
  })
})

describe('a Find refused or pressed', () => {
  test('refused for want of Accessibility: names the app and offers to allow it; pressed: the offer goes', { timeoutMs: 30_000 }, async ($, on) => {
    const { probes, probe, toasts, clock } = accessWorld(on)
    const id = await begin($, clock)
    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await desktop.press({ key: 'tab:prompts' })
    const jump = `pjump:${keyOf(id)}`

    // Not known yet which app: the refusal asks macOS, and the toast names what it answered.
    keystrokes.answer = failed(KEYSTROKES_REFUSED)
    probe.answer = ok(JSON.stringify({ trusted: false, app: '/Applications/Utilities/Terminal.app', name: 'Terminal' }))
    await desktop.press({ key: jump })
    await clock.settle()
    expect(keystrokes.runs).toEqual([findKeystrokes()])
    expect(probes).toEqual([findAccessProbe(false)])
    expect(toasts.at(-1)).toBe(findFallbackText(findSnippet('now add a retry'), 'accessibility', 'Terminal'))
    const offer = (await textsIn(desktop, FIND_ACCESS_CARD)).join('\n')
    expect(offer).toContain('switch on “Terminal”')
    // Not the engine: the card does not call it so.
    expect(offer).toContain('macOS holds that app responsible for the keys.')
    expect(offer).not.toContain('engine')

    // Known now: the next refusal asks nothing more.
    await clock.advance(1_000)
    await desktop.press({ key: jump })
    await clock.settle()
    expect(probes).toHaveLength(1)

    // Refused by Automation: the toast says where; Accessibility's offer is as it was.
    await clock.advance(1_000)
    keystrokes.answer = failed(EVENTS_REFUSED)
    await desktop.press({ key: jump })
    await clock.settle()
    expect(toasts.at(-1)).toBe(findFallbackText(findSnippet('now add a retry'), 'automation', 'Terminal'))

    // Pressed: macOS allows the keys after all, so the offer goes, and nothing is said.
    await clock.advance(1_000)
    keystrokes.answer = ok('pressed\n')
    const said = toasts.length
    await desktop.press({ key: jump })
    await clock.settle()
    expect(toasts).toHaveLength(said)
    expect(await desktop.find({ key: FIND_ACCESS_CARD })).toBeUndefined()
    await desktop.unmount()
  })

  test('refused where macOS cannot name the app: the engine is named, and the offer still shows', { timeoutMs: 30_000 }, async ($, on) => {
    const { toasts, clock } = accessWorld(on)
    const id = await begin($, clock)
    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await desktop.press({ key: 'tab:prompts' })
    keystrokes.answer = failed(ASSISTIVE_REFUSED)
    await desktop.press({ key: `pjump:${keyOf(id)}` })
    await clock.settle()
    expect(toasts.at(-1)).toBe(findFallbackText(findSnippet('now add a retry'), 'accessibility', ENGINE_APP))
    expect((await textsIn(desktop, FIND_ACCESS_CARD)).join('\n')).toContain(`switch on “${ENGINE_APP}”`)
    await desktop.unmount()
  })
})
