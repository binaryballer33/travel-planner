// A long session as the transcript reader answers it, and a project history
// of as many prompts from other sessions: what the pane draws after a day's
// work. The words and commands are made up; the sizes are a real session's
// (95 prompts, 400 calls, prompts with pages pasted in, scripts in heredocs),
// the one whose Prompts tab the desktop app would not draw; one prompt pastes
// a whole log. Below, what the desktop app's renderer counts of a drawing, to
// hold every tab to (lib/fit.ts DESKTOP_LIMITS), written apart from the mod's
// own count so a slip in one shows in the other. It counts a drawing as the
// engine sends it: a link it will not send, as the text it sends in its place.

import type { TranscriptCall, TranscriptPrompt, TranscriptSession, TranscriptUsage } from '../hooks/lib/transcripts'
import type { StoredPrompt } from '../types'
import { NOW, PARENT, SESSION_ID, SHA } from './world'

export const HEAVY_PROMPTS = 95
export const HEAVY_CALLS = 400

/** A page pasted into a prompt: about 4,400 characters. */
const PASTE = 'the strategy enters on the opening range breakout and exits at the close; '.repeat(60)

/** A whole log pasted into one prompt (HUGE_PROMPT): 300,000 characters. */
export const HUGE_PASTE = '2026-10-20 21:41:38 [warn] engine surface: ui_press not handled\n'.repeat(4_700).slice(0, 300_000)
export const HUGE_PROMPT = 3

/** A script run in a heredoc, as a long call's command. */
const SCRIPT = ["python3 - <<'EOF'", 'import json', ...Array.from({ length: 40 }, (_, line) => `rows_${line} = [r for r in data if r["grade"] == "A" and r["pnl"] > ${line}]`), 'EOF'].join('\n')

/** A long session's request: a big cached context, a little written, some out. */
const REQUEST: TranscriptUsage = { model: 'claude-opus-5-5', requests: 1, input: 6, output: 1_234, cacheRead: 187_654, cacheWrite: 12_345 }

const heavyPrompt = (index: number, startedAt: number): TranscriptPrompt => ({
  id: `hp-${index}`,
  usage: [{ ...REQUEST, requests: 5 + (index % 40), output: REQUEST.output * (5 + (index % 40)) }],
  endedAt: startedAt + index * 200_000 + 150_000,
  text:
    index === HUGE_PROMPT
      ? `why does this keep happening\n${HUGE_PASTE}`
      : index % 4 === 0
        ? `look at finding ${index} and fix what it shows\n${PASTE}`
        : `make change ${index} to the pane, test it, and tell me what moved`,
  at: startedAt + index * 200_000,
})

const heavyCall = (index: number, prompts: readonly TranscriptPrompt[], startedAt: number): TranscriptCall => {
  const prompt = prompts[Math.floor((index * prompts.length) / HEAVY_CALLS)]
  const at = (prompt?.at ?? startedAt) + 5_000 + (index % 4) * 20_000
  const isRead = index % 5 === 0
  return {
    id: `toolu_h${index}`,
    name: isRead ? 'Read' : 'Bash',
    input: isRead
      ? { file_path: `/repo/hooks/view/file${index}.tsx` }
      : { command: index % 3 === 0 ? SCRIPT : `cd /repo && git status && tail -n 40 log${index}.txt | wc -l`, description: `Step ${index} of the work` },
    startedAt: at,
    endedAt: at + 1_500,
    isError: index % 17 === 0,
    output: `line of output ${index}\n`.repeat(12),
    model: 'claude-opus-5-5',
    ...(prompt !== undefined ? { promptId: prompt.id } : {}),
    // Read by the request after it, two calls to a request.
    readBy: `msg_${Math.floor(index / 2)}`,
  }
}

