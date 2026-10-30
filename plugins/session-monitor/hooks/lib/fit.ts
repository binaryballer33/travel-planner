// What of a long list fits in one drawing. Two bounds hold a pane's tree:
// the engine draws no more than 100,000 characters of its text and leaves
// the rest blank (a region's prop past that keeps its last value), and the
// desktop app's renderer refuses one of 2,000 nodes or more, 32 deep or
// more, or 262,144 characters or more (DESKTOP_LIMITS), and goes on showing
// the drawing before it, whose buttons the engine has already let go: a
// click on one does nothing. A long session's Prompts tab came to 4,005
// elements and their strings, and no tab could be reached from the pane
// again. So a long list stops short of LIST_BUDGET, whatever was asked for.
// Pure.

/** The desktop app's renderer's bounds on one drawing, each one past the most it takes: at one, it keeps the drawing before. */
export const DESKTOP_LIMITS = { nodes: 2_000, depth: 32, chars: 262_144 } as const

/**
 * What one drawing costs the desktop app's renderer, counted as it counts:
 * a node for each element and each string (and for each of a Select's
 * options and a Markdown's links), how deep it goes, and the characters it
 * holds (DESKTOP_LIMITS).
 */
export type DrawCost = { nodes: number; depth: number; chars: number }

/** A budget: nodes and characters. */
export type Budget = { nodes: number; chars: number }

/**
 * What a long list may take of a drawing, leaving the tab bar, the live
 * strip, summaries and an open code view their room; within the engine's
 * 100,000 characters of text as well.
 */
export const LIST_BUDGET: Budget = { nodes: 1_000, chars: 85_000 }

const NONE: DrawCost = { nodes: 0, depth: 0, chars: 0 }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The characters of the values that are strings. */
const lengthOf = (...values: readonly unknown[]): number => values.reduce((total: number, value) => total + (typeof value === 'string' ? value.length : 0), 0)

/** An object's keys and its string values, as the renderer counts a Box's props. */
const fieldsOf = (value: unknown): number =>
  isRecord(value) ? Object.entries(value).reduce((total, [name, field]) => total + name.length + (typeof field === 'string' ? field.length : 0), 0) : 0

const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : [])

/**
 * What the engine writes into each pressable element and each region before
 * the app counts it: the plugin's name (`press.plugin`, `client.plugin`).
 */
export const PLUGIN_NAME_CHARS = 'session-monitor'.length

/** What the engine adds to a bold Text with no weight of its own before an app counts it: `weight: "semibold"`. */
export const BOLD_WEIGHT_CHARS = 'weight'.length + 'semibold'.length

/** The characters an element holds itself, its children aside: its text, labels, code, an Svg's source, a Client's props as JSON. */
const ownChars = (element: Record<string, unknown>): number => {
  const props = isRecord(element.props) ? element.props : {}
  switch (element.type) {
    case 'engine':
    case 'fragment':
      return 0
    case 'Button':
      return lengthOf(props.key, props.label, props.hotkey, props.action) + PLUGIN_NAME_CHARS + fieldsOf(element.hover)
    case 'Input':
      return lengthOf(props.key, props.label, props.placeholder, props.value, props.submitLabel) + PLUGIN_NAME_CHARS
    case 'Select':
      return lengthOf(props.key, props.label, props.value) + PLUGIN_NAME_CHARS + listOf(props.options).reduce((total: number, option) => total + (isRecord(option) ? lengthOf(option.value, option.label) : 0), 0)
    case 'Link':
      return lengthOf(props.href, props.label)
    case 'Code':
      return lengthOf(props.source, props.language, props.path)
    case 'Markdown':
      return lengthOf(props.text, props.key, ...listOf(props.pressableLinks)) + (isRecord(element.press) || typeof element.onLinkPress === 'function' ? PLUGIN_NAME_CHARS : 0)
    case 'Svg':
      return lengthOf(props.source, props.alt)
    case 'Client':
      return lengthOf(props.key, props.module) + PLUGIN_NAME_CHARS + JSON.stringify(props.props ?? null).length
    default:
      return fieldsOf(props) + fieldsOf(element.hover) + (element.type === 'Text' && props.bold === true && props.weight === undefined ? BOLD_WEIGHT_CHARS : 0)
  }
}

/** The nodes an element counts itself: one, and one for each of a Select's options or a Markdown's links. */
const ownNodes = (element: Record<string, unknown>): number => {
  const props = isRecord(element.props) ? element.props : {}
  return 1 + (element.type === 'Select' ? listOf(props.options).length : element.type === 'Markdown' ? listOf(props.pressableLinks).length : 0)
}

const besides = (total: DrawCost, child: DrawCost): DrawCost => ({ nodes: total.nodes + child.nodes, depth: Math.max(total.depth, child.depth), chars: total.chars + child.chars })

/** What a drawn element (or a string, or a list of either) costs the desktop app's renderer. */
export const costOf = (element: unknown): DrawCost => {
  if (typeof element === 'string') {
    return { nodes: 1, depth: 1, chars: element.length }
  }
  if (Array.isArray(element)) {
    return element.map(costOf).reduce(besides, NONE)
  }
  if (!isRecord(element)) {
    return NONE
  }
  const children = costOf(listOf(element.children))
  return { nodes: ownNodes(element) + children.nodes, depth: children.depth + 1, chars: ownChars(element) + children.chars }
}

