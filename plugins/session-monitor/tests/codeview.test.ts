import { describe, expect, test } from 'claude-code/testing'

import {
  CHUNK_CHARS,
  contentRows,
  diffRows,
  highlightRows,
  MAX_SVG_PX,
  MAX_VIEW_CHARS,
  renderCodeView,
  renderSelectableView,
  THEME,
  TOKEN_COLORS,
  wrapTokens,
} from '../hooks/lib/codeview'
import { languageOf, START, tokenizeLine, type Lang, type Token, type TokenKind } from '../hooks/lib/highlight'

/** The kind of each non-blank token, as `text:kind`. */
const kinds = (line: string, lang: Lang): string[] =>
  tokenizeLine(line, lang)
    .tokens.filter(token => token.text.trim() !== '')
    .map(token => `${token.text.trim()}:${token.kind}`)

const kindOf = (tokens: readonly Token[], text: string): TokenKind | undefined => tokens.find(token => token.text.includes(text))?.kind

describe('the highlighter', () => {
  test('knows a language by the file name', () => {
    expect(languageOf('quant_connect/open_range_break/settings.py')).toBe('python')
    expect(languageOf('hooks/register.tsx')).toBe('script')
    expect(languageOf('package.json')).toBe('json')
    expect(languageOf('Taskfile.yml')).toBe('yaml')
    expect(languageOf('pyproject.toml')).toBe('toml')
    expect(languageOf('apps/api/check-image.sh')).toBe('shell')
    expect(languageOf('README.md')).toBe('markdown')
    expect(languageOf('LICENSE')).toBe('plain')
  })

  test('python: keywords, names, strings, comments, numbers, decorators', () => {
    expect(kinds('    def time_exit_sells(self, entered_at: time | None) -> bool:', 'python')).toEqual([
      'def:keyword',
      'time_exit_sells:function',
      '(:plain',
      'self:constant',
      ',:plain',
      'entered_at:variable',
      '::plain',
      'time:variable',
      '|:plain',
      'None:constant',
      ') ->:plain',
      'bool:type',
      '::plain',
    ])
    expect(kinds('        return cutoff is None or entered_at < cutoff  # sells it', 'python')).toContain('# sells it:comment')
    expect(kinds('ticker: str = "SPY"', 'python')).toEqual(['ticker:variable', '::plain', 'str:type', '=:plain', '"SPY":string'])
    expect(kinds('@dataclass', 'python')).toEqual(['@dataclass:decorator'])
    expect(kinds('profit_locks = ((1.0, 0.75), (1.2, 1e3))', 'python').filter(one => one.endsWith(':number'))).toEqual([
      '1.0:number',
      '0.75:number',
      '1.2:number',
      '1e3:number',
    ])
    expect(kinds('class StrategySettings(Base):', 'python')).toEqual(['class:keyword', 'StrategySettings:type', '(:plain', 'Base:type', ')::plain'])
    expect(kinds("f'{x}' + rb'\\x00'", 'python')).toEqual(["f'{x}':string", '+:plain', "rb'\\x00':string"])
  })

  test('python: a docstring carries over lines, and ends where it closes', () => {
    const first = tokenizeLine('    """True when the hold-until exit', 'python', START)
    expect(first.state).toEqual({ open: '"""' })
    const middle = tokenizeLine('    is set, then only a trade', 'python', first.state)
    expect(middle.tokens).toEqual([{ text: '    is set, then only a trade', kind: 'string' }])
    const last = tokenizeLine('    sold, as before)."""  # done', 'python', middle.state)
    expect(last.state).toEqual(START)
    expect(kindOf(last.tokens, 'sold')).toBe('string')
    expect(kindOf(last.tokens, '# done')).toBe('comment')
  })

  test('typescript: storage and control keywords, types, calls, comments, template strings', () => {
    expect(kinds('export const usesOf = (output: string): string[] => {', 'script')).toEqual([
      'export:control',
      'const:keyword',
      'usesOf:function',
      '= (:plain',
      'output:variable',
      '::plain',
      'string:type',
      ')::plain',
      'string:type',
      '[] => {:plain',
    ])
    expect(kinds('  if (record === undefined) return null // none', 'script')).toEqual([
      'if:control',
      '(:plain',
      'record:variable',
      '===:plain',
      'undefined:constant',
      '):plain',
      'return:control',
      'null:constant',
      '// none:comment',
    ])
    expect(kindOf(tokenizeLine('const view: CodeView = renderCodeView(rows)', 'script').tokens, 'CodeView')).toBe('type')
    const opened = tokenizeLine('const a = `first ${x}', 'script')
    expect(opened.state).toEqual({ open: '`' })
    expect(tokenizeLine('second` + 1 /* note', 'script', opened.state).state).toEqual({ open: '*/' })
    expect(tokenizeLine('end */ const', 'script', { open: '*/' }).tokens[0]).toEqual({ text: 'end */', kind: 'comment' })
  })

  test('json keys, yaml keys, toml sections, shell commands and variables, markdown headings', () => {
    expect(kinds('    "dev": "next dev -p 8133",', 'json')).toEqual(['"dev":key', '::plain', '"next dev -p 8133":string', ',:plain'])
    expect(kinds('  "private": true', 'json')).toEqual(['"private":key', '::plain', 'true:constant'])
    expect(kinds('    dev:api:', 'yaml')).toEqual(['dev:api:key', '::plain'])
    expect(kinds('version: "3"  # task', 'yaml')).toEqual(['version:key', '::plain', '"3":string', '# task:comment'])
    expect(kinds('[tool.uv]', 'toml')).toEqual(['[tool.uv]:type'])
    expect(kinds('uv run pytest "$ARGS" | tee out.log', 'shell')).toEqual([
      'uv:function',
      'run pytest:plain',
      '"$ARGS":string',
      '|:plain',
      'tee:function',
      'out.log:plain',
    ])
    expect(kinds('## Ports', 'markdown')).toEqual(['## Ports:heading'])
  })
})

