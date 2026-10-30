// A shell command's outline: the programs it runs, the variables it sets and
// the loops it makes, in the order they come (`cd · python3 fetch.py · W= ·
// for loop · grep · tail`), for a row's second line, where the whole command
// does not fit. Quotes are honoured, so a `python3 -c "…; …"` is one program;
// a heredoc's body is text, not commands. Pure.

/** Words that run what follows them: the program is the word after. */
const PREFIXES: ReadonlySet<string> = new Set(['sudo', 'env', 'time', 'nohup', 'exec', 'command', 'builtin', 'nice', 'caffeinate'])

/** Shell words that open or close a block: left out, the command after them kept. */
const KEYWORDS: ReadonlySet<string> = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'esac', '{', '}', '!', 'in', 'function'])

/** Words that declare variables: their assignments are the variables. */
const DECLARERS: ReadonlySet<string> = new Set(['export', 'local', 'declare', 'readonly', 'typeset'])

/** Interpreters whose script names the work: `python3 fetch.py`, `bash run.sh`. */
const INTERPRETERS: ReadonlySet<string> = new Set(['python', 'python3', 'node', 'bash', 'sh', 'zsh', 'ruby', 'deno', 'bun', 'perl', 'php'])

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/

/** The longest outline drawn, in characters. */
export const OUTLINE_CHARS = 160

/** The command with each heredoc's body left out (its delimiter line too); the line that opens one is kept. */
export const dropHeredocs = (command: string): string => {
  const kept: string[] = []
  let delimiter: string | undefined
  for (const line of command.split('\n')) {
    if (delimiter !== undefined) {
      if (line.trim() === delimiter) {
        delimiter = undefined
      }
      continue
    }
    kept.push(line)
    const opened = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line)
    if (opened !== null && !/<<</.test(line)) {
      delimiter = opened[2]
    }
  }
  return kept.join('\n')
}

/**
 * The command cut into simple commands, each a list of words: split at
 * `;`, `&&`, `||`, `|`, `&`, newlines, parentheses and backquotes outside
 * quotes; a quoted word is one word, its quotes gone. `2>&1` and `&>` stay
 * redirections.
 */
export const simpleCommands = (command: string): string[][] => {
  const commands: string[][] = []
  let words: string[] = []
  let word = ''
  let hasWord = false
  let quote: '"' | "'" | undefined
  const endWord = (): void => {
    if (hasWord) {
      words.push(word)
    }
    word = ''
    hasWord = false
  }
  const endCommand = (): void => {
    endWord()
    if (words.length > 0) {
      commands.push(words)
    }
    words = []
  }
  const text = dropHeredocs(command)
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? ''
    const previous = text[index - 1] ?? ''
    const next = text[index + 1] ?? ''
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined
      } else if (char === '\\' && quote === '"' && next !== '') {
        word += next
        index += 1
      } else {
        word += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      hasWord = true
    } else if (char === '\\' && next !== '') {
      // A line continued: the next line is the same command.
      if (next !== '\n') {
        word += next
        hasWord = true
      }
      index += 1
    } else if (char === ' ' || char === '\t') {
      endWord()
    } else if (char === '&' && (previous === '>' || previous === '<' || next === '>')) {
      word += char
      hasWord = true
    } else if (char === ';' || char === '&' || char === '|' || char === '\n' || char === '(' || char === ')' || char === '`') {
      endCommand()
    } else if (char === '$' && next === '(' && text[index + 2] === '(') {
      // Arithmetic, `$((n + 1))`: a value, not a command.
      const close = text.indexOf('))', index + 3)
      word += close < 0 ? text.slice(index) : text.slice(index, close + 2)
      hasWord = true
      index = close < 0 ? text.length : close + 1
    } else if (char === '$' && next === '(') {
      endCommand()
      index += 1
    } else {
      word += char
      hasWord = true
    }
  }
  endCommand()
  return commands
}

const baseName = (path: string): string => path.split('/').filter(part => part !== '').pop() ?? path

