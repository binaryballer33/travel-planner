// What a tool call does, in a few plain words, and who made it.
//
// A Bash call usually carries Claude's own description of the command; where
// it does not, and for every other tool, the summary is built from the tool
// and its input: "Reads settings.py", "Searches the web for “spy iv”".

import type { CommandActor } from '../../types'
import { oneLine } from './format'

type Input = Readonly<Record<string, unknown>>

const MAX = 120

const text = (input: Input, key: string): string | undefined => {
  const value = input[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

const base = (path: string): string => path.replace(/\/+$/, '').split('/').pop() ?? path

const host = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

const quoted = (value: string, max = 60): string => `“${oneLine(value, max)}”`

const words = (identifier: string): string => identifier.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim()

const capital = (value: string): string => (value === '' ? value : value.charAt(0).toUpperCase() + value.slice(1))

const GIT: Readonly<Record<string, string>> = {
  status: 'Shows the git status',
  log: 'Shows the git history',
  diff: 'Shows a git diff',
  show: 'Shows a git commit',
  add: 'Stages changes in git',
  commit: 'Commits changes in git',
  push: 'Pushes commits to the remote',
  pull: 'Pulls commits from the remote',
  fetch: 'Fetches from the remote',
  checkout: 'Switches git branch or files',
  switch: 'Switches git branch',
  branch: 'Lists or changes git branches',
  merge: 'Merges git branches',
  rebase: 'Rebases git commits',
  stash: 'Stashes git changes',
  reset: 'Resets git state',
  restore: 'Restores files from git',
  clone: 'Clones a git repository',
  worktree: 'Manages git worktrees',
  blame: 'Shows who changed each line',
  'rev-parse': 'Reads git refs',
  remote: 'Shows git remotes',
  tag: 'Lists or creates git tags',
}

/** The program a shell segment runs, past assignments, `cd`, wrappers and paths. */
const programOf = (segment: string): { name: string; args: string[] } => {
  const tokens = segment.trim().split(/\s+/).filter(token => token !== '')
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index] ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || ['sudo', 'time', 'nice', 'nohup', 'command', 'exec', 'env'].includes(token)) {
      index += 1
      continue
    }
    break
  }
  const raw = tokens[index] ?? ''
  return { name: raw.split('/').pop() ?? raw, args: tokens.slice(index + 1) }
}

const firstSegment = (command: string): string => {
  const segments = command.split(/&&|\|\||;|\n/).map(segment => segment.trim())
  return segments.find(segment => !/^(cd|export|source|\.|set|pushd)\b/.test(segment) && segment !== '') ?? segments[0] ?? ''
}