/** This session's transcript after a long day: HEAVY_PROMPTS prompts and HEAVY_CALLS calls. */
export const heavySession = (): TranscriptSession => {
  const startedAt = NOW - 6 * 3_600_000
  const prompts = Array.from({ length: HEAVY_PROMPTS }, (_, index) => heavyPrompt(index, startedAt))
  return {
    id: SESSION_ID,
    title: 'A long day',
    cwd: '/repo',
    branch: 'main',
    startedAt,
    lastAt: NOW - 1_000,
    prompts,
    calls: Array.from({ length: HEAVY_CALLS }, (_, index) => heavyCall(index, prompts, startedAt)),
    requests: Object.fromEntries(Array.from({ length: HEAVY_CALLS / 2 }, (_, index) => [`msg_${index}`, REQUEST])),
  }
}

/** The project's history: as many prompts again from other sessions, a day before. */
export const heavyHistory = (): StoredPrompt[] =>
  Array.from({ length: HEAVY_PROMPTS }, (_, index) => ({
    id: `old-${index}`,
    text: index % 4 === 0 ? `an earlier look at finding ${index}\n${PASTE}` : `an earlier change ${index}`,
    summary: `Earlier change ${index}`,
    at: NOW - 86_400_000 + index * 60_000,
    sessionId: `session-${String(index % 7).padStart(4, '0')}`,
  }))

/** A commit of `count` files, as the world's `git log` answers it. */
export const bigCommitLog = (count: number): string => {
  const header = `\u001e${[SHA, 'ccccccc', PARENT, 'Ada', 'ada@example.com', String(NOW / 1000 - 60), String(NOW / 1000 - 60), 'HEAD -> main', 'refactor: move every view', 'A big one.'].join('\u001f')}\u001d\n\n`
  const paths = Array.from({ length: count }, (_, index) => `src/module_${String(index).padStart(3, '0')}/view_with_a_long_name.py`)
  return header + paths.map(path => `:100644 100644 a b M\t${path}\n`).join('') + paths.map(path => `12\t7\t${path}\n`).join('')
}

/** `count` commits, newest first: bigCommitLog's of `files` files, then commits of one file each, as a long branch has. */
export const commitsLog = (count: number, files: number): string =>
  bigCommitLog(files) +
  Array.from({ length: count - 1 }, (_, index) => {
    const sha = `${String(index + 1).padStart(4, '0')}${'d'.repeat(36)}`
    const at = String(NOW / 1000 - 120 - index * 60)
    const path = `src/module_${String(index).padStart(3, '0')}/view_with_a_long_name.py`
    return `\u001e${[sha, sha.slice(0, 7), `${String(index + 2).padStart(4, '0')}${'d'.repeat(36)}`, 'Ada', 'ada@example.com', at, at, '', `feat(view): change number ${index} of the long branch`, 'Why it matters.'].join('\u001f')}\u001d\n\n:100644 100644 a b M\t${path}\n3\t1\t${path}\n`
  }).join('')

/** A unified diff of one file that changes `lines` lines. */
export const bigDiff = (lines: number): string =>
  [
    'diff --git a/src/app.py b/src/app.py',
    '--- a/src/app.py',
    '+++ b/src/app.py',
    `@@ -1,${lines} +1,${lines} @@`,
    ...Array.from({ length: lines }, (_, line) => (line % 2 === 0 ? `-    value_${line} = compute(row["pnl"], row["grade"], window=${line})` : `+    value_${line} = compute(row["pnl"], row["grade"], window=${line} * 2)`)),
    '',
  ].join('\n')

/**
 * What the desktop app's renderer counts of a drawing, as it counts it: every
 * element and every string is a node (a Select's options and a Markdown's
 * links too), depth from the root, and the characters of labels, code, an
 * Svg's whole source, a Client's props as JSON and other props' names and
 * string values. It draws a tree only under every bound (DESKTOP_LIMITS).
 */
export type DesktopSize = { nodes: number; depth: number; chars: number }

/** A value's own fields, or none: what the renderer reads of an element, its props or a Select's option. */
const fieldsOf = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {})

