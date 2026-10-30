// Pages of a long list, newest first: as many of a page's items as fit a
// share of the list budget (lib/fit.ts), an open one always, with ‹ Newer
// and Older › and which of how many it shows. Prompts pages its cards with
// it, an agent's card its calls. Pure.

import type { RenderElement } from 'claude-code'

import { fitList, keptRun, listShareOf } from '../lib/fit'
import type { PaneData, Ui } from './kit'

/** A card of a page and what it takes of the list budget. */
export type Card = { id: string; element: RenderElement; share: number }

/** One page of a list: where it starts, the cards it draws, and how many of its first ones are drawn in a row. */
export type Page = { from: number; cards: Card[]; run: number }

/**
 * A page of a list, newest first: `size` of its items from `from` (moved into
 * the list when past its end), as many as fit `budget` of the list budget,
 * those `isPinned` (an open card) kept.
 */
export const pageOf = <T extends { id: string }>(items: readonly T[], from: number, size: number, draw: (item: T, index: number) => RenderElement, isPinned: (id: string) => boolean, budget: number): Page => {
  const start = Math.min(Math.max(0, from), Math.max(0, items.length - 1))
  const window = items.slice(start, start + size).map((item, offset): Card => {
    const element = draw(item, start + offset)
    return { id: item.id, element, share: listShareOf(element) }
  })
  const cards = fitList(window, card => card.share, card => isPinned(card.id), budget)
  return { from: start, cards, run: keptRun(cards, window) }
}

/**
 * Where ‹ Newer starts: the earliest start at most a page back whose page runs
 * on to this page's first card, so a page cut short by the budget (a card
 * open with its calls) skips none of the prompts between them.
 */
export const newerFromOf = <T extends { id: string }>(items: readonly T[], page: Page, size: number, draw: (item: T, index: number) => RenderElement, isPinned: (id: string) => boolean, budget: number): number => {
  // Each card drawn once, however many starts are weighed.
  const drawn = new Map<number, RenderElement>()
  const once = (item: T, index: number): RenderElement => {
    const known = drawn.get(index)
    if (known !== undefined) {
      return known
    }
    const element = draw(item, index)
    drawn.set(index, element)
    return element
  }
  for (let from = Math.max(0, page.from - size); from < page.from; from += 1) {
    const before = pageOf(items, from, size, once, isPinned, budget)
    if (before.from + Math.max(before.run, 1) >= page.from) {
      return from
    }
  }
  return Math.max(0, page.from - 1)
}

/** A page's buttons and range: ‹ Newer, Older ›, and which of how many it shows (`#95–#86 of 95` where cards are numbered). */
export const pager = (total: number, page: Page, newerFrom: number, keys: { newer: string; older: string }, isNumbered: boolean, onPage: (from: number) => void, data: PaneData, ui: Ui): RenderElement[] => {
  const { Box, Text, Button } = ui
  const next = page.from + Math.max(page.run, 1)
  if (page.from === 0 && next >= total) {
    return []
  }
  const range = isNumbered ? `#${total - page.from}–#${total - next + 1} of ${total}` : `${page.from + 1}–${next} of ${total}`
  return [
    <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap - 1} rowGap={data.space.row} alignItems="center">
      {page.from > 0 && <Button key={keys.newer} label="‹ Newer" onPress={() => onPage(newerFrom)} />}
      {next < total && <Button key={keys.older} label="Older ›" onPress={() => onPage(next)} />}
      <Text dimColor>{range}</Text>
    </Box>,
  ]
}
