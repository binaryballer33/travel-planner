// Formatting, glyphs and the color scale every view shares.

import type { Access, CommandStatus, FileActivity, FileStatus } from '../../types'

/** Theme keys the views paint with; each follows the person's theme. */
export type Tone =
  | 'success'
  | 'warning'
  | 'error'
  | 'subtle'
  | 'inactive'
  | 'claude'
  | 'suggestion'
  | 'merged'
  | 'permission'
  | 'text'

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g

/** Text a tree may draw: no escape sequences, no control characters but tab and newline. */
export const sanitize = (text: string): string =>
  text.replace(ANSI, '').replace(/\r\n?/g, '\n').replace(CONTROL, '')

/** The first line, sanitized and cut to `max` characters with an ellipsis. */
export const oneLine = (text: string, max: number): string => {
  const line = sanitize(text).split('\n', 1)[0] ?? ''
  const isMultiline = sanitize(text).includes('\n')
  const cut = line.length > max ? `${line.slice(0, Math.max(1, max - 1))}…` : line
  return isMultiline && cut.length < max ? `${cut} …` : cut
}

export const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text

const UNITS = ['B', 'kB', 'MB', 'GB', 'TB']

/** Bytes in decimal units, as macOS reports sizes. */
export const fmtBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${UNITS[unit]}`
}

export const fmtRate = (bytesPerSecond: number): string => `${fmtBytes(bytesPerSecond)}/s`

export const fmtDuration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) {
    return '—'
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`
  }
  const seconds = ms / 1000
  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, '0')}s`
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

export const fmtAgo = (then: number, now: number): string => {
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) {
    return `${seconds}s ago`
  }
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.round(minutes / 60)
  if (hours < 48) {
    return `${hours}h ago`
  }
  return `${Math.round(hours / 24)}d ago`
}

/** Joules, with watt-hours alongside once the figure is large. */
export const fmtEnergy = (joules: number): string => {
  if (!Number.isFinite(joules) || joules <= 0) {
    return '0 J'
  }
  if (joules < 1) {
    return `${(joules * 1000).toFixed(0)} mJ`
  }
  if (joules < 1000) {
    return `${joules.toFixed(joules < 10 ? 1 : 0)} J`
  }
  return `${(joules / 1000).toFixed(1)} kJ (${(joules / 3600).toFixed(2)} Wh)`
}

export const fmtWatts = (watts: number): string => {
  if (!Number.isFinite(watts) || watts <= 0) {
    return '0 W'
  }
  return watts < 1 ? `${(watts * 1000).toFixed(0)} mW` : `${watts.toFixed(watts < 10 ? 2 : 1)} W`
}

/** Memory's share of the Mac's RAM in percent; undefined while the RAM is not known. */
export const memShare = (bytes: number, total: number): number | undefined => (total > 0 && Number.isFinite(bytes) ? (Math.max(0, bytes) / total) * 100 : undefined)

/** A share of the Mac's RAM in percent: `7.0%`, `25%`; a sliver that would read `0.0%` reads `<0.1%`, not as if it held nothing. */
export const fmtMemShare = (pct: number): string => (pct > 0 && pct < 0.05 ? '<0.1%' : fmtPct(pct))

/** Memory with its share of the Mac's RAM: `1.21 GB (7.6%)`, `34.2 MB (<0.1%)`; the bytes alone while the RAM is not known. */
export const fmtMemory = (bytes: number, total: number): string => {
  const share = memShare(bytes, total)
  return share === undefined || bytes <= 0 ? fmtBytes(bytes) : `${fmtBytes(bytes)} (${fmtMemShare(share)})`
}

export const fmtCpuSeconds = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '0s'
  }
  return seconds < 1 ? `${Math.round(seconds * 1000)}ms` : fmtDuration(seconds * 1000)
}

export const fmtPct = (pct: number): string => `${pct >= 10 || pct === 0 ? Math.round(pct) : pct.toFixed(1)}%`

/** A percent that may be tiny, with the digits it needs: 0.042%, 0.42%, 4.2%, 42%. */
export const fmtSmallPct = (pct: number): string =>
  pct <= 0 ? '0%' : pct < 0.001 ? '<0.001%' : pct < 0.1 ? `${pct.toFixed(3)}%` : pct < 1 ? `${pct.toFixed(2)}%` : fmtPct(pct)

export const fmtUsd = (usd: number): string => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`)

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