const isObject = (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The names and string values of an object's fields, as the renderer counts a Box's or Text's props. */
const fieldChars = (value: unknown): number => Object.entries(fieldsOf(value)).reduce((total, [name, field]) => total + name.length + (typeof field === 'string' ? field.length : 0), 0)

const text = (...values: unknown[]): number => values.reduce((total: number, value) => total + (typeof value === 'string' ? value.length : 0), 0)

const items = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** The plugin name the engine writes into each pressable element (`press.plugin`) and region (`client.plugin`) before the app counts it. */
const ENGINE_PLUGIN = 'session-monitor'

const selfChars = (node: Record<string, unknown>): number => {
  const props = fieldsOf(node.props)
  switch (node.type) {
    case 'Button':
      return text(props.key, props.label, props.hotkey, props.action) + ENGINE_PLUGIN.length + fieldChars(node.hover)
    case 'Input':
      return text(props.key, props.label, props.placeholder, props.value, props.submitLabel) + ENGINE_PLUGIN.length
    case 'Select':
      return text(props.key, props.label, props.value) + ENGINE_PLUGIN.length + items(props.options).reduce((total: number, option) => total + text(fieldsOf(option).value, fieldsOf(option).label), 0)
    case 'Link':
      return text(props.href, props.label)
    case 'Code':
      return text(props.source, props.language, props.path)
    case 'Markdown':
      return text(props.text, props.key, ...items(props.pressableLinks)) + (node.press !== undefined ? ENGINE_PLUGIN.length : 0)
    case 'Svg':
      return text(props.source, props.alt)
    case 'Client':
      return text(props.key, props.module) + ENGINE_PLUGIN.length + JSON.stringify(props.props ?? null).length
    default:
      // The engine gives a bold Text with no weight `weight: "semibold"` before the app counts it.
      return fieldChars(node.props) + fieldChars(node.hover) + (node.type === 'Text' && props.bold === true && props.weight === undefined ? 'weightsemibold'.length : 0)
  }
}

/**
 * Whether the engine sends a Link to `href` as a link: only an https: URL, or
 * http: to localhost, all printable ASCII, with no `@` and spelled as the URL
 * parser spells it (a bare host may lack its slash). It sends any other as a
 * Text of its label (else its href): a node and a level more.
 */
const isLinkSent = (href: string): boolean => {
  if (!/^[!-~]+$/.test(href) || href.includes('@')) {
    return false
  }
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return false
  }
  const isAllowed = url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost')
  return isAllowed && (url.href === href || url.href === `${href}/`)
}

export const desktopSizeOf = (tree: unknown): DesktopSize => {
  if (typeof tree === 'string') {
    return { nodes: 1, depth: 1, chars: tree.length }
  }
  if (!isObject(tree)) {
    return { nodes: 1, depth: 1, chars: 0 }
  }
  const node = fieldsOf(tree)
  const props = fieldsOf(node.props)
  if (node.type === 'Link' && !isLinkSent(typeof props.href === 'string' ? props.href : '')) {
    const children = items(node.children)
    const label = typeof props.label === 'string' ? props.label : typeof props.href === 'string' ? props.href : ''
    return desktopSizeOf({ type: 'Text', children: children.length > 0 ? children : label === '' ? [] : [label] })
  }
  const own = 1 + (node.type === 'Select' ? items(props.options).length : node.type === 'Markdown' ? items(props.pressableLinks).length : 0)
  return items(node.children)
    .map(desktopSizeOf)
    .reduce((total, child) => ({ nodes: total.nodes + child.nodes, depth: Math.max(total.depth, child.depth + 1), chars: total.chars + child.chars }), { nodes: own, depth: 1, chars: selfChars(node) })
}

/** Whether the desktop app's renderer draws a tree of this size. */
export const isDesktopDrawn = (size: DesktopSize): boolean => size.nodes < 2_000 && size.depth < 32 && size.chars < 262_144
