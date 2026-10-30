// The code view's selectable frames: on the desktop an opened file or diff is
// drawn in interactive Svg frames, sized to the panel, whose code the person
// can select with the mouse and copy; elsewhere it stays as it was.

import { describe, expect, test } from 'claude-code/testing'

import { CHAR_WIDTH, MAX_SVG_PX, type CodeFrame } from '../hooks/lib/codeview'
import { commitKey, fileKey } from '../hooks/view/commits'
import { desktopFitPx, frameSize } from '../hooks/view/diff'
import { touchedKey } from '../hooks/view/files'
import { clickRow, PANE, SHA, shownCode, start, world, type Drawable, type FindsAll } from './world'

/** The code view's Svg elements, as drawn. */
const codeSvgs = async (ui: FindsAll): Promise<{ props: Record<string, unknown>; source: string }[]> =>
  (await ui.findAll({ type: 'Svg' }))
    .map(found => ({ props: found.props, source: String(found.props.source ?? '') }))
    .filter(found => found.source.includes('font-family="ui-monospace'))

/** The size an SVG document gives itself. */
const ownSize = (source: string): { width: number; height: number } => {
  const match = /width="([\d.]+)" height="([\d.]+)"/.exec(source)
  return { width: Number(match?.[1] ?? 0), height: Number(match?.[2] ?? 0) }
}

const frame = (width: number, height: number): CodeFrame => ({ source: '<svg/>', width, height })

type Node = { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value)

const cells = (value: unknown): number => (typeof value === 'number' ? value : 0)

/**
 * What the boxes drawn around the first code frame take from the pane's
 * width: their padding and margins in ch, their borders in px (one a side).
 */
const insetsAround = async (ui: Drawable): Promise<{ ch: number; px: number } | undefined> => {
  const walk = (node: unknown, ch: number, px: number): { ch: number; px: number } | undefined => {
    if (!isNode(node)) {
      return undefined
    }
    const props = node.props ?? {}
    if (node.type === 'Svg' && String(props.source ?? '').includes('font-family="ui-monospace')) {
      return { ch, px }
    }
    const sides =
      (cells(props.padding) + cells(props.paddingX) + cells(props.margin) + cells(props.marginX)) * 2 +
      cells(props.paddingLeft) +
      cells(props.paddingRight) +
      cells(props.marginLeft) +
      cells(props.marginRight)
    const border = node.type === 'Box' && typeof props.borderStyle === 'string' ? 2 : 0
    for (const child of node.children ?? []) {
      const found = walk(child, ch + sides, px + border)
      if (found !== undefined) {
        return found
      }
    }
    return undefined
  }
  return walk(await ui.drawn(), 0, 0)
}

describe('sizing a frame on the desktop', () => {
  test('the room is the pane less the boxes around the code, more of it on Commits', () => {
    // 120 cells of 7.2 px, less the pane's, the list card's and the file card's 12 ch of padding, their borders and a little spare.
    expect(desktopFitPx(120, 'files')).toBeLessThan(120 * 7.2 - 12 * 7.85 - 4)
    expect(desktopFitPx(120, 'files')).toBeGreaterThan(120 * 7.2 - 12 * 7.85 - 4 - 10)
    // On Commits the commit's card sits between them: set in 2 ch, padded 2 ch a side, with its border.
    expect(desktopFitPx(120, 'commits')).toBeLessThan(desktopFitPx(120, 'files') - 6 * 7.85)
    expect(desktopFitPx(120, 'commits')).toBeGreaterThan(desktopFitPx(120, 'files') - 6 * 7.85 - 4)
    // A pane too narrow for anything still gets a frame of some width.
    expect(desktopFitPx(5, 'files')).toBe(160)
  })

  test('a frame that fits keeps its size; a wider one shrinks to the room with its shape kept', () => {
    expect(frameSize(frame(600, 400), 800)).toEqual({ width: 600, height: 400 })
    expect(frameSize(frame(800, 4_000), 400)).toEqual({ width: 400, height: 2_000 })
    expect(frameSize(frame(704.7, 256), 690.13)).toEqual({ width: 690.13, height: 250.71 })
    const sized = frameSize(frame(3_000, 4_096), 2_999)
    expect(sized.height).toBeLessThanOrEqual(MAX_SVG_PX)
  })
})