const DIFF = [
  '@@ -143,3 +143,5 @@ class StrategySettings:',
  '     hold_until: time | None = time(14, 0)',
  '-    old_flag: bool = False',
  '+    hold_until_entered_before: time | None = None',
  '+    """Starts a docstring',
  '+    that ends here."""',
  ' ',
  '\\ No newline at end of file',
  '@@ -290,1 +292,1 @@',
  '     return self.macd_fast_period',
].join('\n')

describe('the code view', () => {
  test("a diff's lines carry the old file's numbers, the new one's, or both", () => {
    const rows = diffRows(DIFF)
    expect(rows.map(row => [row.kind, row.oldNo ?? null, row.newNo ?? null])).toEqual([
      ['hunk', null, null],
      ['context', 143, 143],
      ['del', 144, null],
      ['add', null, 144],
      ['add', null, 145],
      ['add', null, 146],
      ['context', 145, 147],
      ['hunk', null, null],
      ['context', 290, 292],
    ])
    expect(rows[3]?.text).toBe('    hold_until_entered_before: time | None = None')
    // The docstring opened on an added line colours the next added line too.
    const tokens = highlightRows(rows, 'settings.py')
    expect(tokens[5]).toEqual([{ text: '    that ends here."""', kind: 'string' }])
  })

  test("a file's lines are numbered from 1, tabs drawn as four spaces", () => {
    expect(contentRows('a\n\tb\n')).toEqual([
      { kind: 'line', newNo: 1, text: 'a' },
      { kind: 'line', newNo: 2, text: '    b' },
    ])
  })

  test('long lines wrap at the code column, at a space where one is near', () => {
    const tokens: Token[] = [
      { text: '    ', kind: 'plain' },
      { text: '# one two three four five six', kind: 'comment' },
    ]
    const rows = wrapTokens(tokens, 20)
    expect(rows.map(row => row.map(token => token.text).join(''))).toEqual(['    # one two three ', 'four five six'])
    expect(rows[1]?.[0]?.kind).toBe('comment')
    expect(wrapTokens([{ text: 'x'.repeat(45), kind: 'string' }], 20).map(row => row[0]?.text.length)).toEqual([20, 20, 5])
  })

  test('draws an editor: a title bar, gutters, markers, tinted rows, coloured tokens, escaped text', () => {
    const view = renderCodeView(diffRows(DIFF), { path: 'quant_connect/settings.py', columns: 120, isDiff: true }, '+3 −1')
    expect(view.chunks).toHaveLength(1)
    expect(view.hiddenRows).toBe(0)
    const svg = view.chunks[0] ?? ''
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg).toContain(`fill="${THEME.background}"`)
    expect(svg).toContain('settings.py<tspan')
    expect(svg).toContain('quant_connect')
    expect(svg).toContain(`fill="${THEME.addBackground}"`)
    expect(svg).toContain(`fill="${THEME.delBackground}"`)
    expect(svg).toContain(`fill="${THEME.addMarker}" font-weight="bold">+</text>`)
    expect(svg).toContain(`fill="${THEME.delMarker}" font-weight="bold">−</text>`)
    expect(svg).toContain(`<tspan fill="${TOKEN_COLORS.control}">return</tspan>`)
    expect(svg).toContain(`<tspan fill="${TOKEN_COLORS.string}">`)
    // Old and new numbers side by side, spaces drawn as no-break spaces so none collapse.
    expect(svg).toContain('>143 143</text>')
    expect(svg).not.toMatch(/<text[^>]*>[^<]* {2}/)
    const escaped = renderCodeView(contentRows('if a < b && c > "d":'), { path: 'x.py', columns: 120, isDiff: false })
    expect(escaped.chunks[0]).toContain('&lt;')
    expect(escaped.chunks[0]).toContain('&amp;&amp;')
    expect(escaped.chunks[0]).toContain('&quot;d&quot;')
  })

  test('a long file is drawn in pieces under the Svg limit, and past the cap the rest is counted', () => {
    const line = 'value = compute(alpha, beta, gamma)  # a fairly typical line of python code here'
    const big = Array.from({ length: 4_000 }, () => line).join('\n')
    const view = renderCodeView(contentRows(big), { path: 'big.py', columns: 160, isDiff: false })
    expect(view.chunks.length).toBeGreaterThan(1)
    expect(view.chunks.every(chunk => chunk.length <= CHUNK_CHARS + 2_000)).toBe(true)
    expect(view.chunks.every(chunk => chunk.startsWith('<svg') && chunk.endsWith('</svg>'))).toBe(true)
    expect(view.chunks.reduce((total, chunk) => total + chunk.length, 0)).toBeLessThanOrEqual(MAX_VIEW_CHARS + 2_000)
    // Only the first piece has the title bar.
    expect(view.chunks.filter(chunk => chunk.includes('big.py')).length).toBe(1)
    const huge = renderCodeView(contentRows(Array.from({ length: 20_000 }, () => line).join('\n')), { path: 'big.py', columns: 160, isDiff: false })
    expect(huge.hiddenRows).toBeGreaterThan(0)
  })
})

