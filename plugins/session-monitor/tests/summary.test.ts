import { describe, expect, test } from 'claude-code/testing'

import type { CommandRecord } from '../types'
import { startRecord } from '../hooks/lib/commands'
import { actorOf, describeCommand, summarizeCall } from '../hooks/lib/summary'
import { actorText } from '../hooks/view/commands'

describe('summaries of shell commands', () => {
  const cases: readonly [string, string][] = [
    ['git status --short', 'Shows the git status'],
    ['git -c core.quotePath=false --no-pager log -n 5', 'Shows the git history'],
    ['cd src && git commit -m "fix"', 'Commits changes in git'],
    ['ls -la tests', 'Lists files in tests'],
    ['cat hooks/register.tsx', 'Shows register.tsx'],
    ['rg "TODO" src', 'Searches files for “TODO”'],
    ['.venv/bin/python -m pytest -m "not data"', 'Runs the tests'],
    ['python3 scripts/backtest.py --year 2024', 'Runs backtest.py'],
    ['python -c "print(1)"', 'Runs a Python snippet'],
    ['npm run build', 'Runs the build script'],
    ['npm install', 'Installs packages'],
    ['pip install requests', 'Installs Python packages'],
    ['curl -sO https://example.com/a.zip', 'Downloads from example.com'],
    ['curl -s https://api.github.com/repos/x', 'Requests api.github.com'],
    ['rm -rf build', 'Deletes build'],
    ['mkdir -p a/b', 'Creates folder b'],
    ['echo hi > out.txt', 'Writes text to a file'],
    ['FOO=1 make test', 'Runs make test'],
    ['ps aux | grep claude', 'Lists running processes (piped)'],
    ['some-tool --flag', 'Runs some-tool'],
  ]
  for (const [command, expected] of cases) {
    test(command, () => {
      expect(describeCommand(command)).toBe(expected)
    })
  }
})

describe('summaries of tool calls', () => {
  test("Bash prefers Claude's own description of the command", () => {
    expect(summarizeCall('Bash', { command: 'ls', description: 'List the files in the repo' })).toBe('List the files in the repo')
    expect(summarizeCall('Bash', { command: 'ls' })).toBe('Lists files')
  })

  test('other tools read from their input', () => {
    expect(summarizeCall('Read', { file_path: '/a/b/settings.py' })).toBe('Reads settings.py')
    expect(summarizeCall('Edit', { file_path: '/a/main.py' })).toBe('Edits main.py')
    expect(summarizeCall('MultiEdit', { file_path: '/a/main.py', edits: [{}, {}, {}] })).toBe('Makes 3 edits to main.py')
    expect(summarizeCall('Write', { file_path: '/x/notes.md' })).toBe('Writes notes.md')
    expect(summarizeCall('Grep', { pattern: 'def run', path: '/repo/src' })).toBe('Searches code for “def run” in src')
    expect(summarizeCall('Glob', { pattern: '**/*.ts' })).toBe('Finds files matching **/*.ts')
    expect(summarizeCall('WebFetch', { url: 'https://www.sec.gov/x', prompt: 'p' })).toBe('Reads a web page on sec.gov')
    expect(summarizeCall('WebSearch', { query: 'spy options iv' })).toBe('Searches the web for “spy options iv”')
    expect(summarizeCall('Agent', { description: 'Diagnose the drawdown', subagent_type: 'Explore' })).toBe('Starts a Explore agent: Diagnose the drawdown')
    expect(summarizeCall('TodoWrite', { todos: [{}, {}] })).toBe('Updates the to-do list (2 items)')
    expect(summarizeCall('mcp__quantconnect__read_backtest', { projectId: 1 })).toBe('Quantconnect: read backtest')
    expect(summarizeCall('mcp__Claude_Browser__navigate', { url: 'https://docs.python.org/3/' })).toBe('Claude browser: navigate docs.python.org')
    expect(summarizeCall('SomeNewTool', {})).toBe('Some new tool')
  })
})

describe('who made a call', () => {
  test('the main loop, a sub-agent or a plugin', () => {
    expect(actorOf('engine', undefined)).toEqual({ kind: 'claude', name: 'Claude' })
    expect(actorOf('engine', 'agent-1')).toEqual({ kind: 'agent', name: '' })
    expect(actorOf('my-plugin', undefined)).toEqual({ kind: 'plugin', name: 'my-plugin' })
  })
})

describe('who ran it, as a row shows it', () => {
  const record = (actor: CommandRecord['actor'], agentId?: string): CommandRecord => ({
    ...startRecord('1', 'Bash', { command: 'ls' }, 0, agentId),
    actor,
  })

  test('Claude, a sub-agent by name or id, or a plugin', () => {
    expect(actorText(record({ kind: 'claude', name: 'Claude' }))).toEqual({ text: 'Claude', tone: 'claude' })
    expect(actorText(record({ kind: 'agent', name: 'Explore: find docs' }, 'agent-123456789'))).toEqual({ text: '⤷ Explore: find docs', tone: 'merged' })
    expect(actorText(record({ kind: 'agent', name: '' }, 'agent-123456789'))).toEqual({ text: '⤷ sub-agent agent-', tone: 'merged' })
    expect(actorText(record({ kind: 'plugin', name: 'my-mod' }))).toEqual({ text: '⚙ my-mod', tone: 'permission' })
  })

  test('a new record carries its summary and who made it', () => {
    const started = startRecord('2', 'Read', { file_path: '/a/b.py' }, 0, 'agent-1')
    expect(started.summary).toBe('Reads b.py')
    expect(started.actor).toEqual({ kind: 'agent', name: '' })
    expect(startRecord('3', 'Bash', { command: 'ls' }, 0, undefined, 'other-plugin').actor).toEqual({ kind: 'plugin', name: 'other-plugin' })
  })
})
