// The pane's tab bar in the desktop app: a `Client` region of buttons, one per
// tab. A plain Button of the pane is pressed by the handle the engine gave it
// in the drawing the app shows, and each redraw (every second on a live tab)
// hands out new ones: a click that lands between a redraw and the app drawing
// it presses a handle the engine no longer holds, and nothing happens. A press
// inside a Client is addressed by the Client's key, which stays from one
// redraw to the next, so a tab is reached whatever was redrawn meanwhile.
// Runs on the drawing thread, without `$`; the tabs arrive as props. A tab's
// letter (lib/hotkeys.ts) opens it while the bar holds the focus.

import type { ClientModule } from 'claude-code'

import { hearTabKeys } from '../lib/hotkeys'

/** One tab's button. Every field is set (props are JSON). */
export type TabBarTab = { id: string; label: string; hotkey: string; isActive: boolean }

export type TabBarProps = { tabs: TabBarTab[]; columnGap: number; rowGap: number }

/** What a tab's button posts: the tab it opens. */
export type TabPress = { kind: 'tab'; tab: string }

/** The tab bar's key: the address its presses carry. */
export const TAB_BAR_KEY = 'tabs'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** What a tab's button posted, when it is one: the id of the tab it opens; undefined for anything else. */
export const readTabPress = (data: unknown): string | undefined => (isRecord(data) && data.kind === 'tab' && typeof data.tab === 'string' ? data.tab : undefined)

const TabBar: ClientModule<TabBarProps> = (props, surface) => {
  const { Box, Button } = surface.elements
  // The desktop app draws no hotkeys: once a click has given the bar the focus, a tab's letter opens it.
  hearTabKeys(surface)
  return (
    <Box key="tabs" flexDirection="row" flexWrap="wrap" columnGap={props.columnGap} rowGap={props.rowGap}>
      {props.tabs.map(tab => {
        const press: TabPress = { kind: 'tab', tab: tab.id }
        return (
          <Button
            key={`tab:${tab.id}`}
            label={tab.label}
            hotkey={tab.hotkey}
            variant={tab.isActive ? 'primary' : 'secondary'}
            onPress={() => surface.post(press)}
          />
        )
      })}
    </Box>
  )
}

export default TabBar