describe('the desktop draws the code in selectable frames', () => {
  test('files: a diff and a file are frames, sized to the panel, their marks unselectable', { timeoutMs: 20_000 }, async ($, on) => {
    const clock = world(on)
    await start($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'tab:files' })
    for (const path of ['/repo/src/app.py', '/outside/notes.md']) {
      await clickRow(ui, touchedKey(path))
      await clock.settle()
      const svgs = await codeSvgs(ui)
      expect(svgs).toHaveLength(1)
      for (const svg of svgs) {
        const own = ownSize(svg.source)
        const width = Number(svg.props.width)
        const height = Number(svg.props.height)
        expect(svg.props.isInteractive).toBe(true)
        expect(width).toBeGreaterThan(0)
        expect(width).toBeLessThanOrEqual(Math.min(own.width, desktopFitPx(PANE.props.bodyColumns, 'files')))
        expect(height).toBeLessThanOrEqual(MAX_SVG_PX)
        // The frame has the drawing's shape, so the drawing fills it: no band above or below.
        expect(Math.abs(width / height - own.width / own.height)).toBeLessThan(0.01)
        expect(svg.source).toContain('class="n"')
        expect(svg.source).not.toContain(' ')
      }
      expect((await shownCode(ui)).text).toContain(path.endsWith('.py') ? 'new line' : 'first line')
      await ui.press({ key: 'diff:close' })
      await clock.advance(1_000)
    }
  })

  test('commits: the frame leaves room for the commit box around it', { timeoutMs: 20_000 }, async ($, on) => {
    const clock = world(on)
    await start($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'tab:commits' })
    await clickRow(ui, commitKey(SHA))
    await clickRow(ui, fileKey(SHA, 'src/app.py'))
    await clock.settle()
    const svgs = await codeSvgs(ui)
    expect(svgs).toHaveLength(1)
    expect(svgs[0]?.props.isInteractive).toBe(true)
    expect(Number(svgs[0]?.props.width)).toBeLessThanOrEqual(desktopFitPx(PANE.props.bodyColumns, 'commits'))
    expect((await shownCode(ui)).text).toContain('old line')
  })

  test('the room each tab sizes frames to is what the cards around the code leave, with a few px to spare', { timeoutMs: 20_000 }, async ($, on) => {
    const clock = world(on)
    await start($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const width = PANE.props.bodyColumns * 7.2
    // Files: the pane, the list's card and the open file's card.
    await ui.press({ key: 'tab:files' })
    await clickRow(ui, touchedKey('/repo/src/app.py'))
    await clock.settle()
    const files = await insetsAround(ui)
    expect(files).toEqual({ ch: 12, px: 4 })
    const filesSpare = width - (files?.ch ?? 0) * 7.85 - (files?.px ?? 0) - desktopFitPx(PANE.props.bodyColumns, 'files')
    expect(filesSpare).toBeGreaterThan(0)
    expect(filesSpare).toBeLessThan(8)
    await ui.press({ key: 'diff:close' })
    await clock.advance(1_000)
    // Commits: the commit's card too, set in under its row.
    await ui.press({ key: 'tab:commits' })
    await clickRow(ui, commitKey(SHA))
    await clickRow(ui, fileKey(SHA, 'src/app.py'))
    await clock.settle()
    const commits = await insetsAround(ui)
    expect(commits).toEqual({ ch: 18, px: 6 })
    const commitsSpare = width - (commits?.ch ?? 0) * 7.85 - (commits?.px ?? 0) - desktopFitPx(PANE.props.bodyColumns, 'commits')
    expect(commitsSpare).toBeGreaterThan(0)
    expect(commitsSpare).toBeLessThan(8)
  })

  test('a frame is drawn as wide as its room, so the code keeps its size inside the cards', { timeoutMs: 20_000 }, async ($, on) => {
    const clock = world(on)
    await start($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    for (const tab of ['files', 'commits'] as const) {
      await ui.press({ key: `tab:${tab}` })
      if (tab === 'files') {
        await clickRow(ui, touchedKey('/repo/src/app.py'))
      } else {
        await clickRow(ui, commitKey(SHA))
        await clickRow(ui, fileKey(SHA, 'src/app.py'))
      }
      await clock.settle()
      const [svg] = await codeSvgs(ui)
      const own = ownSize(svg?.source ?? '')
      const fit = desktopFitPx(PANE.props.bodyColumns, tab)
      // Its own width is the room rounded up to a whole character, so it fills the room shrunk by under one character.
      expect(own.width).toBeGreaterThanOrEqual(fit)
      expect(own.width).toBeLessThan(fit + CHAR_WIDTH)
      expect(Math.abs(Number(svg?.props.width) - fit)).toBeLessThan(0.01)
      await ui.press({ key: 'diff:close' })
      await clock.advance(1_000)
    }
  })

  test('in VS Code and the mobile app the view is the image it was', { timeoutMs: 20_000 }, async ($, on) => {
    const clock = world(on)
    await start($, clock)
    for (const surface of ['vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'tab:files' })
      // No Client is drawn there: a row's title is a button.
      await ui.press({ key: touchedKey('/repo/src/app.py') })
      await clock.settle()
      const svgs = await codeSvgs(ui)
      expect(svgs).toHaveLength(1)
      expect(svgs[0]?.props.isInteractive).toBeUndefined()
      expect(svgs[0]?.props.width).toBeUndefined()
      expect(svgs[0]?.source).toContain('\u00a0')
      expect(svgs[0]?.source).not.toContain('class="n"')
      expect((await shownCode(ui)).text).toContain('new line')
      await ui.press({ key: 'diff:close' })
      await clock.advance(1_000)
    }
  })

  test('the terminal keeps the engine diff view of its own', { timeoutMs: 20_000 }, async ($, on) => {
    const clock = world(on)
    await start($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:files' })
    await clickRow(ui, touchedKey('/repo/src/app.py'))
    await clock.settle()
    const shown = await shownCode(ui)
    expect(shown.kind).toBe('code')
    expect(shown.format).toBe('diff')
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  })
})
