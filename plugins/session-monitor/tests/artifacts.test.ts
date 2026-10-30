import { describe, expect, test } from 'claude-code/testing'

import { extractArtifacts, mergeArtifacts } from '../hooks/lib/artifacts'

const T0 = 1_760_000_000_000
const URL = 'https://claude.ai/code/artifact/0b8c1a2e-1111-2222-3333-444455556666'

describe('artifacts', () => {
  test('a publish gives its page with title, path and version', () => {
    const [page] = extractArtifacts('Artifact', { file_path: '/s/report.html' }, { url: URL, version: '3', title: 'Trade report' }, '', T0)
    expect(page).toEqual({ id: URL, kind: 'page', title: 'Trade report', url: URL, path: '/s/report.html', version: '3', count: 1, firstAt: T0, lastAt: T0 })
  })

  test('the URL is read from the text when the result carries none; reads and lists give nothing', () => {
    expect(extractArtifacts('Artifact', { file_path: '/s/x.html' }, undefined, `Published to ${URL}.`, T0)[0]?.title).toBe('x.html')
    expect(extractArtifacts('Artifact', { action: 'read', url: URL }, { url: URL }, '', T0)).toEqual([])
    expect(extractArtifacts('Artifact', { action: 'list' }, {}, '', T0)).toEqual([])
    expect(extractArtifacts('Read', { file_path: '/a' }, {}, '', T0)).toEqual([])
  })

  test('sent files are listed one by one with the caption', () => {
    const sent = extractArtifacts('SendUserFile', { files: ['/s/chart.png', '/s/data.csv'], caption: 'The run', status: 'normal' }, {}, '', T0)
    expect(sent.map(one => [one.id, one.kind, one.title, one.caption])).toEqual([
      ['file:/s/chart.png', 'file', 'chart.png', 'The run'],
      ['file:/s/data.csv', 'file', 'data.csv', 'The run'],
    ])
  })

  test('publishing again counts the new version and keeps the first time, newest first', () => {
    const first = extractArtifacts('Artifact', { file_path: '/s/r.html' }, { url: URL, version: '1', title: 'R' }, '', T0)
    const second = extractArtifacts('Artifact', { file_path: '/s/r.html' }, { url: URL, version: '2' }, '', T0 + 50)
    const file = extractArtifacts('SendUserFile', { files: ['/s/a.png'], status: 'normal' }, {}, '', T0 + 10)
    const list = mergeArtifacts(mergeArtifacts(mergeArtifacts([], first), file), second)
    expect(list.map(one => one.id)).toEqual([URL, 'file:/s/a.png'])
    expect(list[0]).toMatchObject({ version: '2', count: 2, firstAt: T0, lastAt: T0 + 50, title: 'r.html' })
  })
})
