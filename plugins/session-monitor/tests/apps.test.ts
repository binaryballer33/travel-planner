import { describe, expect, test } from 'claude-code/testing'

import { appFor, openArgv, openLabel } from '../hooks/lib/apps'

describe('which app opens a file', () => {
  test('code, config, data and text files open in Cursor', () => {
    const names = [
      'main.py',
      'stubs.pyi',
      'analysis.ipynb',
      'package.json',
      'prices.csv',
      'trades.tsv',
      'index.js',
      'server.mjs',
      'app.ts',
      'next-env.d.ts',
      'Page.jsx',
      'Page.tsx',
      'Main.java',
      'build.gradle',
      'go.mod',
      'lib.rs',
      'run.sh',
      'styles.css',
      'README.md',
      'notes.txt',
      'config.yaml',
      'pyproject.toml',
      'query.sql',
      'yarn.lock',
      'Dockerfile',
      'Dockerfile.dev',
      'Makefile',
      'LICENSE',
      '.gitignore',
      '.eslintrc',
      '.env',
      '.env.local',
    ]
    expect(names.filter(name => appFor(`/repo/${name}`)?.app !== 'Cursor')).toEqual([])
  })

  test('web pages open in Chrome, whatever the case of their extension', () => {
    expect(['index.html', 'PAGE.HTM', 'doc.xhtml'].map(name => appFor(`/repo/${name}`)?.app)).toEqual(['Google Chrome', 'Google Chrome', 'Google Chrome'])
  })

  test('anything else opens in the app macOS picks', () => {
    const names = ['logo.png', 'report.pdf', 'archive.zip', 'movie.mov', 'LICENSE.pdf', '.DS_Store', '.hidden.png', 'a-binary', 'icon.svg']
    expect(names.filter(name => appFor(`/repo/${name}`) !== undefined)).toEqual([])
  })

  test('the button names the app; a folder opens in Finder; a reveal selects the entry in Finder', () => {
    expect([openLabel('/repo/app.py'), openLabel('/repo/index.html'), openLabel('/repo/logo.png')]).toEqual(['Open in Cursor', 'Open in Chrome', 'Open in app'])
    expect(openArgv('/repo/app.py', false, false)).toEqual(['open', '-a', 'Cursor', '/repo/app.py'])
    expect(openArgv('/repo/index.html', false, false)).toEqual(['open', '-a', 'Google Chrome', '/repo/index.html'])
    expect(openArgv('/repo/logo.png', false, false)).toEqual(['open', '/repo/logo.png'])
    expect(openArgv('/repo/src.py', false, true)).toEqual(['open', '/repo/src.py'])
    expect(openArgv('/repo/app.py', true, false)).toEqual(['open', '-R', '/repo/app.py'])
  })
})
