// Read, write or execute: what a tool call does to the machine.
//
// The engine's own verdict wins where it gives one (a tool result's
// `isReadOnly`, the check its permissions use). Otherwise tools are classed by
// name, and a shell command by what its segments run: anything that writes a
// file is a write, anything that runs a program is an execute, the rest reads.

import type { Access } from '../../types'

const READ_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'ToolSearch',
  'BashOutput',
  'TaskOutput',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'ReadMcpResourceDirTool',
])

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'TodoWrite'])

const MCP_READ = /^(get|list|read|search|query|find|fetch|describe|show|check|view|estimate|explain|lookup|status|tabs_context|preview_list|preview_logs)/
const MCP_WRITE = /^(create|update|delete|remove|add|set|write|patch|upload|edit|rename|move|post|send|place|revoke|stop|liquidate|broadcast|import|commit|push|pull|merge|checkout|enable|disable)/

/** Writes anywhere in a command make it a write. */
const WRITE_PATTERNS: readonly RegExp[] = [
  // Redirection into a file: not 2>&1, &>, or /dev/null.
  /(^|[^0-9&>])>{1,2}\s*(?!&|\/dev\/null)[^\s|&;]/,
  /(^|[\s;&|(])tee\s/,
  /(^|[\s;&|(])(rm|rmdir|mv|cp|mkdir|touch|ln|chmod|chown|truncate|dd|install|rsync|unzip|patch|shred)(\s|$)/,
  /(^|[\s;&|(])sed\s+(-[a-zA-Z]*i|--in-place)/,
  /(^|[\s;&|(])perl\s+-[a-zA-Z]*i/,
  /(^|[\s;&|(])git\s+(-c\s+\S+\s+)*(add|commit|checkout|reset|merge|rebase|stash(?!\s+list)|push|pull|clone|restore|switch|rm|mv|apply|cherry-pick|revert|init|am|fetch|worktree)(\s|$)/,
  /(^|[\s;&|(])(npm|pnpm|yarn|bun)\s+(install|i|add|remove|uninstall|ci|update|upgrade)(\s|$)/,
  /(^|[\s;&|(])(pip|pip3|uv|poetry|conda|brew|apt|apt-get|gem|cargo)\s+(pip\s+)?(install|add|remove|uninstall|update|upgrade|sync)(\s|$)/,
  /(^|[\s;&|(])curl\b[^|;&]*?\s(-[a-zA-Z]*[oO][a-zA-Z]*|--output|--remote-name)(\s|$)/,
  /(^|[\s;&|(])wget\s/,
  /(^|[\s;&|(])tar\s+-?[a-zA-Z]*x/,
  /(^|[\s;&|(])find\s[^|;&]*-(delete|exec\s+rm)(\s|$)/,
]

const READ_COMMANDS = new Set([
  'ls', 'cat', 'bat', 'head', 'tail', 'grep', 'rg', 'egrep', 'fgrep', 'ag', 'find', 'fd', 'wc', 'pwd',
  'echo', 'printf', 'which', 'whereis', 'type', 'stat', 'file', 'du', 'df', 'ps', 'top', 'env',
  'printenv', 'sort', 'uniq', 'cut', 'tr', 'jq', 'yq', 'tree', 'less', 'more', 'diff', 'cmp', 'date',
  'whoami', 'hostname', 'uname', 'sw_vers', 'nettop', 'netstat', 'lsof', 'column', 'awk', 'sed',
  'basename', 'dirname', 'realpath', 'readlink', 'true', 'false', 'test', '[', 'sleep', 'md5', 'shasum',
  'xxd', 'od', 'strings', 'otool', 'nm', 'man', 'history', 'id', 'uptime', 'sysctl', 'defaults',
])

/** Words that only set up the shell around a command. */
const NEUTRAL = new Set(['cd', 'export', 'set', 'unset', 'source', '.', 'alias', 'pushd', 'popd', 'local', 'declare'])

const PREFIXES = new Set(['sudo', 'time', 'nice', 'nohup', 'command', 'builtin', 'exec', 'env'])

const READ_GIT = /^(status|log|diff|show|branch|rev-parse|blame|ls-files|ls-tree|remote|describe|shortlog|reflog|grep|cat-file|merge-base|for-each-ref|config|tag|stash list|whatchanged|count-objects|var|help|version|--version)\b/

/** The program a shell segment runs, past assignments and wrappers: `FOO=1 sudo git status` is git. */
const programOf = (segment: string): { name: string; rest: string } => {
  const words = segment.trim().replace(/^[({]+\s*/, '').split(/\s+/)
  let index = 0
  while (index < words.length) {
    const word = words[index] ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || PREFIXES.has(word)) {
      index += 1
      continue
    }
    break
  }
  const raw = words[index] ?? ''
  const name = raw.split('/').pop() ?? raw
  return { name, rest: words.slice(index + 1).join(' ') }
}

const segmentAccess = (segment: string): Access | undefined => {
  const { name, rest } = programOf(segment)
  if (name === '' || NEUTRAL.has(name)) {
    return undefined
  }
  if (name === 'git') {
    const sub = rest.replace(/^(-c\s+\S+\s+|--no-pager\s+|-C\s+\S+\s+)*/, '')
    return READ_GIT.test(sub) ? 'read' : 'execute'
  }
  return READ_COMMANDS.has(name) ? 'read' : 'execute'
}

/** A shell command's access: write if anything writes a file, execute if anything runs a program. */
export const classifyCommand = (command: string): Access => {
  if (WRITE_PATTERNS.some(pattern => pattern.test(command))) {
    return 'write'
  }
  const segments = command.split(/&&|\|\||[;|\n]/)
  const kinds = segments.map(segmentAccess).filter((kind): kind is Access => kind !== undefined)
  return kinds.includes('execute') ? 'execute' : 'read'
}

/** A tool call's access before it runs, from its name and input. */
export const classifyTool = (tool: string, input: Readonly<Record<string, unknown>>): Access => {
  if (tool === 'Bash') {
    const command = input.command
    return typeof command === 'string' ? classifyCommand(command) : 'execute'
  }
  if (READ_TOOLS.has(tool)) {
    return 'read'
  }
  if (WRITE_TOOLS.has(tool)) {
    return 'write'
  }
  if (tool.startsWith('mcp__')) {
    const action = tool.split('__').slice(2).join('__').toLowerCase()
    if (MCP_READ.test(action)) {
      return 'read'
    }
    if (MCP_WRITE.test(action)) {
      return 'write'
    }
  }
  return 'execute'
}

/** The class once the engine has run the call: its read-only verdict overrides a guess of write or execute. */
export const refineAccess = (guess: Access, isReadOnly: boolean): Access => (isReadOnly ? 'read' : guess)
