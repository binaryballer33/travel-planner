import { describe, expect, test } from 'claude-code/testing'

import type { CommitInfo, FileChange } from '../types'
import {
  cleanDiff,
  diffArgv,
  LOG_FORMAT,
  parseLog,
  parseNumstatZ,
  parseStatus,
  sessionChanges,
  summarize,
  truncateDiff,
  WORKTREE,
} from '../hooks/lib/git'

const STATUS = [
  '# branch.oid 1111111111111111111111111111111111111111',
  '# branch.head feature/x',
  '# branch.upstream origin/feature/x',
  '# branch.ab +2 -1',
  '1 .M N... 100644 100644 100644 aaa bbb src/app.py',
  '1 A. N... 000000 100644 100644 000 ccc src/new file.py',
  '1 .D N... 100644 100644 000000 ddd ddd old.txt',
  '2 R. N... 100644 100644 100644 eee eee R100 docs/new.md',
  'docs/old.md',
  'u UU N... 100644 100644 100644 100644 f1 f2 f3 conflict.py',
  '? scratch.txt',
  '',
].join('\0')

describe('parseStatus', () => {
  test('reads the branch header and every kind of entry', () => {
    const status = parseStatus(STATUS)
    expect(status.head).toBe('1111111111111111111111111111111111111111')
    expect(status.branch).toBe('feature/x')
    expect(status.upstream).toBe('origin/feature/x')
    expect([status.ahead, status.behind]).toEqual([2, 1])
    expect(status.entries.map(entry => [entry.status, entry.path, entry.oldPath ?? '', entry.isUntracked])).toEqual([
      ['M', 'src/app.py', '', false],
      ['A', 'src/new file.py', '', false],
      ['D', 'old.txt', '', false],
      ['R', 'docs/new.md', 'docs/old.md', false],
      ['U', 'conflict.py', '', false],
      ['A', 'scratch.txt', '', true],
    ])
  })

  test('an unborn branch has no head', () => {
    expect(parseStatus('# branch.oid (initial)\0# branch.head main\0').head).toBe('')
  })
})

describe('parseNumstatZ', () => {
  test('reads plain, renamed and binary entries', () => {
    const stats = parseNumstatZ('3\t1\tsrc/app.py\0' + '0\t0\t\0docs/old.md\0docs/new.md\0' + '-\t-\timg.png\0')
    expect(stats.get('src/app.py')).toEqual({ added: 3, removed: 1, isBinary: false })
    expect(stats.get('docs/new.md')).toEqual({ added: 0, removed: 0, isBinary: false })
    expect(stats.get('img.png')).toEqual({ added: 0, removed: 0, isBinary: true })
  })

  test('reads an untracked file counted against /dev/null', () => {
    const stats = parseNumstatZ('7\t0\t\0/dev/null\0notes.md\0')
    expect([...stats.entries()]).toEqual([['notes.md', { added: 7, removed: 0, isBinary: false }]])
  })
})

const commitText = (fields: string[], lines: string[]): string =>
  `\u001e${fields.join('\u001f')}\u001d\n\n${lines.join('\n')}\n`

describe('parseLog', () => {
  test('pairs raw and numstat lines and flags session commits', () => {
    const text =
      commitText(
        ['abc123', 'abc', 'p1 p2', 'Ada', 'ada@example.com', '1700000100', '1700000100', 'HEAD -> main', 'fix: thing', 'Body line\n\nMore.'],
        [':100644 100644 a b M\tsrc/app.py', ':100644 100644 c d R087\told/name.py\tnew/name.py', ':000000 100644 0 e A\tbin.dat', '4\t2\tsrc/app.py', '1\t1\t{old => new}/name.py', '-\t-\tbin.dat'],
      ) +
      commitText(['def456', 'def', '', 'Bo', 'bo@example.com', '1600000000', '1600000000', '', 'init', ''], [':000000 100644 0 f A\tREADME.md', '10\t0\tREADME.md'])
    const commits = parseLog(text, 1_700_000_000_000)
    expect(commits).toHaveLength(2)
    const [first, second] = commits
    expect(first?.subject).toBe('fix: thing')
    expect(first?.body).toBe('Body line\n\nMore.')
    expect(first?.parents).toEqual(['p1', 'p2'])
    expect(first?.isSession).toBe(true)
    expect(first?.date).toBe(1_700_000_100_000)
    expect(first?.files).toEqual([
      { status: 'M', path: 'src/app.py', added: 4, removed: 2, isBinary: false, isUntracked: false },
      { status: 'R', oldPath: 'old/name.py', path: 'new/name.py', added: 1, removed: 1, isBinary: false, isUntracked: false },
      { status: 'A', path: 'bin.dat', added: 0, removed: 0, isBinary: true, isUntracked: false },
    ])
    expect(second?.isSession).toBe(false)
    expect(second?.parents).toEqual([])
  })

  test('the format asks for every field the parser reads', () => {
    expect(LOG_FORMAT.split('\u001f')).toHaveLength(10)
  })
})

