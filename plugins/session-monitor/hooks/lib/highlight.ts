// A small syntax highlighter for the code view: a line at a time, carrying
// what a line leaves open (a docstring, a block comment, a template string)
// into the next. Not a parser: it colours tokens the way an editor's theme
// does, closely enough to read code by.

export type TokenKind =
  | 'plain'
  | 'keyword'
  | 'control'
  | 'string'
  | 'comment'
  | 'number'
  | 'function'
  | 'type'
  | 'constant'
  | 'decorator'
  | 'variable'
  | 'key'
  | 'heading'

export type Token = { text: string; kind: TokenKind }

export type Lang = 'python' | 'script' | 'json' | 'yaml' | 'toml' | 'shell' | 'markdown' | 'css' | 'plain'

/** What a line left open for the next: inside a triple-quoted string, a block comment or a template string. */
export type LexState = { open?: '"""' | "'''" | '*/' | '`' }

export const START: LexState = {}

const EXTENSIONS: Readonly<Record<string, Lang>> = {
  py: 'python',
  pyi: 'python',
  ts: 'script',
  tsx: 'script',
  js: 'script',
  jsx: 'script',
  mjs: 'script',
  cjs: 'script',
  json: 'json',
  jsonc: 'json',
  ipynb: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  md: 'markdown',
  mdx: 'markdown',
  css: 'css',
  scss: 'css',
}

const NAMES: Readonly<Record<string, Lang>> = {
  Taskfile: 'yaml',
  Dockerfile: 'shell',
  Makefile: 'shell',
  '.gitignore': 'shell',
  '.env': 'shell',
}

/** The language a file's name says, else `plain`. */
export const languageOf = (path: string): Lang => {
  const name = path.split('/').pop() ?? path
  const exact = NAMES[name]
  if (exact !== undefined) {
    return exact
  }
  const dot = name.lastIndexOf('.')
  return dot < 0 ? 'plain' : (EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? 'plain')
}

const words = (list: string): ReadonlySet<string> => new Set(list.split(' '))

const PY_CONTROL = words(
  'if elif else for while try except finally with return yield raise break continue pass import from as in not and or is await async lambda del global nonlocal assert match case',
)
const PY_STORAGE = words('def class')
const PY_CONSTANT = words('True False None self cls')
const PY_TYPES = words('int str float bool list dict tuple set frozenset bytes object type complex range')
const PY_FUNCTIONS = words('print len isinstance super enumerate zip map filter sorted reversed min max sum abs round open getattr setattr hasattr')

const JS_CONTROL = words(
  'if else for while do return break continue switch case default try catch finally throw import export from await yield new delete in of typeof instanceof as satisfies',
)
const JS_STORAGE = words(
  'const let var function class interface type enum extends implements async static readonly public private protected declare keyof abstract get set namespace module',
)
const JS_CONSTANT = words('true false null undefined this super NaN Infinity')
const JS_TYPES = words('string number boolean unknown never any object void bigint symbol')

const SHELL_CONTROL = words('if then else elif fi for while until do done case esac in function return exit export local readonly source')