const unescaped = (text: string): string => text.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')

/** What a copy of a whole frame takes: each `text` not marked `n`, in order, one line each. */
const copied = (svg: string): string[] => [...svg.matchAll(/<text(?![^>]*class="n")[^>]*>([\s\S]*?)<\/text>/g)].map(match => unescaped(match[1] ?? ''))

/** The editor's marks a selection passes over: the title, line numbers, markers, wrap marks, hunk headers. */
const marked = (svg: string): string[] => [...svg.matchAll(/<text class="n"[^>]*>([\s\S]*?)<\/text>/g)].map(match => unescaped(match[1] ?? ''))

const sizeOf = (svg: string): string[] | undefined => /width="([\d.]+)" height="([\d.]+)"/.exec(svg)?.slice(1)

describe('the selectable code view', () => {
  test('draws the editor the image view draws, at the same size', () => {
    const options = { path: 'quant_connect/settings.py', columns: 120, isDiff: true }
    const image = renderCodeView(diffRows(DIFF), options, '+3 −1').chunks[0] ?? ''
    const view = renderSelectableView(diffRows(DIFF), options, '+3 −1')
    expect(view.frames).toHaveLength(1)
    expect(view.hiddenRows).toBe(0)
    const frame = view.frames[0]
    const svg = frame?.source ?? ''
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(sizeOf(svg)).toEqual(sizeOf(image))
    expect([frame?.width, frame?.height]).toEqual(sizeOf(image)?.map(Number))
    // A frame narrower than the drawing shrinks it from the top left; what is left under it is editor.
    expect(svg).toContain('preserveAspectRatio="xMinYMin meet"')
    expect(svg).toContain(`html,body{background:${THEME.background}}`)
    for (const color of [THEME.background, THEME.titleBar, THEME.addBackground, THEME.addGutter, THEME.delBackground, THEME.delGutter, THEME.hunkBackground]) {
      expect(svg).toContain(`fill="${color}"`)
    }
    expect(svg).toContain(`fill="${THEME.addMarker}" font-weight="bold">+</text>`)
    expect(svg).toContain(`fill="${THEME.delMarker}" font-weight="bold">−</text>`)
    expect(svg).toContain(`<tspan fill="${TOKEN_COLORS.control}">return</tspan>`)
    expect(svg).toContain(`<tspan fill="${TOKEN_COLORS.string}">`)
    expect(svg).toContain('quant_connect')
  })

  test('a copy is the code: no title, line numbers, markers or hunk headers, spaces as written', () => {
    const source = ['def f(a, b):', '    """Doc."""', '', '\treturn a  <  b  # two spaces & "more"'].join('\n')
    const svg = renderSelectableView(contentRows(source), { path: 'x.py', columns: 120, isDiff: false }).frames[0]?.source ?? ''
    // Real spaces kept by a rule, not no-break spaces, which a copy would carry into the code.
    expect(svg).not.toContain(' ')
    expect(svg).toContain('<style>text{white-space:pre}.n{-webkit-user-select:none;user-select:none}')
    // A blank line is a space, so a copy across it keeps the line; a tab is the four spaces drawn.
    expect(copied(svg)).toEqual(['def f(a, b):', '    """Doc."""', ' ', '    return a  <  b  # two spaces & "more"'])
    expect(marked(svg)).toEqual(['x.py', '  1', '  2', '  3', '  4'])
    const diff = renderSelectableView(diffRows(DIFF), { path: 'settings.py', columns: 120, isDiff: true }, '+3 −1').frames[0]?.source ?? ''
    expect(copied(diff)).toEqual([
      '    hold_until: time | None = time(14, 0)',
      '    old_flag: bool = False',
      '    hold_until_entered_before: time | None = None',
      '    """Starts a docstring',
      '    that ends here."""',
      ' ',
      '    return self.macd_fast_period',
    ])
    expect(marked(diff)).toContain('settings.py  ·  +3 −1')
    expect(marked(diff)).toContain('@@ -143,3 +143,5 @@ class StrategySettings:')
    expect(marked(diff)).toContain('143 143')
    expect(marked(diff)).toContain('    145')
    expect(marked(diff)).toContain('+')
    expect(marked(diff)).toContain('−')
  })

  test('a wrapped line is one text, its pieces under each other, read back whole', () => {
    const line = '    total = alpha + beta + gamma + delta + epsilon + zeta + eta + theta + iota + kappa'
    const svg = renderSelectableView(contentRows(line), { path: 'x.py', columns: 60, isDiff: false }).frames[0]?.source ?? ''
    expect(copied(svg)).toEqual([line])
    const rows = [...svg.matchAll(/<tspan x="[\d.]+" y="([\d.]+)">/g)].map(match => Number(match[1]))
    expect(rows.length).toBeGreaterThan(1)
    expect(rows.slice(1).map((y, index) => Math.round(y - (rows[index] ?? 0)))).toEqual(rows.slice(1).map(() => 20))
    expect(marked(svg).filter(mark => mark === '↪')).toHaveLength(rows.length - 1)
  })

  test('a long file is drawn in frames under the Svg limits, and read back whole', () => {
    // Short lines, as many as fit the view's cap: frames end at the Svg height limit.
    const line = 'value = compute(alpha, beta, gamma)  # a fairly typical line of python code here'
    const lines = Array.from({ length: 600 }, (_, index) => `v${index} = ${index}`)
    const view = renderSelectableView(contentRows(lines.join('\n')), { path: 'big.py', columns: 160, isDiff: false })
    expect(view.hiddenRows).toBe(0)
    expect(view.frames.length).toBeGreaterThan(2)
    expect(view.frames.every(frame => frame.height <= MAX_SVG_PX && frame.width === view.frames[0]?.width)).toBe(true)
    expect(view.frames.every(frame => frame.source.length <= CHUNK_CHARS + 2_000)).toBe(true)
    expect(view.frames.every(frame => frame.source.startsWith('<svg') && frame.source.endsWith('</svg>') && frame.source.includes('<style>'))).toBe(true)
    // Stacked, the frames are the image's height: the title, a row per line, the room under the last.
    expect(view.frames.reduce((total, frame) => total + frame.height, 0)).toBe(30 + 600 * 20 + 6)
    expect(view.frames.filter(frame => frame.source.includes('big.py')).length).toBe(1)
    expect(view.frames.flatMap(frame => copied(frame.source))).toEqual(lines)
    const huge = renderSelectableView(contentRows(Array.from({ length: 20_000 }, () => line).join('\n')), { path: 'big.py', columns: 160, isDiff: false })
    expect(huge.hiddenRows).toBeGreaterThan(0)
    // The view stays within its cap (a frame's closing markup aside), leaving the rest of the pane room in what the desktop app draws.
    expect(huge.frames.reduce((total, frame) => total + frame.source.length, 0)).toBeLessThanOrEqual(MAX_VIEW_CHARS + 2_000)
  })

  test('a wrapped line that would straddle two frames starts the next one, whole', () => {
    // 202 lines leave one row of the first frame; the long line needs three.
    const short = Array.from({ length: 202 }, (_, index) => `line_${index} = ${index}`)
    const long = `total = ${Array.from({ length: 24 }, (_, index) => `term_${index}`).join(' + ')}`
    const view = renderSelectableView(contentRows([...short, long, 'done = True'].join('\n')), { path: 'x.py', columns: 60, isDiff: false })
    expect(view.frames).toHaveLength(2)
    expect(copied(view.frames[0]?.source ?? '')).toEqual(short)
    expect(copied(view.frames[1]?.source ?? '')).toEqual([long, 'done = True'])
    expect(marked(view.frames[1]?.source ?? '')[0]).toBe('203')
  })

  test('a line wrapped taller than a frame goes on in the next, as a continuation', () => {
    const line = `x = "${'abcdefghij'.repeat(3_000)}"`
    const view = renderSelectableView(contentRows(line), { path: 'long.py', columns: 60, isDiff: false })
    expect(view.frames.length).toBeGreaterThan(2)
    expect(view.frames.every(frame => frame.height <= MAX_SVG_PX)).toBe(true)
    expect(view.frames.map(frame => copied(frame.source).join('')).join('')).toBe(line)
    expect(marked(view.frames[0]?.source ?? '').slice(0, 2)).toEqual(['long.py', '  1'])
    expect(marked(view.frames[1]?.source ?? '')[0]).toBe('↪')
  })
})
