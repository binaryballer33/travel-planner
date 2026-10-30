import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_ICON, fileIcon } from '../hooks/lib/icons'
import { textCells } from '../hooks/view/row'
import { commitKey, fileKey } from '../hooks/view/commits'
import { touchedKey } from '../hooks/view/files'
import { clickRow, PANE, SHA, start, world, type FindsAll } from './world'

describe('a file icon by its type', () => {
  test('by its extension, whatever its case and folder', () => {
    expect(fileIcon('/repo/apps/api/src/api/main.py')).toEqual({ glyph: 'py', color: '#4b8bbe' })
    expect(fileIcon('e2e/dock.spec.ts').glyph).toBe('TS')
    expect(fileIcon('openapi.JSON').glyph).toBe('{}')
    expect(fileIcon('check-image.sh')).toEqual({ glyph: '$ ', color: '#89e051' })
    expect(fileIcon('trades.csv').glyph).toBe('▦ ')
    expect(fileIcon('README.md').glyph).toBe('M↓')
  })

  test('by its whole name first: Dockerfiles, git files, lock files, env files', () => {
    expect(fileIcon('apps/api/Dockerfile').glyph).toBe('🐳')
    expect(fileIcon('Dockerfile.dockerignore').glyph).toBe('🐳')
    expect(fileIcon('.gitignore').glyph).toBe('◆ ')
    expect(fileIcon('uv.lock').glyph).toBe('🔒')
    expect(fileIcon('package-lock.json').glyph).toBe('🔒')
    expect(fileIcon('.env.local').glyph).toBe('🔑')
  })

  test('the rest, a dotfile or a name with no extension, take the plain file', () => {
    expect(fileIcon('notes.unknownext')).toBe(DEFAULT_ICON)
    expect(fileIcon('.bashrc')).toBe(DEFAULT_ICON)
    expect(fileIcon('CHANGES')).toBe(DEFAULT_ICON)
  })

  test('every glyph takes two cells, so the names after them line up', () => {
    const paths = ['a.py', 'a.ts', 'a.tsx', 'a.json', 'a.sh', 'a.md', 'a.yml', 'a.toml', 'a.css', 'a.c', 'a.csv', 'a.png', 'a.svg', 'a.pdf', 'a.txt', 'a.zip', 'Dockerfile', '.gitignore', 'LICENSE', '.env', 'x.lock', 'x.unknownext']
    for (const path of paths) {
      expect([path, textCells(fileIcon(path).glyph)]).toEqual([path, 2])
    }
  })
})

/** The colour of the text in a row that reads exactly `text`. */
const colorIn = async (ui: FindsAll, key: string, text: string): Promise<unknown> =>
  (await ui.findAll({ in: key, type: 'Text' })).find(one => one.text === text)?.props?.color

describe('file rows show their icon', () => {
  test('Files and Commits draw each file with its type icon before its name', { timeoutMs: 30_000 }, async ($, on) => {
    const clock = world(on)
    await start($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab:files' })
    expect(await colorIn(ui, touchedKey('/repo/src/app.py'), 'py')).toBe('#4b8bbe')
    expect(await colorIn(ui, touchedKey('/outside/notes.md'), 'M↓')).toBe('#519aba')
    await ui.press({ key: 'tab:commits' })
    await clickRow(ui, commitKey(SHA))
    await clock.settle()
    expect(await colorIn(ui, fileKey(SHA, 'src/app.py'), 'py')).toBe('#4b8bbe')
    await clock.advance(1_000)
    await ui.unmount()
  })
})
