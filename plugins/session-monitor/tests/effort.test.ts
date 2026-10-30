import { describe, expect, test } from 'claude-code/testing'

import { EFFORT_LEVELS, effortIndex, effortName, isEffortLevel, levelAt, modelLabel, readEffortPress } from '../hooks/lib/effort'
import { APPLY_SETTINGS_KEY, effortButtonKey, EFFORT_SLIDER_KEY, MODEL_PICKER_KEY, OVERVIEW_CARDS } from '../hooks/view/overview'
import { SLIDER_ACCENT } from '../hooks/view/effort-slider'
import { MODEL_OPTIONS, PANE, settingsWorld, start, textsIn, world } from './world'

describe('the effort levels', () => {
  test('from faster to smarter, xhigh called Extra; a value that is no level is kept as it is', () => {
    expect([...EFFORT_LEVELS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(EFFORT_LEVELS.map(effortName)).toEqual(['Low', 'Medium', 'High', 'Extra', 'Max'])
    expect(effortName('turbo')).toBe('turbo')
    expect([effortIndex('high'), effortIndex(''), isEffortLevel('max'), isEffortLevel(3)]).toEqual([2, -1, true, false])
  })

  test('a pointer picks the stretch of the track under it; past either end, that end', () => {
    expect([0, 19, 20, 39, 40, 99, -5, 400].map(x => levelAt(x, 100))).toEqual(['low', 'low', 'medium', 'medium', 'high', 'max', 'low', 'max'])
    expect(levelAt(30, 0)).toBe('low')
  })

  test("the slider's press is read back only when it is one", () => {
    expect(readEffortPress({ kind: 'effort', level: 'xhigh' })).toBe('xhigh')
    expect(readEffortPress({ kind: 'effort', level: 'huge' })).toBeUndefined()
    expect(readEffortPress({ kind: 'prompt', id: 'x' })).toBeUndefined()
  })

  test('the model choices read as names', () => {
    expect(MODEL_OPTIONS.map(modelLabel)).toEqual(['Default', 'Sonnet', 'Opus', 'Haiku', 'Fable', 'Opus (1M context)'])
    expect(modelLabel('opusplan')).toBe('Opus plan mode')
  })
})

describe("Overview's model and effort controls", () => {
  test('the model picker lists the /config Model row and sets it; the slider runs /effort and shows the level set until a request uses it', { timeoutMs: 30_000 }, async ($, on) => {
    const clock = world(on)
    await start($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    // The card leads Overview: the model as the row has it, the effort the latest request used.
    const picker = await ui.find({ key: MODEL_PICKER_KEY })
    expect(picker?.props.value).toBe('opus')
    expect(picker?.props.options).toEqual(MODEL_OPTIONS.map(value => ({ value, label: modelLabel(value) })))
    expect((await textsIn(ui, OVERVIEW_CARDS.controls)).join('\n')).toContain('Extra')
    expect(await ui.find({ type: 'Client', key: EFFORT_SLIDER_KEY })).toBeDefined()
    // The slider: Faster to Smarter, each level named under its stop, the knob's in the accent.
    const names = (await ui.findAll({ in: EFFORT_SLIDER_KEY, type: 'Text' })).map(text => text.text)
    expect(names).toEqual(expect.arrayContaining(['Faster', 'Smarter', 'Low', 'Medium', 'High', 'Extra', 'Max']))
    expect((await ui.findAll({ in: EFFORT_SLIDER_KEY, type: 'Text' })).find(text => text.text === 'Extra')?.props).toMatchObject({ color: SLIDER_ACCENT, bold: true })
    // Nothing to apply yet.
    expect((await ui.find({ key: APPLY_SETTINGS_KEY }))?.props.label).toBe('Applied')
    // A model picked, and the slider pressed at its start: shown, but nothing changes before Apply.
    await ui.select({ key: MODEL_PICKER_KEY, value: 'sonnet' })
    await ui.pointer({ type: 'down', x: 0, y: 1, button: 'left', in: EFFORT_SLIDER_KEY })
    await ui.pointer({ type: 'up', x: 0, y: 1, button: 'left', in: EFFORT_SLIDER_KEY })
    await clock.settle()
    expect((await ui.find({ key: MODEL_PICKER_KEY }))?.props.value).toBe('sonnet')
    expect([settingsWorld.sets, settingsWorld.efforts]).toEqual([[], []])
    expect((await ui.find({ key: APPLY_SETTINGS_KEY }))?.props).toMatchObject({ label: 'Apply', variant: 'primary' })
    // Apply: /model, then /effort; the level shown as set until a request uses it.
    await ui.press({ key: APPLY_SETTINGS_KEY })
    await clock.settle()
    expect(settingsWorld.sets).toEqual(['sonnet'])
    expect(settingsWorld.efforts).toEqual(['low'])
    expect((await ui.find({ key: MODEL_PICKER_KEY }))?.props.value).toBe('sonnet')
    const card = (await textsIn(ui, OVERVIEW_CARDS.controls)).join('\n')
    expect(card).toContain('Low')
    expect(card).toContain('applies from the next request')
    await clock.advance(1_000)
    await ui.unmount()
  })

  test('where no slider is drawn, a button per level sets it; a locked model is said, not offered', { timeoutMs: 30_000 }, async ($, on) => {
    const clock = world(on)
    settingsWorld.isLocked = true
    await start($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
    expect(await ui.find({ key: MODEL_PICKER_KEY })).toBeUndefined()
    expect((await textsIn(ui, OVERVIEW_CARDS.controls)).join('\n')).toContain('set by your organization')
    expect((await ui.find({ key: effortButtonKey('xhigh') }))?.props.variant).toBe('primary')
    await ui.press({ key: effortButtonKey('high') })
    await clock.settle()
    expect(settingsWorld.efforts).toEqual([])
    await ui.press({ key: APPLY_SETTINGS_KEY })
    await clock.settle()
    expect(settingsWorld.efforts).toEqual(['high'])
    expect((await ui.find({ key: effortButtonKey('high') }))?.props.variant).toBe('primary')
    await clock.advance(1_000)
    await ui.unmount()
  })
})