const DIFF = [
  'diff --git a/x.py b/x.py',
  'index 111..222 100644',
  '--- a/x.py',
  '+++ b/x.py',
  '@@ -1,3 +1,3 @@ def f():',
  ' a',
  '-b',
  '+B',
  ' c',
  '@@ -10,2 +10,3 @@',
  ' j',
  '+k',
  ' l',
  '',
].join('\n')

describe('diffs', () => {
  test('cleanDiff keeps hunks and the meaningful header lines', () => {
    const clean = cleanDiff(['diff --git a/n b/n', 'new file mode 100644', 'index 0..1', '--- /dev/null', '+++ b/n', '@@ -0,0 +1 @@', '+x', ''].join('\n'))
    expect(clean.header).toEqual(['new file mode 100644'])
    expect(clean.body).toBe('@@ -0,0 +1 @@\n+x')
    expect(clean.isBinary).toBe(false)
    expect(cleanDiff('diff --git a/i b/i\nBinary files a/i and b/i differ\n').isBinary).toBe(true)
  })

  test('truncateDiff leaves short diffs alone', () => {
    const body = cleanDiff(DIFF).body
    expect(truncateDiff(body, 10_000)).toEqual({ text: body, isTruncated: false, hiddenLines: 0 })
  })

  test('truncateDiff re-counts a cut hunk so it still parses', () => {
    const body = cleanDiff(DIFF).body
    const cut = truncateDiff(body, 32)
    expect(cut.isTruncated).toBe(true)
    expect(cut.text).toBe('@@ -1,2 +1,1 @@ def f():\n a\n-b')
    expect(cut.hiddenLines).toBe(6)
  })

  test('truncateDiff never ends on a bare hunk header', () => {
    const body = cleanDiff(DIFF).body
    const cut = truncateDiff(body, 56)
    expect(cut.text).toBe('@@ -1,3 +1,3 @@ def f():\n a\n-b\n+B\n c')
    expect(cut.hiddenLines).toBe(4)
  })

  test('diffArgv asks git for the right comparison', () => {
    const base = { path: 'a.py', isUntracked: false, hasHead: true, mode: 'hunks' as const }
    expect(diffArgv({ ...base, commitKey: WORKTREE })).toEqual(['git', '-c', 'core.quotePath=false', '--no-pager', 'diff', 'HEAD', '-M', '-U3', '--', 'a.py'])
    expect(diffArgv({ ...base, commitKey: WORKTREE, isUntracked: true, mode: 'full' }).slice(4)).toEqual(['diff', '--no-index', '-U100000', '--', '/dev/null', 'a.py'])
    expect(diffArgv({ ...base, commitKey: 'abc', parent: 'p1', oldPath: 'old.py' }).slice(4)).toEqual(['diff', 'p1', 'abc', '-M', '-U3', '--', 'old.py', 'a.py'])
    expect(diffArgv({ ...base, commitKey: 'abc' }).slice(5, 6)).toEqual(['4b825dc642cb6eb9a060e54bf8d69288fbee4904'])
  })
})

const change = (path: string, status: FileChange['status'], added = 1, removed = 0, oldPath?: string): FileChange => ({
  path,
  status,
  added,
  removed,
  isBinary: false,
  isUntracked: false,
  oldPath,
})

const commit = (sha: string, files: FileChange[], isSession = true): CommitInfo => ({
  sha,
  short: sha,
  subject: sha,
  body: '',
  author: 'A',
  email: 'a@x',
  date: 0,
  parents: [],
  refs: '',
  files,
  isSession,
})

describe('session changes', () => {
  test('nets commits oldest first, then the working tree', () => {
    // git log lists newest first.
    const commits = [
      commit('c3', [change('tmp.txt', 'D', 0, 2), change('b.py', 'M', 1, 1)]),
      commit('c2', [change('tmp.txt', 'A', 2), change('b.py', 'M', 3, 0)]),
      commit('c1', [change('a.py', 'A', 5)]),
      commit('old', [change('z.py', 'M')], false),
    ]
    const net = sessionChanges(commits, [change('a.py', 'M', 1, 1), change('c.py', 'D', 0, 4)])
    expect(net.map(one => [one.path, one.status, one.added, one.removed])).toEqual([
      ['a.py', 'A', 6, 1],
      ['b.py', 'M', 4, 1],
      ['c.py', 'D', 0, 4],
    ])
    expect(summarize(net)).toEqual({ added: 1, modified: 1, deleted: 1, renamed: 0, plus: 10, minus: 6 })
  })

  test('follows a rename', () => {
    const net = sessionChanges([commit('c2', [change('new.py', 'R', 0, 0, 'old.py')]), commit('c1', [change('old.py', 'M', 2, 1)])], [])
    expect(net.map(one => [one.path, one.status, one.oldPath])).toEqual([['new.py', 'R', 'old.py']])
  })
})