/** The first argument that is not a flag, its shell quotes removed. */
const firstArg = (args: readonly string[]): string | undefined => {
  const arg = args.find(one => !one.startsWith('-'))
  return arg === undefined ? undefined : arg.replace(/^(['"])(.*)\1$/, '$2')
}

const URL_IN = /https?:\/\/[^\s'"`<>()]+/

/** A guess at what a shell command does, from the program it runs. */
export const describeCommand = (command: string): string => {
  const segment = firstSegment(command)
  const { name, args } = programOf(segment)
  const arg = firstArg(args)
  const url = URL_IN.exec(command)?.[0]
  const isPiped = /\|(?!\|)/.test(segment)
  let summary: string
  if (name === 'git') {
    const sub = args.filter(one => !one.startsWith('-') && !one.includes('=') && one !== 'core.quotePath=false')[0] ?? ''
    summary = GIT[sub] ?? `Runs git ${sub}`.trim()
  } else if (name === 'ls' || name === 'tree') {
    summary = `Lists files${arg !== undefined ? ` in ${base(arg)}` : ''}`
  } else if (['cat', 'head', 'tail', 'less', 'bat'].includes(name)) {
    summary = arg !== undefined ? `Shows ${base(arg)}` : 'Shows file contents'
  } else if (['grep', 'rg', 'egrep', 'ag'].includes(name)) {
    summary = arg !== undefined ? `Searches files for ${quoted(arg, 40)}` : 'Searches files'
  } else if (name === 'find' || name === 'fd') {
    summary = 'Finds files'
  } else if (name === 'wc') {
    summary = 'Counts lines'
  } else if (name === 'pytest' || (name.startsWith('python') && args.includes('pytest'))) {
    summary = 'Runs the tests'
  } else if (name.startsWith('python')) {
    const module = args[args.indexOf('-m') + 1]
    summary = args.includes('-m') && module !== undefined ? `Runs Python module ${module}` : args.includes('-c') ? 'Runs a Python snippet' : `Runs ${arg !== undefined ? base(arg) : 'Python'}`
  } else if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) {
    const sub = arg ?? ''
    summary = ['install', 'i', 'add', 'ci'].includes(sub)
      ? 'Installs packages'
      : sub === 'run'
        ? `Runs the ${args[1] ?? ''} script`.replace('  ', ' ')
        : sub === 'test'
          ? 'Runs the tests'
          : `Runs ${name} ${sub}`.trim()
  } else if (name === 'pip' || name === 'pip3' || name === 'uv') {
    summary = args.includes('install') ? 'Installs Python packages' : `Runs ${name} ${arg ?? ''}`.trim()
  } else if (name === 'curl' || name === 'wget') {
    const isDownload = name === 'wget' || /\s-[a-zA-Z]*[oO]\b|--output|--remote-name/.test(segment)
    summary = `${isDownload ? 'Downloads from' : 'Requests'} ${url !== undefined ? host(url) : 'a URL'}`
  } else if (name === 'mkdir') {
    summary = `Creates folder ${arg !== undefined ? base(arg) : ''}`.trim()
  } else if (name === 'rm' || name === 'rmdir') {
    summary = `Deletes ${arg !== undefined ? base(arg) : 'files'}`
  } else if (name === 'mv') {
    summary = 'Moves or renames files'
  } else if (name === 'cp' || name === 'rsync') {
    summary = 'Copies files'
  } else if (name === 'touch') {
    summary = `Creates ${arg !== undefined ? base(arg) : 'a file'}`
  } else if (name === 'chmod' || name === 'chown') {
    summary = 'Changes file permissions'
  } else if (name === 'sed' && /\s-[a-zA-Z]*i/.test(segment)) {
    summary = 'Edits files in place'
  } else if (name === 'echo' || name === 'printf') {
    summary = /[^>]>[^>&]/.test(segment) ? 'Writes text to a file' : 'Prints text'
  } else if (name === 'make') {
    summary = `Runs make ${arg ?? ''}`.trim()
  } else if (name === 'docker') {
    summary = `Runs docker ${arg ?? ''}`.trim()
  } else if (name === 'tsc') {
    summary = 'Type-checks TypeScript'
  } else if (name === 'claude') {
    summary = `Runs claude ${args.slice(0, 2).join(' ')}`.trim()
  } else if (name === 'ps' || name === 'top') {
    summary = 'Lists running processes'
  } else if (name === 'kill' || name === 'pkill') {
    summary = 'Stops a process'
  } else if (name === 'open') {
    summary = `Opens ${arg !== undefined ? base(arg) : 'a file'}`
  } else if (name === 'sleep') {
    summary = 'Waits'
  } else if (name === '') {
    summary = 'Runs a shell command'
  } else {
    summary = `Runs ${name}`
  }
  return isPiped ? `${summary} (piped)` : summary
}

/** What a tool call does, in one short line. */
export const summarizeCall = (tool: string, input: Input): string => {
  const path = text(input, 'file_path') ?? text(input, 'notebook_path') ?? text(input, 'path')
  switch (tool) {
    case 'Bash':
      return oneLine(text(input, 'description') ?? describeCommand(text(input, 'command') ?? ''), MAX)
    case 'Read':
      return `Reads ${path !== undefined ? base(path) : 'a file'}`
    case 'Write':
      return `Writes ${path !== undefined ? base(path) : 'a file'}`
    case 'Edit':
      return `Edits ${path !== undefined ? base(path) : 'a file'}`
    case 'MultiEdit': {
      const edits = input.edits
      return `Makes ${Array.isArray(edits) ? edits.length : 'several'} edits to ${path !== undefined ? base(path) : 'a file'}`
    }
    case 'NotebookEdit':
      return `Edits notebook ${path !== undefined ? base(path) : ''}`.trim()
    case 'Grep': {
      const pattern = text(input, 'pattern')
      return `Searches code for ${pattern !== undefined ? quoted(pattern, 40) : 'a pattern'}${path !== undefined ? ` in ${base(path)}` : ''}`
    }
    case 'Glob':
      return `Finds files matching ${text(input, 'pattern') ?? 'a pattern'}`
    case 'WebFetch': {
      const url = text(input, 'url')
      return `Reads a web page on ${url !== undefined ? host(url) : 'the web'}`
    }
    case 'WebSearch': {
      const query = text(input, 'query')
      return `Searches the web for ${query !== undefined ? quoted(query) : 'something'}`
    }
    case 'Agent':
    case 'Task': {
      const kind = text(input, 'subagent_type')
      const description = text(input, 'description')
      return oneLine(`Starts ${kind !== undefined ? `a ${kind}` : 'a sub-'} agent${description !== undefined ? `: ${description}` : ''}`, MAX)
    }
    case 'Workflow':
      return oneLine(`Runs a workflow${text(input, 'name') !== undefined ? ` (${text(input, 'name') ?? ''})` : ''}${text(input, 'description') !== undefined ? `: ${text(input, 'description') ?? ''}` : ''}`, MAX)
    case 'TodoWrite': {
      const todos = input.todos
      return `Updates the to-do list${Array.isArray(todos) ? ` (${todos.length} items)` : ''}`
    }
    case 'Skill':
      return `Runs the ${text(input, 'skill') ?? ''} skill`.replace('  ', ' ')
    case 'ToolSearch':
      return 'Loads tool definitions'
    case 'AskUserQuestion':
      return 'Asks you a question'
    case 'BashOutput':
    case 'TaskOutput':
      return 'Reads a background task’s output'
    default:
      break
  }
  if (tool.startsWith('mcp__')) {
    const [server = '', ...rest] = tool.slice(5).split('__')
    const action = words(rest.join(' '))
    const url = text(input, 'url')
    const target = url !== undefined ? ` ${host(url)}` : path !== undefined ? ` ${base(path)}` : ''
    return oneLine(`${capital(words(server))}: ${action}${target}`, MAX)
  }
  return capital(words(tool))
}

/** Who made a tool call: a sub-agent, a plugin, or Claude's main loop. */
export const actorOf = (origin: string, agentId: string | undefined): CommandActor =>
  origin !== 'engine' && origin !== ''
    ? { kind: 'plugin', name: origin }
    : agentId !== undefined
      ? { kind: 'agent', name: '' }
      : { kind: 'claude', name: 'Claude' }
