// The compact button, beside the context figure in the header and in
// Overview's Session section. Compacting is drastic, so it takes two presses:
// the first arms it for a few seconds, a second within them compacts.

import type { RenderElement } from 'claude-code'

import type { Actions, PaneData, Ui } from './kit'

/** How long a first press keeps the button armed. */
export const COMPACT_ARM_MS = 6_000

export const COMPACT_LABEL = 'Compact'
export const COMPACT_ARMED_LABEL = 'Click again to compact'

export const isCompactArmed = (data: PaneData): boolean => data.now < data.ui.compactArmedUntil

export const compactButton = (data: PaneData, ui: Ui, act: Actions, key: string): RenderElement => {
  const { Button } = ui
  const isArmed = isCompactArmed(data)
  return (
    <Button
      key={key}
      label={isArmed ? COMPACT_ARMED_LABEL : COMPACT_LABEL}
      variant={isArmed ? 'primary' : undefined}
      dimColor={!isArmed}
      onPress={() => act.compact()}
    />
  )
}