/** What one simple command adds to the outline: its loop, its variables, then its program. */
const partsOf = (words: readonly string[]): string[] => {
  const parts: string[] = []
  let rest = [...words]
  // Block words go, and a `for`, `while`, `until` or `select` is a loop: a for's list is not a program.
  while (rest.length > 0) {
    const first = rest[0] ?? ''
    if (first === 'for' || first === 'select') {
      parts.push(`${first} loop`)
      return parts
    }
    if (first === 'while' || first === 'until') {
      parts.push(`${first} loop`)
      rest = rest.slice(1)
    } else if (first === 'case') {
      parts.push('case')
      return parts
    } else if (KEYWORDS.has(first)) {
      rest = rest.slice(1)
    } else {
      break
    }
  }
  // Assignments before the program, or after a declarer, are the variables it sets.
  const isDeclared = rest.length > 0 && DECLARERS.has(rest[0] ?? '')
  if (isDeclared) {
    rest = rest.slice(1)
  }
  while (rest.length > 0 && ASSIGNMENT.test(rest[0] ?? '')) {
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest[0] ?? '')?.[0] ?? ''
    parts.push(`${name}=`)
    rest = rest.slice(1)
  }
  if (isDeclared) {
    return parts
  }
  while (rest.length > 0 && (PREFIXES.has(rest[0] ?? '') || /^[0-9]*[<>]/.test(rest[0] ?? ''))) {
    // A redirection alone (`< in.txt`, `2> err`) takes its file with it.
    rest = rest.slice(/^[0-9]*[<>]+&?$/.test(rest[0] ?? '') ? 2 : 1)
    // A prefix's own flags (`env -i`, `nice -n 5`) are not the program.
    while (rest.length > 0 && (rest[0] ?? '').startsWith('-')) {
      rest = rest.slice(1)
    }
  }
  const program = rest[0]
  if (program === undefined || program === '' || program.startsWith('-')) {
    return parts
  }
  const name = baseName(program)
  if (INTERPRETERS.has(name)) {
    const args = rest.slice(1)
    const flag = args.find(arg => arg === '-c' || arg === '-m' || arg === '-e')
    const script = args.find(arg => !arg.startsWith('-') && /\.[A-Za-z0-9]+$/.test(arg))
    parts.push(flag === '-m' ? `${name} -m ${args[args.indexOf('-m') + 1] ?? ''}`.trim() : flag !== undefined ? `${name} ${flag}` : script !== undefined ? `${name} ${baseName(script)}` : name)
  } else {
    parts.push(name)
  }
  return parts
}

/** What a part of an outline is: a program it runs, a variable it sets, or a loop (or case) it makes. */
export type OutlineKind = 'program' | 'variable' | 'loop'

/** One part of an outline: its text and what it is. */
export type OutlinePart = { text: string; kind: OutlineKind }

const kindOf = (part: string): OutlineKind => (part.endsWith('=') ? 'variable' : part.endsWith(' loop') || part === 'case' ? 'loop' : 'program')

/**
 * A shell command's outline as parts: its programs, variables and loops,
 * each once, in the order they come; as many as fit OUTLINE_CHARS joined.
 */
export const outlineParts = (command: string): OutlinePart[] => {
  const seen: string[] = []
  for (const words of simpleCommands(command)) {
    for (const part of partsOf(words)) {
      if (!seen.includes(part)) {
        seen.push(part)
      }
    }
  }
  const kept: OutlinePart[] = []
  let chars = 0
  for (const text of seen) {
    chars += (kept.length > 0 ? 3 : 0) + text.length
    if (chars > OUTLINE_CHARS) {
      break
    }
    kept.push({ text, kind: kindOf(text) })
  }
  return kept
}

/**
 * A shell command's outline: its parts joined with ` · `, an ellipsis where
 * more did not fit; '' for a command with none (an empty one).
 */
export const commandOutline = (command: string): string => {
  const parts = outlineParts(command)
  const all = new Set(simpleCommands(command).flatMap(words => partsOf(words))).size
  return `${parts.map(part => part.text).join(' · ')}${parts.length < all ? ' · …' : ''}`
}
