// The session's model and effort as Overview's controls set them: the five
// effort levels in order (`/effort` takes each), their names on the slider,
// where along the slider a pointer lands, and what the slider posts. Pure.

/** The effort levels from faster to smarter, as `/effort` and a request name them. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/** What the slider calls each level. */
const EFFORT_NAMES: Readonly<Record<EffortLevel, string>> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra', max: 'Max' }

export const isEffortLevel = (value: unknown): value is EffortLevel => EFFORT_LEVELS.some(level => level === value)

/** A level's name on the slider (`xhigh` is Extra); a value that is no level, as it is. */
export const effortName = (value: string): string => (isEffortLevel(value) ? EFFORT_NAMES[value] : value)

/** A level's place on the slider, from 0; -1 for a value that is no level (none known yet). */
export const effortIndex = (value: string): number => EFFORT_LEVELS.findIndex(level => level === value)

/**
 * The level under a pointer `x` cells into a slider `width` cells wide: the
 * track is cut into one stretch per level, and a pointer past either end
 * takes that end's.
 */
export const levelAt = (x: number, width: number): EffortLevel => {
  const stops = EFFORT_LEVELS.length
  const index = width <= 0 ? 0 : Math.min(stops - 1, Math.max(0, Math.floor((x / width) * stops)))
  return EFFORT_LEVELS[index] ?? 'medium'
}

/** What the slider posts: the level it was set to. */
export type EffortPress = { kind: 'effort'; level: EffortLevel }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** What the slider posted, when it is the slider's: the level; undefined for anything else. */
export const readEffortPress = (data: unknown): EffortLevel | undefined =>
  isRecord(data) && data.kind === 'effort' && isEffortLevel(data.level) ? data.level : undefined

/** The model row's choices as the picker names them: `opus[1m]` reads `opus (1M context)`. */
export const modelLabel = (value: string): string => {
  const wide = /^(.*)\[1m\]$/.exec(value)
  const base = wide?.[1] ?? value
  const name = base === 'opusplan' ? 'Opus plan mode' : base === 'default' ? 'Default' : base === 'best' ? 'Best' : `${base.charAt(0).toUpperCase()}${base.slice(1)}`
  return wide !== null ? `${name} (1M context)` : name
}
