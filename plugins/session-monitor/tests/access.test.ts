import { describe, expect, test } from 'claude-code/testing'

import type { Access } from '../types'
import { classifyCommand, classifyTool, refineAccess } from '../hooks/lib/access'

const cases: readonly [string, Access][] = [
  ['ls -la', 'read'],
  ['git status --short', 'read'],
  ['git -c core.quotePath=false --no-pager log -n 5', 'read'],
  ['cat a.txt | grep foo | wc -l', 'read'],
  ['cd src && rg TODO', 'read'],
  ['find . -name "*.py" 2>/dev/null', 'read'],
  ['ps aux > /dev/null 2>&1', 'read'],
  ['echo hi > out.txt', 'write'],
  ['cat <<EOF > notes.md\nhello\nEOF', 'write'],
  ['python run.py >> log.txt', 'write'],
  ['rm -rf build', 'write'],
  ['mkdir -p a/b && cp x a/b/', 'write'],
  ["sed -i '' 's/a/b/' file.py", 'write'],
  ['git commit -m "fix"', 'write'],
  ['git checkout -b feature', 'write'],
  ['npm install', 'write'],
  ['pip install requests', 'write'],
  ['curl -sO https://example.com/a.zip', 'write'],
  ['find . -name "*.pyc" -delete', 'write'],
  ['.venv/bin/python -m pytest -m "not data"', 'execute'],
  ['npm test', 'execute'],
  ['curl -s https://example.com/status', 'execute'],
  ['FOO=1 make build', 'execute'],
  ['git status && ./scripts/deploy.sh', 'execute'],
  ['claude plugin validate .', 'execute'],
]

describe('shell commands', () => {
  for (const [command, expected] of cases) {
    test(`${expected}: ${command.split('\n')[0]}`, () => {
      expect(classifyCommand(command)).toBe(expected)
    })
  }
})

describe('tools', () => {
  test('are classed by name', () => {
    expect(classifyTool('Read', { file_path: 'a' })).toBe('read')
    expect(classifyTool('Grep', { pattern: 'x' })).toBe('read')
    expect(classifyTool('WebFetch', { url: 'https://a.b' })).toBe('read')
    expect(classifyTool('Edit', { file_path: 'a' })).toBe('write')
    expect(classifyTool('Write', { file_path: 'a' })).toBe('write')
    expect(classifyTool('Agent', { prompt: 'x' })).toBe('execute')
    expect(classifyTool('Bash', { command: 'ls' })).toBe('read')
  })

  test('MCP tools are classed by their action verb', () => {
    expect(classifyTool('mcp__quantconnect__read_backtest', {})).toBe('read')
    expect(classifyTool('mcp__github__list_issues', {})).toBe('read')
    expect(classifyTool('mcp__quantconnect__create_backtest', {})).toBe('write')
    expect(classifyTool('mcp__quantconnect__update_file_contents', {})).toBe('write')
    expect(classifyTool('mcp__Claude_Browser__computer', {})).toBe('execute')
  })

  test("the engine's read-only verdict overrides the guess", () => {
    expect(refineAccess('execute', true)).toBe('read')
    expect(refineAccess('write', false)).toBe('write')
  })
})
