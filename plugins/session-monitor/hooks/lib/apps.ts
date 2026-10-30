// Which app opens a file from the pane's Open buttons: code, config, data and
// text files in Cursor, web pages in Chrome, anything else (an image, a PDF,
// a folder) in the app macOS picks for it. Pure: no `$`.

/** An app as `open -a` names it, and the short name its button says. */
export type OpenApp = { app: string; label: string }

/** Where code and text files open. */
export const CODE_APP: OpenApp = { app: 'Cursor', label: 'Cursor' }
/** Where web pages open. */
export const WEB_APP: OpenApp = { app: 'Google Chrome', label: 'Chrome' }

const WEB_EXTENSIONS: ReadonlySet<string> = new Set(['html', 'htm', 'xhtml'])

/** Extensions of files read and written as text in an editor: source, config, data, docs, logs. */
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  // Python
  'py', 'pyi', 'pyw', 'pyx', 'pxd', 'ipynb',
  // JavaScript and TypeScript, and the frameworks' own files
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte', 'astro',
  // Data and config
  'json', 'jsonc', 'json5', 'jsonl', 'ndjson', 'csv', 'tsv', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'properties', 'xml', 'xsd', 'lock', 'sql', 'graphql', 'gql', 'proto', 'prisma', 'editorconfig',
  // JVM
  'java', 'kt', 'kts', 'scala', 'sc', 'groovy', 'gradle', 'clj', 'cljs', 'edn',
  // C family, Apple
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'ino', 'cs', 'csx', 'fs', 'fsx', 'swift', 'm', 'mm',
  // Other languages
  'go', 'mod', 'sum', 'rs', 'rb', 'erb', 'rake', 'php', 'pl', 'pm', 'lua', 'r', 'rmd', 'jl', 'dart', 'ex', 'exs',
  'erl', 'hrl', 'hs', 'ml', 'mli', 'elm', 'zig', 'nim', 'sol', 'vb', 'v', 'sv', 'vhd', 'asm', 's', 'wat',
  // Shell
  'sh', 'bash', 'zsh', 'fish', 'ksh', 'ps1', 'psm1', 'bat', 'cmd', 'awk',
  // Styles and templates
  'css', 'scss', 'sass', 'less', 'styl', 'pcss', 'hbs', 'handlebars', 'mustache', 'ejs', 'pug', 'njk', 'liquid', 'jinja', 'j2', 'twig',
  // Docs and text
  'md', 'mdx', 'markdown', 'rst', 'adoc', 'txt', 'text', 'log', 'tex', 'bib', 'org',
  // Build and infrastructure
  'tf', 'tfvars', 'hcl', 'nix', 'mk', 'cmake', 'bzl', 'bazel', 'dockerfile', 'containerfile', 'service',
  // Changes
  'diff', 'patch',
])

/** Files known by their whole name, with no extension or one that says nothing (`Dockerfile`, `Makefile`). */
const CODE_NAMES: ReadonlySet<string> = new Set([
  'dockerfile', 'containerfile', 'makefile', 'gnumakefile', 'justfile', 'taskfile', 'procfile', 'gemfile', 'rakefile',
  'podfile', 'brewfile', 'vagrantfile', 'jenkinsfile', 'pipfile', 'license', 'licence', 'readme', 'changelog',
  'codeowners', 'authors', 'notice', 'copying',
])

/** What follows a dotfile's own name in a variant of it (`.env.local`, `.npmrc.example`). */
const DOTFILE_SUFFIXES: ReadonlySet<string> = new Set(['local', 'dev', 'development', 'prod', 'production', 'staging', 'test', 'example', 'sample', 'template', 'defaults', 'dist', 'bak', 'orig'])

/** Dotfiles that are not text. */
const BINARY_DOTFILES: ReadonlySet<string> = new Set(['.ds_store', '.localized'])

/** A file's name, lowercased, from its path. */
const nameOf = (path: string): string => (path.split('/').pop() ?? '').toLowerCase()

/** The app a file opens in from the pane; undefined for the one macOS picks. */
export const appFor = (path: string): OpenApp | undefined => {
  const name = nameOf(path)
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1) : ''
  if (WEB_EXTENSIONS.has(extension)) {
    return WEB_APP
  }
  // A dotfile (`.gitignore`, `.eslintrc`, `.env.local`) is config text; not `.DS_Store`, nor a hidden image.
  const isDotfile = name.startsWith('.') && name.length > 1 && !BINARY_DOTFILES.has(name) && (dot === 0 || DOTFILE_SUFFIXES.has(extension))
  // A known name counts alone (`LICENSE`, not `LICENSE.pdf`); a Dockerfile keeps its suffix (`Dockerfile.dev`).
  const isNamed = CODE_NAMES.has(name) || name.startsWith('dockerfile.')
  return CODE_EXTENSIONS.has(extension) || isDotfile || isNamed ? CODE_APP : undefined
}

/** What a file's Open button says: the app it opens in. */
export const openLabel = (path: string): string => `Open in ${appFor(path)?.label ?? 'app'}`

/**
 * The `open` command line for a path: `-R` reveals it in Finder; a folder
 * opens in Finder; a file in its app (lib/apps.ts appFor), else the one
 * macOS picks for it.
 */
export const openArgv = (path: string, isReveal: boolean, isFolder: boolean): string[] => {
  if (isReveal) {
    return ['open', '-R', path]
  }
  const chosen = isFolder ? undefined : appFor(path)
  return chosen === undefined ? ['open', path] : ['open', '-a', chosen.app, path]
}