const IDENT = /^[A-Za-z_$][\w$]*/
const NUMBER = /^(?:0[xXoObB][\da-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[jJnL]?|\.\d[\d_]*)/

/** Adds a token, merged into the last when it is the same kind. */
const push = (tokens: Token[], text: string, kind: TokenKind): void => {
  if (text === '') {
    return
  }
  const last = tokens[tokens.length - 1]
  if (last !== undefined && last.kind === kind) {
    last.text += text
  } else {
    tokens.push({ text, kind })
  }
}

/** Where a quoted string that opened at `start` ends (after its closing quote), or -1 when the line ends first. */
const stringEnd = (line: string, start: number, quote: string): number => {
  let at = start
  while (at < line.length) {
    if (line[at] === '\\') {
      at += 2
      continue
    }
    if (line.startsWith(quote, at)) {
      return at + quote.length
    }
    at += 1
  }
  return -1
}

/** The next non-space character after `at`. */
const nextChar = (line: string, at: number): string => {
  const rest = line.slice(at).trimStart()
  return rest.charAt(0)
}

/** The last word before `at`, ignoring spaces. */
const previousWord = (line: string, at: number): string => /([A-Za-z_$][\w$]*)\s*$/.exec(line.slice(0, at))?.[1] ?? ''

const python = (line: string, state: LexState): { tokens: Token[]; state: LexState } => {
  const tokens: Token[] = []
  let at = 0
  if (state.open === '"""' || state.open === "'''") {
    const end = stringEnd(line, 0, state.open)
    if (end < 0) {
      push(tokens, line, 'string')
      return { tokens, state }
    }
    push(tokens, line.slice(0, end), 'string')
    at = end
  }
  while (at < line.length) {
    const rest = line.slice(at)
    const char = line[at] ?? ''
    if (char === '#') {
      push(tokens, rest, 'comment')
      return { tokens, state: START }
    }
    const prefix = /^[rRbBfFuU]{0,2}(?="""|'''|"|')/.exec(rest)?.[0]
    if (prefix !== undefined) {
      const quoteAt = at + prefix.length
      const triple = line.startsWith('"""', quoteAt) ? '"""' : line.startsWith("'''", quoteAt) ? "'''" : undefined
      const quote = triple ?? line[quoteAt] ?? '"'
      const end = stringEnd(line, quoteAt + quote.length, quote)
      if (end < 0) {
        push(tokens, line.slice(at), 'string')
        return { tokens, state: triple !== undefined ? { open: triple } : START }
      }
      push(tokens, line.slice(at, end), 'string')
      at = end
      continue
    }
    if (char === '@' && line.slice(0, at).trim() === '') {
      const name = /^@[\w.]+/.exec(rest)?.[0] ?? '@'
      push(tokens, name, 'decorator')
      at += name.length
      continue
    }
    const number = NUMBER.exec(rest)?.[0]
    if (number !== undefined && !/[\w$]/.test(line[at - 1] ?? '')) {
      push(tokens, number, 'number')
      at += number.length
      continue
    }
    const word = IDENT.exec(rest)?.[0]
    if (word !== undefined) {
      const before = previousWord(line, at)
      const kind: TokenKind = PY_STORAGE.has(word)
        ? 'keyword'
        : PY_CONTROL.has(word)
          ? 'control'
          : PY_CONSTANT.has(word)
            ? 'constant'
            : before === 'def'
              ? 'function'
              : before === 'class' || PY_TYPES.has(word) || /^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/.test(word)
                ? 'type'
                : nextChar(line, at + word.length) === '(' || PY_FUNCTIONS.has(word)
                  ? 'function'
                  : /^[A-Z][A-Z0-9_]+$/.test(word)
                    ? 'constant'
                    : 'variable'
      push(tokens, word, kind)
      at += word.length
      continue
    }
    push(tokens, char, 'plain')
    at += 1
  }
  return { tokens, state: START }
}

const script = (line: string, state: LexState, isJson: boolean): { tokens: Token[]; state: LexState } => {
  const tokens: Token[] = []
  let at = 0
  if (state.open === '*/' || state.open === '`') {
    const close = state.open
    const end = close === '*/' ? line.indexOf('*/') : stringEnd(line, 0, '`')
    if (end < 0) {
      push(tokens, line, close === '*/' ? 'comment' : 'string')
      return { tokens, state }
    }
    const stop = close === '*/' ? end + 2 : end
    push(tokens, line.slice(0, stop), close === '*/' ? 'comment' : 'string')
    at = stop
  }
  while (at < line.length) {
    const rest = line.slice(at)
    const char = line[at] ?? ''
    if (rest.startsWith('//')) {
      push(tokens, rest, 'comment')
      return { tokens, state: START }
    }
    if (rest.startsWith('/*')) {
      const end = line.indexOf('*/', at + 2)
      if (end < 0) {
        push(tokens, rest, 'comment')
        return { tokens, state: { open: '*/' } }
      }
      push(tokens, line.slice(at, end + 2), 'comment')
      at = end + 2
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      const end = stringEnd(line, at + 1, char)
      if (end < 0) {
        push(tokens, rest, 'string')
        return { tokens, state: char === '`' ? { open: '`' } : START }
      }
      // A JSON key, or an object key in quotes: the string before a colon.
      const kind: TokenKind = isJson && nextChar(line, end) === ':' ? 'key' : 'string'
      push(tokens, line.slice(at, end), kind)
      at = end
      continue
    }
    const number = NUMBER.exec(rest)?.[0]
    if (number !== undefined && !/[\w$]/.test(line[at - 1] ?? '')) {
      push(tokens, number, 'number')
      at += number.length
      continue
    }
    const word = IDENT.exec(rest)?.[0]
    if (word !== undefined) {
      const before = previousWord(line, at)
      const kind: TokenKind = isJson
        ? JS_CONSTANT.has(word)
          ? 'constant'
          : 'plain'
        : JS_STORAGE.has(word) && word !== 'type'
          ? 'keyword'
          : word === 'type' && /^\s+[A-Z]/.test(line.slice(at + 4))
            ? 'keyword'
            : JS_CONTROL.has(word)
              ? 'control'
              : JS_CONSTANT.has(word)
                ? 'constant'
                : before === 'function'
                  ? 'function'
                  : JS_TYPES.has(word) || /^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/.test(word) || before === 'class' || before === 'interface' || before === 'type'
                    ? 'type'
                    : nextChar(line, at + word.length) === '(' || /^\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>/.test(line.slice(at + word.length))
                      ? 'function'
                      : /^[A-Z][A-Z0-9_]+$/.test(word)
                        ? 'constant'
                        : 'variable'
      push(tokens, word, kind)
      at += word.length
      continue
    }
    push(tokens, char, 'plain')
    at += 1
  }
  return { tokens, state: START }
}

/** YAML, TOML and shell: `#` comments, quoted strings, numbers, keys at the line's start. */
const hashed = (line: string, lang: 'yaml' | 'toml' | 'shell'): Token[] => {
  const tokens: Token[] = []
  let at = 0
  const key =
    lang === 'yaml'
      ? /^(\s*-?\s*)([\w.$/-]+(?::[\w.$/-]+)*)(\s*:)(?=\s|$)/.exec(line)
      : lang === 'toml'
        ? /^(\s*)([\w.-]+)(\s*=)/.exec(line)
        : null
  if (lang === 'toml' && /^\s*\[/.test(line)) {
    push(tokens, line, 'type')
    return tokens
  }
  if (key !== null) {
    push(tokens, key[1] ?? '', 'plain')
    push(tokens, key[2] ?? '', 'key')
    push(tokens, key[3] ?? '', 'plain')
    at = key[0].length
  }
  let isCommandStart = lang === 'shell'
  while (at < line.length) {
    const rest = line.slice(at)
    const char = line[at] ?? ''
    if (char === '#' && (at === 0 || /\s/.test(line[at - 1] ?? ''))) {
      push(tokens, rest, 'comment')
      return tokens
    }
    if (char === '"' || char === "'") {
      const end = stringEnd(line, at + 1, char)
      push(tokens, end < 0 ? rest : line.slice(at, end), 'string')
      at = end < 0 ? line.length : end
      isCommandStart = false
      continue
    }
    if (lang === 'shell' && char === '$') {
      const variable = /^\$(?:\{[^}]*\}|[\w@#?*!$-]+)/.exec(rest)?.[0] ?? '$'
      push(tokens, variable, 'variable')
      at += variable.length
      continue
    }
    const number = NUMBER.exec(rest)?.[0]
    if (number !== undefined && !/[\w.-]/.test(line[at - 1] ?? '')) {
      push(tokens, number, 'number')
      at += number.length
      continue
    }
    const word = /^[\w.-]+/.exec(rest)?.[0]
    if (word !== undefined) {
      const kind: TokenKind =
        lang === 'shell'
          ? SHELL_CONTROL.has(word)
            ? 'control'
            : isCommandStart
              ? 'function'
              : 'plain'
          : word === 'true' || word === 'false' || word === 'null' || word === 'yes' || word === 'no'
            ? 'constant'
            : 'string'
      push(tokens, word, kind)
      at += word.length
      isCommandStart = lang === 'shell' && SHELL_CONTROL.has(word)
      continue
    }
    if (lang === 'shell' && (char === '|' || char === ';' || char === '&')) {
      isCommandStart = true
    }
    push(tokens, char, 'plain')
    at += 1
  }
  return tokens
}

const markdown = (line: string): Token[] => {
  if (/^\s{0,3}#{1,6}\s/.test(line)) {
    return [{ text: line, kind: 'heading' }]
  }
  const tokens: Token[] = []
  for (const part of line.split(/(`[^`]*`)/)) {
    push(tokens, part, part.startsWith('`') && part.endsWith('`') && part.length > 1 ? 'string' : 'plain')
  }
  return tokens
}

const css = (line: string): Token[] => {
  const tokens: Token[] = []
  const property = /^(\s*)([\w-]+)(\s*:)/.exec(line)
  if (property !== null) {
    push(tokens, property[1] ?? '', 'plain')
    push(tokens, property[2] ?? '', 'key')
    push(tokens, property[3] ?? '', 'plain')
    push(tokens, line.slice(property[0].length), 'string')
    return tokens
  }
  push(tokens, line, line.trim().startsWith('/*') ? 'comment' : 'type')
  return tokens
}

/** One line's tokens, and what it leaves open for the next. */
export const tokenizeLine = (line: string, lang: Lang, state: LexState = START): { tokens: Token[]; state: LexState } => {
  switch (lang) {
    case 'python':
      return python(line, state)
    case 'script':
      return script(line, state, false)
    case 'json':
      return script(line, state, true)
    case 'yaml':
    case 'toml':
    case 'shell':
      return { tokens: hashed(line, lang), state: START }
    case 'markdown':
      return { tokens: markdown(line), state: START }
    case 'css':
      return { tokens: css(line), state: START }
    case 'plain':
      return { tokens: line === '' ? [] : [{ text: line, kind: 'plain' }], state: START }
  }
}
