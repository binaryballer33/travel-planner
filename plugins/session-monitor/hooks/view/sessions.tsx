// Past sessions in the pane: the picker on the Prompts, Agents, Files,
// Commits and Commands tabs (and on Overview's Session and Artifacts cards)
// that shows a session this project ran before in place of this one, the
// banner that says one is shown and leads back, and the pane's data with that
// session's record in place of this session's values. One choice serves
// every place, so the person browses one past session across them.

import type { RenderElement } from 'claude-code'

import type { MonitorTab, SessionSnapshot } from '../../types'
import { oneLine } from '../lib/format'
import { entryOf, pastGit, pastOutput, sessionDate, sessionLabel } from '../lib/history'
import { jumpLabel, picker, type Actions, type PaneData, type Ui } from './kit'

/** The tabs a past session's record stands in for this session's values on. */
export const PAST_TABS: readonly MonitorTab[] = ['prompts', 'agents', 'files', 'commits', 'commands']

/** The tabs that draw the picker: those, and Overview (on its Session and Artifacts cards). */
export const PICKER_TABS: readonly MonitorTab[] = [...PAST_TABS, 'overview']

/** The picker's value for this session. */
export const LIVE_SESSION = 'live'

/** Where a picker or banner is drawn: a tab, or one of Overview's cards. */
export type SessionPlace = 'prompts' | 'agents' | 'files' | 'commits' | 'commands' | 'session' | 'artifacts'

/** A picker's key (a Select's, or the buttons' prefix where the surface draws none). */
export const sessionPickerKey = (place: SessionPlace): string => `sessions:${place}`

/** A banner's key, and its Back button's. */
export const sessionBannerKey = (place: SessionPlace): string => `sessions:banner:${place}`
export const sessionBackKey = (place: SessionPlace): string => `sessions:back:${place}`

/**
 * The pane's data with a past session's record in place of this session's:
 * its prompts, calls, agents, files, commits, artifacts and usage. Nothing
 * live is left in it (no sampler figures, no folder tree, no web sources); an
 * opened call shows its output as the session's transcript kept it, else the
 * first line, which is all a record keeps.
 */
export const pastData = (data: PaneData, snapshot: SessionSnapshot): PaneData => {
  const open = data.ui.expandedCommand
  const record = open === null ? undefined : snapshot.commands.find(one => one.id === open)
  return {
    ...data,
    tree: null,
    explorer: null,
    live: null,
    commands: snapshot.commands,
    agents: snapshot.agents,
    git: pastGit(snapshot),
    touched: snapshot.touched,
    sources: [],
    services: [],
    usage: snapshot.usage,
    output: record === undefined ? null : pastOutput(record, snapshot.outputs),
    models: snapshot.models,
    spend: snapshot.spend,
    artifacts: snapshot.artifacts,
    prompts: snapshot.prompts,
    tasks: [],
    viewed: snapshot,
  }
}

/** What one of Overview's switchable cards draws: the past session's record while one is chosen, this session's values otherwise. */
export const viewedData = (data: PaneData): PaneData => (data.viewed === null ? data : pastData(data, data.viewed))

/** The picker's choices: this session, then the project's past ones, the newest first; the one shown stays listed even once pruned. */
export const sessionOptions = (data: PaneData): { value: string; label: string }[] => {
  const shown = data.viewed
  const entries = shown !== null && !data.sessions.some(one => one.id === shown.id) ? [entryOf(shown, 0), ...data.sessions] : data.sessions
  return [{ value: LIVE_SESSION, label: 'This session (live)' }, ...entries.map(entry => ({ value: entry.id, label: sessionLabel(entry) }))]
}

/** The session picker, where the project has past sessions or one is shown; nothing otherwise. */
export const sessionPicker = (data: PaneData, ui: Ui, act: Actions, place: SessionPlace): RenderElement | null =>
  data.sessions.length === 0 && data.viewed === null
    ? null
    : picker(ui, sessionPickerKey(place), 'Session', data.viewed?.id ?? LIVE_SESSION, sessionOptions(data), value => act.viewSession(value === LIVE_SESSION ? null : value))

/** What works differently in each place while a past session is shown. */
const pastNote = (data: PaneData, place: SessionPlace): string => {
  switch (place) {
    case 'prompts':
      return `Its prompts are in another conversation: ${jumpLabel(data.surface, true)} reaches only this session's.`
    case 'commands':
      return data.viewed?.outputs !== undefined
        ? 'Outputs are as Claude Code’s transcript kept them: a long one keeps its start and end.'
        : 'Outputs are not kept: an opened call shows only its first line.'
    case 'files':
      return 'A file opens as it is today: it may have changed since.'
    case 'commits':
      return 'Diffs are read from git today; a commit no longer in this repository cannot be opened.'
    case 'session':
      return data.viewed?.source === 'transcript'
        ? 'Read from Claude Code’s transcript: the monitor kept no record of it, so its cost, usage and machine figures are not known.'
        : 'Its figures as it last saved them.'
    case 'agents':
    case 'artifacts':
      return ''
  }
}

/** While a past session is shown: which one, what works differently here, and the way back. Nothing (an empty list) otherwise. */
export const sessionBanner = (data: PaneData, ui: Ui, act: Actions, place: SessionPlace): RenderElement[] => {
  const shown = data.viewed
  if (shown === null) {
    return []
  }
  const { Box, Text, Button } = ui
  const note = pastNote(data, place)
  return [
    <Box key={sessionBannerKey(place)} flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap} rowGap={data.space.row} alignItems="center">
        <Text color="suggestion" bold>
          {`Viewing a past session · ${sessionDate(shown.startedAt)}`}
        </Text>
        {shown.title !== '' && <Text dimColor>{oneLine(shown.title, 80)}</Text>}
        <Button key={sessionBackKey(place)} label="Back to this session" variant="primary" onPress={() => act.viewSession(null)} />
      </Box>
      {note !== '' && <Text dimColor>{note}</Text>}
    </Box>,
  ]
}

/** The picker and, while a past session is shown, its banner: for a tab or card with no toolbar of its own. */
export const sessionBars = (data: PaneData, ui: Ui, act: Actions, place: SessionPlace): RenderElement[] => {
  const shown = sessionPicker(data, ui, act, place)
  return [...(shown === null ? [] : [shown]), ...sessionBanner(data, ui, act, place)]
}
