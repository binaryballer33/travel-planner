// A file's icon by its type, as an editor's file tree marks one: a short
// badge in its language's colour (TS, py, {}), or an emoji where one reads
// at a glance (🐳 for a Dockerfile). Every glyph takes two cells, so the
// names after them line up. Pure.

/** A file's icon: its glyph and the colour it is drawn in ('' for an emoji, which brings its own). */
export type FileIcon = { glyph: string; color: string }

/** A file of no type known here. */
export const DEFAULT_ICON: FileIcon = { glyph: '📄', color: '' }

const badge = (glyph: string, color: string): FileIcon => ({ glyph: glyph.length === 1 ? `${glyph} ` : glyph, color })
const emoji = (glyph: string): FileIcon => ({ glyph, color: '' })

const PYTHON = badge('py', '#4b8bbe')
const TYPESCRIPT = badge('TS', '#3178c6')
const JAVASCRIPT = badge('JS', '#f1e05a')
const REACT = badge('⚛', '#61dafb')
const JSON_ICON = badge('{}', '#cbcb41')
const SHELL = badge('$', '#89e051')
const MARKDOWN = badge('M↓', '#519aba')
const YAML = badge('≡', '#a074c4')
const CONFIG = badge('⚙', '#8a9ba8')
const HTML = badge('<>', '#e34c26')
const CSS = badge('#', '#a86ee0')
const DATA = badge('▦', '#89e051')
const IMAGE = badge('▣', '#a074c4')
const TEXT = badge('≣', '#8a8a8a')
const ARCHIVE = badge('▥', '#c0a26c')
const GIT = badge('◆', '#f14e32')
const DOCKER = emoji('🐳')
const SECRET = emoji('🔑')
const LOCK = emoji('🔒')

/** By the whole name, lowercase: files whose name says what they are. */
const BY_NAME: ReadonlyMap<string, FileIcon> = new Map([
  ['dockerfile', DOCKER],
  ['.dockerignore', DOCKER],
  ['docker-compose.yml', DOCKER],
  ['docker-compose.yaml', DOCKER],
  ['compose.yml', DOCKER],
  ['compose.yaml', DOCKER],
  ['makefile', badge('mk', '#8a9ba8')],
  ['.gitignore', GIT],
  ['.gitattributes', GIT],
  ['.gitmodules', GIT],
  ['license', badge('§', '#cbcb41')],
  ['.env', SECRET],
  ['package-lock.json', LOCK],
  ['pnpm-lock.yaml', LOCK],
  ['yarn.lock', LOCK],
  ['uv.lock', LOCK],
  ['poetry.lock', LOCK],
  ['cargo.lock', LOCK],
])

/** By the extension, lowercase, without its dot. */
const BY_EXTENSION: ReadonlyMap<string, FileIcon> = new Map([
  ['py', PYTHON],
  ['pyi', PYTHON],
  ['pyw', PYTHON],
  ['ipynb', badge('nb', '#f37626')],
  ['ts', TYPESCRIPT],
  ['mts', TYPESCRIPT],
  ['cts', TYPESCRIPT],
  ['tsx', REACT],
  ['jsx', REACT],
  ['js', JAVASCRIPT],
  ['mjs', JAVASCRIPT],
  ['cjs', JAVASCRIPT],
  ['json', JSON_ICON],
  ['jsonc', JSON_ICON],
  ['json5', JSON_ICON],
  ['sh', SHELL],
  ['bash', SHELL],
  ['zsh', SHELL],
  ['fish', SHELL],
  ['md', MARKDOWN],
  ['mdx', MARKDOWN],
  ['markdown', MARKDOWN],
  ['yml', YAML],
  ['yaml', YAML],
  ['toml', CONFIG],
  ['ini', CONFIG],
  ['cfg', CONFIG],
  ['conf', CONFIG],
  ['html', HTML],
  ['htm', HTML],
  ['css', CSS],
  ['scss', CSS],
  ['sass', CSS],
  ['less', CSS],
  ['go', badge('go', '#00add8')],
  ['rs', badge('rs', '#dea584')],
  ['java', badge('Jv', '#b07219')],
  ['kt', badge('Kt', '#a97bff')],
  ['swift', badge('Sw', '#f05138')],
  ['c', badge('C', '#a8b9cc')],
  ['h', badge('C', '#a8b9cc')],
  ['cpp', badge('C+', '#f34b7d')],
  ['cc', badge('C+', '#f34b7d')],
  ['hpp', badge('C+', '#f34b7d')],
  ['cs', badge('C#', '#178600')],
  ['rb', badge('rb', '#cc342d')],
  ['php', badge('ph', '#777bb4')],
  ['lua', badge('lu', '#51a0cf')],
  ['sql', badge('SQ', '#e38c00')],
  ['csv', DATA],
  ['tsv', DATA],
  ['xlsx', DATA],
  ['xls', DATA],
  ['parquet', DATA],
  ['png', IMAGE],
  ['jpg', IMAGE],
  ['jpeg', IMAGE],
  ['gif', IMAGE],
  ['webp', IMAGE],
  ['ico', IMAGE],
  ['bmp', IMAGE],
  ['svg', badge('◇', '#ffb13b')],
  ['pdf', badge('▤', '#e2574c')],
  ['txt', TEXT],
  ['log', TEXT],
  ['zip', ARCHIVE],
  ['tar', ARCHIVE],
  ['gz', ARCHIVE],
  ['tgz', ARCHIVE],
  ['bz2', ARCHIVE],
  ['xz', ARCHIVE],
  ['7z', ARCHIVE],
  ['lock', LOCK],
  ['dockerfile', DOCKER],
  ['dockerignore', DOCKER],
  ['env', SECRET],
])

/**
 * A file's icon from its path: its whole name first (Dockerfile, .gitignore,
 * a lock file), then `Dockerfile.<anything>` and `.env.<anything>`, then its
 * extension; DEFAULT_ICON for the rest.
 */
export const fileIcon = (path: string): FileIcon => {
  const name = (path.split('/').pop() ?? '').toLowerCase()
  const named = BY_NAME.get(name)
  if (named !== undefined) {
    return named
  }
  if (name.startsWith('dockerfile.')) {
    return DOCKER
  }
  if (name.startsWith('.env.')) {
    return SECRET
  }
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? DEFAULT_ICON : (BY_EXTENSION.get(name.slice(dot + 1)) ?? DEFAULT_ICON)
}