/** The last `width` values as block characters scaled to their maximum. */
export const sparkline = (values: readonly number[], width: number): string => {
  const tail = values.slice(-Math.max(1, width))
  const top = Math.max(...tail, 0)
  if (tail.length === 0) {
    return ''
  }
  return tail
    .map(value => (top <= 0 ? BLOCKS[0] : BLOCKS[Math.min(7, Math.round((Math.max(0, value) / top) * 7))]))
    .join('')
}

/** A meter: `fraction` of `width` cells filled. */
export const meter = (fraction: number, width: number): string => {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width)
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`
}

/** GitHub's churn squares: added and removed cells out of `width`. */
export const churn = (added: number, removed: number, width: number): { plus: string; minus: string; rest: string } => {
  const total = added + removed
  if (total === 0) {
    return { plus: '', minus: '', rest: '·'.repeat(width) }
  }
  const cells = Math.min(width, total)
  let plus = Math.round((added / total) * cells)
  let minus = cells - plus
  if (added > 0 && plus === 0) {
    plus = 1
    minus = Math.max(0, cells - 1)
  }
  if (removed > 0 && minus === 0 && cells > 1) {
    minus = 1
    plus = cells - 1
  }
  return { plus: '■'.repeat(plus), minus: '■'.repeat(minus), rest: '·'.repeat(Math.max(0, width - plus - minus)) }
}

const scale = (value: number, warn: number, bad: number): Tone =>
  value >= bad ? 'error' : value >= warn ? 'warning' : 'success'

export const toneCpu = (pct: number): Tone => (pct < 1 ? 'subtle' : scale(pct, 25, 100))
export const toneWatts = (watts: number): Tone => (watts < 0.05 ? 'subtle' : scale(watts, 1, 5))
export const toneMem = (bytes: number): Tone => scale(bytes, 256e6, 1e9)
export const toneRate = (bytesPerSecond: number): Tone => (bytesPerSecond < 1 ? 'subtle' : scale(bytesPerSecond, 100e3, 2e6))
export const toneNetTotal = (bytes: number): Tone => (bytes < 1 ? 'subtle' : scale(bytes, 1e6, 50e6))
export const toneEnergy = (joules: number): Tone => (joules < 0.05 ? 'subtle' : scale(joules, 5, 50))
export const toneDuration = (ms: number): Tone => scale(ms, 10_000, 60_000)
export const tonePercentUsed = (pct: number): Tone => scale(pct, 50, 80)
export const toneUsd = (usd: number): Tone => (usd < 0.005 ? 'subtle' : scale(usd, 0.1, 1))

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export const statusGlyph = (status: CommandStatus, frame: number): string => {
  switch (status) {
    case 'running':
      return SPINNER[frame % SPINNER.length] ?? '•'
    case 'ok':
      return '✓'
    case 'error':
      return '✗'
    case 'denied':
      return '⊘'
    case 'background':
      return '◷'
  }
}

export const statusTone = (status: CommandStatus): Tone => {
  switch (status) {
    case 'running':
      return 'warning'
    case 'ok':
      return 'success'
    case 'error':
      return 'error'
    case 'denied':
      return 'inactive'
    case 'background':
      return 'suggestion'
  }
}

export const fileTone = (status: FileStatus): Tone => {
  switch (status) {
    case 'A':
      return 'success'
    case 'D':
      return 'error'
    case 'R':
    case 'C':
      return 'merged'
    case 'U':
      return 'error'
    case 'M':
    case 'T':
      return 'warning'
  }
}

export const fileWord = (status: FileStatus): string => {
  switch (status) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'U':
      return 'conflict'
    case 'T':
      return 'type changed'
    case 'M':
      return 'modified'
  }
}

export const accessTone = (access: Access): Tone =>
  access === 'read' ? 'suggestion' : access === 'write' ? 'warning' : 'merged'

export const accessLetter = (access: Access): string => (access === 'read' ? 'R' : access === 'write' ? 'W' : 'X')

export const accessWord = (access: Access): string => (access === 'read' ? 'Read' : access === 'write' ? 'Write' : 'Execute')

export const activityTone = (activity: FileActivity): Tone =>
  activity === 'created' ? 'success' : activity === 'deleted' ? 'error' : activity === 'modified' ? 'warning' : 'suggestion'

export const activityLetter = (activity: FileActivity): string =>
  activity === 'created' ? 'A' : activity === 'deleted' ? 'D' : activity === 'modified' ? 'M' : 'R'

export const statusCodeTone = (status: number | undefined): Tone =>
  status === undefined ? 'subtle' : status >= 400 ? 'error' : status >= 300 ? 'warning' : 'success'

/** A short, stable, control-free key for a Button from any text (FNV-1a). */
export const keyOf = (text: string): string => {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

/** Token counts: 950, 12.5k, 590k, 1M, 1.2M — never "1000k". */
export const fmtTokens = (tokens: number): string => {
  if (!Number.isFinite(tokens) || tokens < 1000) {
    return `${Math.max(0, Math.round(tokens || 0))}`
  }
  if (tokens < 999_500) {
    const thousands = tokens / 1000
    return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, '') : Math.round(thousands)}k`
  }
  const millions = tokens / 1e6
  return `${millions < 10 ? millions.toFixed(1).replace(/\.0$/, '') : Math.round(millions)}M`
}

