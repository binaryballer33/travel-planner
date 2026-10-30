// The pane's hotkeys: a letter for each tab, pressed while the pane has the
// focus. The terminal presses a tab's Button by its `hotkey` while the pane
// holds the keyboard. The desktop app draws no hotkeys, so each of the pane's
// regions (the tab bar, rows, titles, the effort slider: view/*.tsx Client
// modules) hears the letter itself once a click has given it the focus, and
// posts the tab as the tab bar's buttons do. Pure, so the regions can import it.

import type { ClientKeyEvent, ClientSurface } from 'claude-code'

import type { MonitorTab } from '../../types'

/** Each tab's letter: the first of its name where free (o, p, a, c, f, e, s, r), else one in it (commits g, compute m, ports t, cache h). */
export const TAB_HOTKEYS: Readonly<Record<MonitorTab, string>> = {
  overview: 'o',
  prompts: 'p',
  agents: 'a',
  commands: 'c',
  commits: 'g',
  files: 'f',
  explorer: 'e',
  sources: 's',
  resources: 'r',
  compute: 'm',
  ports: 't',
  cache: 'h',
}

const isTab = (value: string): value is MonitorTab => Object.prototype.hasOwnProperty.call(TAB_HOTKEYS, value)

/** The tab a key opens: its letter alone, with no ctrl or ⌘ held (shift is taken as the same letter); none for any other key. */
export const tabOfHotkey = (event: ClientKeyEvent): MonitorTab | undefined => {
  if (event.ctrl === true || event.meta === true || event.key.length !== 1) {
    return undefined
  }
  const key = event.key.toLowerCase()
  return Object.keys(TAB_HOTKEYS)
    .filter(isTab)
    .find(tab => TAB_HOTKEYS[tab] === key)
}

/** What a region posts for a tab's letter: what the tab bar's buttons post (view/tab-bar.tsx TabPress). */
export type TabKeyPress = { kind: 'tab'; tab: MonitorTab }

/**
 * Has a region open a tab on its letter while it holds the focus, posting it
 * as the tab bar's buttons do. Called on every call of the module: it sets the
 * region's one key listener, so a later call replaces it.
 */
export const hearTabKeys = (surface: Pick<ClientSurface, 'onKey' | 'post'>): void => {
  surface.onKey(event => {
    const tab = tabOfHotkey(event)
    if (tab !== undefined) {
      const press: TabKeyPress = { kind: 'tab', tab }
      surface.post(press)
    }
  })
}