/**
 * The most characters of text the engine sends of one drawing. Past them it
 * sends the rest blank: a string cut short or empty, a region or button that
 * does not fit as an empty Text, and once a note of how much it left out.
 */
export const ENGINE_TEXT_CHARS = 100_000

/** The engine's note where it cuts (`… 123456 more characters, not drawn`), with room to spare. */
export const ENGINE_CUT_NOTE_CHARS = 64

/**
 * The characters of a drawing the engine holds to ENGINE_TEXT_CHARS, found
 * as it walks the drawing (into Boxes, Texts and Links only): their strings,
 * a Code's source, a Markdown's text, a region's key, module and props as
 * JSON. No more than the engine holds, so what it sends is never more than
 * the drawing's other characters and ENGINE_TEXT_CHARS of these.
 */
export const cutTextOf = (element: unknown): number => {
  if (typeof element === 'string') {
    return element.length
  }
  if (Array.isArray(element)) {
    return element.reduce((total: number, child) => total + cutTextOf(child), 0)
  }
  if (!isRecord(element)) {
    return 0
  }
  const props = isRecord(element.props) ? element.props : {}
  switch (element.type) {
    case 'Box':
    case 'Text':
    case 'Link':
      return cutTextOf(listOf(element.children))
    case 'Code':
      return lengthOf(props.source)
    case 'Markdown':
      return lengthOf(props.text)
    case 'Client':
      return lengthOf(props.key, props.module) + JSON.stringify(props.props ?? null).length
    default:
      return 0
  }
}

const isBlank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === ''

/**
 * Whether the engine sends an app a Link to this href as a link: an
 * `https:` URL (or `http://localhost`) of printable ASCII, with no user and
 * no raw `@`, written as URL writes it. Any other (an `http:` site, a
 * `medium.com/@name` page, a URL with a space) it sends as plain text.
 */
export const isSentAsLink = (href: string): boolean => {
  if (/[^!-~]/.test(href) || !URL.canParse(href)) {
    return false
  }
  const url = new URL(href)
  const isWire = url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost')
  if (!isWire || url.username !== '' || url.password !== '' || href.includes('@')) {
    return false
  }
  return url.href === href || url.href === href.replace(/^(https?:\/\/[^/?#]+)(?=[?#]|$)/, '$1/')
}

/**
 * A drawing with each Link the engine will not send an app (isSentAsLink)
 * as the Text it sends in its place: of the Link's children, else its
 * label, else its href. One more node and one more level than the Link.
 */
const sentTreeOf = (element: unknown): unknown => {
  if (Array.isArray(element)) {
    return element.map(sentTreeOf)
  }
  if (!isRecord(element)) {
    return element
  }
  const children = listOf(element.children).map(sentTreeOf)
  const props = isRecord(element.props) ? element.props : {}
  if (element.type === 'Link' && (isBlank(props.href) || !isSentAsLink(String(props.href)))) {
    const text = typeof props.label === 'string' ? props.label : isBlank(props.href) ? '' : String(props.href)
    return { type: 'Text', children: children.length > 0 ? children : text === '' ? [] : [text] }
  }
  return Array.isArray(element.children) ? { ...element, children } : element
}

/**
 * What the desktop app's renderer counts of a drawing once the engine has
 * sent it: the cost of the tree it sends (a Link it will not send as plain
 * text, sentTreeOf), its text held to the engine's ENGINE_TEXT_CHARS (lib
 * header). A long folder's rows run past them; the app draws what is sent.
 */
export const sentCostOf = (element: unknown): DrawCost => {
  const sent = sentTreeOf(element)
  const cost = costOf(sent)
  const text = cutTextOf(sent)
  return { ...cost, chars: cost.chars - text + Math.min(text, ENGINE_TEXT_CHARS + ENGINE_CUT_NOTE_CHARS) }
}

/** A cost's share of a budget: the larger of its share of the nodes and its share of the characters. */
export const shareOf = (cost: DrawCost, budget: Budget = LIST_BUDGET): number => Math.max(cost.nodes / budget.nodes, cost.chars / budget.chars)

/** What a drawn element takes of the list budget as the engine sends it (sentCostOf), as fitList weighs it against a whole budget (1). */
export const listShareOf = (element: unknown): number => shareOf(sentCostOf(element))

/** Whether a drawing is one the desktop app's renderer draws. */
export const isDrawable = (cost: DrawCost): boolean => cost.nodes < DESKTOP_LIMITS.nodes && cost.depth < DESKTOP_LIMITS.depth && cost.chars < DESKTOP_LIMITS.chars

/**
 * What of a list fits in `budget`, in its order: every pinned item (an open
 * row), then the others from the first for as long as they fit. The first
 * that does not fit ends the list, so it stays the newest run; nothing past
 * it is weighed.
 */
export const fitList = <T>(items: readonly T[], weightOf: (item: T) => number, isPinned: (item: T) => boolean, budget: number): T[] => {
  let left = budget - items.filter(isPinned).reduce((total, item) => total + weightOf(item), 0)
  let isFull = false
  return items.filter(item => {
    if (isPinned(item)) {
      return true
    }
    if (!isFull) {
      left -= weightOf(item)
      isFull = left < 0
    }
    return !isFull
  })
}

/** How many of what was kept are the list's own first items, before a pinned one from further down. */
export const keptRun = <T>(kept: readonly T[], items: readonly T[]): number => {
  const gap = kept.findIndex((item, index) => item !== items[index])
  return gap < 0 ? kept.length : gap
}