/** Tokens in and out, `152k in (140k cached) · 3.1k out`: the cached part said when there is some and `withCached`. */
export const fmtInOut = (input: number, cached: number, output: number, withCached = true): string =>
  `${fmtTokens(input)} in${withCached && cached > 0 ? ` (${fmtTokens(cached)} cached)` : ''} · ${fmtTokens(output)} out`

const pad2 = (value: number): string => String(value).padStart(2, '0')

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A 12-hour wall-clock time: `2:32:05 PM` today, `Oct 12 9:05 AM` on another day. */
export const fmtClock = (then: number, now: number): string => {
  const date = new Date(then)
  const today = new Date(now)
  const hours = date.getHours()
  const hour12 = hours % 12 === 0 ? 12 : hours % 12
  const meridiem = hours < 12 ? 'AM' : 'PM'
  const isToday = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
  return isToday
    ? `${hour12}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())} ${meridiem}`
    : `${MONTHS[date.getMonth()] ?? ''} ${date.getDate()} ${hour12}:${pad2(date.getMinutes())} ${meridiem}`
}

/** `claude-opus-5-5` reads as `Opus 5.5`; an unknown name is kept. */
export const shortModel = (model: string): string => {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model)
  if (match === null) {
    return model
  }
  const family = (match[1] ?? '').charAt(0).toUpperCase() + (match[1] ?? '').slice(1)
  return `${family} ${match[2] ?? ''}${match[3] !== undefined ? `.${match[3]}` : ''}`
}

export const fmtEffort = (effort: string | number | undefined): string =>
  effort === undefined ? 'default' : typeof effort === 'number' ? `${fmtTokens(effort)} budget` : effort

// --- ui polish ---
/** Text a markdown block draws as written: one line, its markup characters escaped. */
export const mdText = (text: string, max: number): string => oneLine(text, max).replace(/[\\`*_[\]<>#|~&!]/g, '\\$&')
// --- ui polish ---
