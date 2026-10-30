// What every tab shares: the element kit, the data and actions a drawing
// takes, and the small pieces (rows, sections, charts).

import type { Elements, RenderElement, RenderSurface, UiPressArgument } from 'claude-code'

import type {
  Access,
  AgentHistory,
  CacheView,
  CostBreakdown,
  AgentRecord,
  ComputeRange,
  ArtifactRecord,
  PromptRecord,
  StoredPrompt,
  BatteryView,
  CommandRecord,
  AgentRunStatus,
  CommandStatus,
  DiffView,
  FileChange,
  GitView,
  LiveMetrics,
  ModelUse,
  SessionSettings,
  Pulse,
  ServiceUse,
  SourceRecord,
  SpendView,
  TaskLabel,
  Totals,
  TouchedFile,
  UiState,
  UsageView,
} from '../../types'
// --- ports ---
import type { PortsView } from '../../types'
import type { ProcAction, ProcTarget } from '../lib/ports'
// --- end ports ---
// --- session history ---
import type { SessionEntry, SessionSnapshot } from '../../types'
// --- end session history ---
import { chartRoom, chartWidth, PANE_INSET_CH, type ChartSvg } from '../lib/charts'
import type { FileRow } from '../lib/files'
// --- file tree ---
import type { FilesMode, TreeView } from '../../types'
import type { TreePress } from '../lib/tree'
// --- end file tree ---
// --- explorer ---
import type { ExplorerPane, ExplorerPress } from '../lib/explorer'
// --- end explorer ---
import { accessLetter, accessTone, fmtEnergy, fmtPct, fmtTokens, fmtUsd, keyOf, oneLine, sparkline, toneUsd, type Tone } from '../lib/format'
import { PART_KINDS, partsTotal } from '../lib/spend'
import type { EffortLevel } from '../lib/effort'
import { fileIcon } from '../lib/icons'
import { ENGINE_APP } from '../lib/prompts'
import { OPEN_BAR, type RowHighlight, type RowPress, type RowProps, type RowSegment } from './row'
// --- ui polish ---
import { mdText } from '../lib/format'
// --- ui polish ---
import type { TitleLinkProps } from './title-link'
import type { EffortSliderProps } from './effort-slider'
import type { TabBarProps } from './tab-bar'

type Desk = Elements['desktop']

/** The elements every surface but mobile draws, with the optional ones marked. */
export type Ui = {
  Box: Desk['Box']
  Text: Desk['Text']
  Button: Desk['Button']
  Code: Desk['Code']
  Link: Desk['Link']
  // --- ui polish ---
  /**
   * Section titles as headings, where a surface draws a heading larger than
   * text. Left out on the terminal, which draws one no larger, only bold and
   * without the accent color a title has there.
   */
  Markdown?: Desk['Markdown']
  // --- ui polish ---
  Select?: Desk['Select']
  Input?: Desk['Input']
  Svg?: Desk['Svg']
  /** A list row drawn as one clickable region, where the surface draws a `Client`. */
  Row?: (key: string, props: RowProps) => RenderElement
  /** A title that opens what it names on a click (a prompt's on Overview), where the surface draws a `Client`. */
  TitleLink?: (key: string, props: TitleLinkProps) => RenderElement
  /** The effort slider, where the surface draws a `Client`. */
  EffortSlider?: (key: string, props: EffortSliderProps) => RenderElement
  /** The tab bar as a `Client` region (view/tab-bar.tsx), where the desktop app draws the pane; plain buttons elsewhere. */
  TabBar?: (key: string, props: TabBarProps) => RenderElement
}

/** What a press or a pick asks the hooks module to do. */
export type Actions = {
  // --- file tree ---
  /** The Files tab's list: the session's file activity, or the working folder as a tree. */
  setFilesMode: (mode: FilesMode) => void
  /** A press on a tree row: a folder opens or closes, a file shows its text, a hidden group opens. */
  pressTree: (press: TreePress) => void
  refreshTree: () => void
  collapseTree: () => void
  /** `open <path>`: the file in its app, a folder in Finder. */
  openInApp: (path: string) => void
  /** `open -R <path>`: Finder with the entry selected. */
  revealInFinder: (path: string) => void
  /** Shows a file the session sent you in Finder (only paths in the Artifacts list). */
  revealArtifact: (id: string) => void
  // --- end file tree ---
  // --- explorer ---
  /** A press on an Explorer row: a folder opens or closes, a file shows or hides its text; either is selected. */
  pressExplorer: (press: ExplorerPress) => void
  /** Opens the form for a new file or folder in `dir`: absent, the selected folder (or the selected file's, or the root). */
  explorerNew: (kind: 'file' | 'folder', dir?: string) => void
  /** Opens the form for a new name of `path`. */
  explorerRename: (path: string) => void
  /** The form's text as typed; kept outside the state, so typing does not redraw the pane. */
  explorerFormInput: (text: string) => void
  /** Creates or renames with the form's text: `text` from its Enter, else as last typed. */
  explorerSubmit: (text?: string) => void
  explorerCancel: () => void
  /** Delete: the first press arms it, a second within EXPLORER_ARM_MS moves the entry to the Trash. */
  explorerDelete: (path: string) => void
  /** Opens a file's text in the editor. */
  explorerEdit: (path: string) => void
  /** The editor's text as typed; kept outside the state, as the form's is. */
  explorerEditInput: (text: string) => void
  /** Writes the editor's text: `text` from its Enter, else as last typed. */
  explorerSave: (text?: string) => void
  /** Closes the editor; with unsaved changes, on a second press. */
  explorerCloseEdit: () => void
  explorerRefresh: () => void
  explorerCollapse: () => void
  /** `open <path>` (its app; Finder for a folder), or with `isReveal` `open -R` (Finder, the entry selected). */
  explorerOpen: (path: string, isReveal: boolean) => void
  // --- end explorer ---
  setTab: (tab: UiState['tab']) => void
  // --- session history ---
  /** Shows a past session of the project in place of this one (its id), or this session again (null). */
  viewSession: (id: string | null) => void
  // --- end session history ---
  toggleCommand: (id: string) => void
  // --- agents ---
  /** Opens or closes an agent's row on the Agents tab. */
  toggleAgent: (id: string) => void
  // --- end agents ---
  toggleFullOutput: (id: string) => void
  setScope: (scope: UiState['commandScope']) => void
  setStatusFilter: (filter: UiState['statusFilter']) => void
  setAccessFilter: (filter: UiState['accessFilter']) => void
  setFilterText: (text: string) => void
  showMore: () => void
  /** Shows the Prompts tab's page of this session's prompts that starts at `from` (newest first), and scrolls to its first card. */
  pagePrompts: (from: number) => void
  /** Shows the page of the project's other sessions' prompts that starts at `from`. */
  pageEarlier: (from: number) => void
  /** Shows the page of the open agent's calls that starts at `from` (newest first), and scrolls to the list. */
  pageAgentCalls: (agentId: string, from: number) => void
  /** Shows the cards under a parent agent (a workflow's agents), folded away until then, or folds them away again. */
  toggleAgentKids: (agentId: string) => void
  toggleCommit: (key: string) => void
  setCommitScope: (scope: GitView['scope']) => void
  openFile: (commitKey: string, file: FileChange) => void
  openFileRow: (row: FileRow) => void
  setFileFilter: (filter: UiState['fileFilter']) => void
  setSourceFilter: (filter: UiState['sourceFilter']) => void
  setDiffMode: (mode: DiffView['mode']) => void
  closeDiff: () => void
  /** Closes everything open on the pane: a call, an output in full, a prompt, a commit, an agent, a task's sources, a file's diff. */
  closeOpen: () => void
  setResourceSort: (sort: UiState['resourceSort']) => void
  toggleAlerts: () => void
  refreshGit: () => void
  copy: (text: string, press: UiPressArgument) => void
  // --- sources by task ---
  setSourceView: (view: UiState['sourceView']) => void
  toggleTask: (id: string) => void
  toggleEmptyTasks: () => void
  // --- end sources by task ---
  // --- ui polish ---
  /** The compact button: the first press arms it, a second within the window compacts. */
  compact: () => void
  // --- ui polish ---
  // --- ports ---
  /** Opens or closes a Ports tab row (`pt:…` keys), or the Other apps group. */
  togglePortsRow: (key: string) => void
  /** Turns a dev server on or off. */
  setDevServer: (port: number, isOn: boolean) => void
  /** Turns a dev server off and on again with its current command. */
  restartDevServer: (port: number) => void
  /** Opens or closes a Commands group (one prompt's calls). */
  toggleGroup: (id: string) => void
  /**
   * Brings a prompt of this session into view: scrolls the conversation where
   * the engine can (the terminal's fullscreen transcript), else copies the
   * prompt's opening for the app's own Find (⌘F). A Button's press only: the
   * engine scrolls for the person's own press, so the press returns this.
   */
  jumpToPrompt: (id: string, press: UiPressArgument) => Promise<void>
  /**
   * Lets Find press its keys in the desktop app: has macOS list the app it
   * holds responsible under Accessibility, opens that list in System Settings
   * and copies the app's path, then watches for the switch.
   */
  allowFindKeys: (press: UiPressArgument) => void
  /** The Commands tab with only this prompt's group open. */
  showPromptCommands: (taskId: string) => void
  /** Shows a Prompts card's whole prompt, or its excerpt again. */
  toggleOpenPrompt: (id: string) => void
  /** The Prompts tab, scrolled to this prompt's card, which is edged in the accent until the next click. */
  revealPrompt: (id: string) => void
  /** Picks a model on the card; nothing changes until Apply. */
  setModel: (value: string) => void
  /** Picks an effort on the card; nothing changes until Apply. */
  setEffort: (level: EffortLevel) => void
  /** Applies what was picked: `/model`, then `/effort`. */
  applySettings: () => void
  /** What the Compute tab's charts span. */
  setComputeRange: (range: ComputeRange) => void
  /** Suspend, resume, kill (two presses) or force kill (two presses) a process. */
  procAction: (target: ProcTarget, action: ProcAction) => void
  refreshPorts: () => void
  /** Reads the session's prompt cache from its transcripts again, now. */
  refreshCache: () => void
  // --- end ports ---
}

/**
 * What a drawing draws from. Each tab reads only the values it shows, so a
 * tab is drawn again only when they change: `live` and `usage` are null on
 * the tabs that do not read them.
 */
export type PaneData = {
  // --- file tree ---
  /** The folder tree; read (and so drawn again on its changes) only on the Files tab. */
  tree: TreeView | null
  // --- end file tree ---
  // --- explorer ---
  /** The Explorer tab's tree and what is typed in it; read (and so drawn again on its changes) only on that tab. */
  explorer: ExplorerPane | null
  // --- end explorer ---
  surface: RenderSurface
  columns: number
  now: number
  ui: UiState
  live: LiveMetrics | null
  commands: readonly CommandRecord[]
  // --- agents ---
  /** The session's agents and workflows; empty on the tabs that do not draw them. */
  agents: readonly AgentRecord[]
  /** The open agent's calls read from its own transcript; null on the tabs that do not draw them. */
  agentHistory: AgentHistory | null
  /** The session's prompt cache as its transcripts tell it; null on the tabs that do not draw it. */
  cache: CacheView | null
  // --- end agents ---
  git: GitView
  touched: readonly TouchedFile[]
  sources: readonly SourceRecord[]
  services: readonly ServiceUse[]
  diff: DiffView | null
  usage: UsageView | null
  output: string | null
  pulse: Pulse | null
  battery: BatteryView | null
  models: readonly ModelUse[]
  /** The model and effort Overview's controls show and set. */
  settings: SessionSettings
  /** What the session's requests cost, for a command's or an agent's share; null on tabs that do not show it. */
  spend: SpendView | null
  /** The pages published and files sent; empty off Overview. */
  artifacts: readonly ArtifactRecord[]
  /** Your prompts this session (Commands and Prompts tabs), the project's history (Prompts tab), and this session's id. */
  prompts: readonly PromptRecord[]
  projectPrompts: readonly StoredPrompt[]
  sessionId: string
  // --- session history ---
  /** This project's past sessions for the picker, the newest first; empty on tabs without one. */
  sessions: readonly SessionEntry[]
  /**
   * The past session the picker shows, settled for viewing; null while this
   * session's own figures show. On the Prompts, Agents, Files, Commits and
   * Commands tabs the values above are already its; Overview's Session and
   * Artifacts cards draw it through `viewedData`.
   */
  viewed: SessionSnapshot | null
  // --- end session history ---
  /** The Mac's RAM in bytes, for memory's share of it; 0 while not known. */
  memTotal: number
  space: Space
  // --- sources by task ---
  /** The tasks sources are attributed to; read only by the Sources tab's By task view. */
  tasks: readonly TaskLabel[]
  // --- end sources by task ---
  // --- ports ---
  /** The Ports tab's listing; null on the other tabs. */
  ports: PortsView | null
  // --- end ports ---
}

/** Gaps in cells: roomier on surfaces that draw with a proportional font. */
export type Space = {
  /** Between items in a row. */
  gap: number
  /** Between wrapped lines of a row, and between list rows. */
  row: number
  /** Between sections. */
  section: number
}

export const spaceFor = (surface: PaneData['surface']): Space =>
  surface === 'terminal' ? { gap: 3, row: 0, section: 1 } : { gap: 4, row: 1, section: 3 }

/** One cell of a row; unset style fields are none. */
export const seg = (text: string, style: Partial<Omit<RowSegment, 'text'>> = {}): RowSegment => ({
  text,
  color: '',
  bold: false,
  dim: false,
  width: 0,
  grow: false,
  role: '',
  ...style,
})

/** A file's icon by its type, as a row's segment: a badge in its language's colour, or an emoji. */
export const iconSeg = (path: string): RowSegment => {
  const icon = fileIcon(path)
  return seg(icon.glyph, { color: icon.color, bold: icon.color !== '' })
}

// --- ui polish ---
/**
 * How a row lights under the pointer, and stays lit while open: a soft gray
 * that reads on light and dark themes where the surface blends one; on the
 * terminal, which may not, the title inverts instead.
 */
export const ROW_HIGHLIGHT = '#7f7f7f33'

export const highlightFor = (surface: PaneData['surface']): RowHighlight =>
  surface === 'terminal' ? { background: '', isTitleInverse: true } : { background: ROW_HIGHLIGHT, isTitleInverse: false }
// --- ui polish ---

/** The colour a command's or a prompt's title is drawn in, so it stands out from the figures around it: a link blue that reads on light and dark themes. */
export const TITLE_COLOR = '#58a6ff'

/** A row's title cell; `color` ('' for the text colour) paints it, as TITLE_COLOR does a command's. */
export const titleSeg = (text: string, isOpen: boolean, color = ''): RowSegment =>
  seg(oneLine(text, 400), { bold: isOpen, grow: true, role: 'title', color })

/**
 * The Box a list row is drawn in, on every surface: its clickable line (a
 * `Client` region, or the title button) and its second line. Keyed apart
 * from the row's own key, which names the region or the button.
 */
export const rowBoxKey = (key: string): string => `row:${key}`

/**
 * A list row that opens on a click along its line: one `Client` region where
 * the surface draws one (terminal, desktop), which moves its stats under the
 * title when the line is too narrow for them; elsewhere a title button beside
 * plain text. Its second line (a command's exact text) is plain text under
 * the region, so it can be selected and copied. The row's Box lights both
 * lines under the pointer where the surface blends a background, and stays
 * lit while open; the terminal inverts the title instead. An open row leads
 * with an accent bar.
 */
/** A run of a row's second line in a colour of its own ('' draws it dim). */
export type LineRun = { text: string; color: string; bold: boolean }

export const rowLine = (
  ui: Ui,
  data: PaneData,
  key: string,
  press: RowPress,
  segments: readonly RowSegment[],
  onPress: () => void,
  isOpen = false,
  subtitle: string | readonly LineRun[] = '',
): RenderElement => {
  const { Box, Text, Button } = ui
  const highlight = highlightFor(data.surface)
  const line = typeof subtitle === 'string' ? oneLine(subtitle, 400) : subtitle.map(run => run.text).join('')
  const lit = highlight.background
  const rowBox = (children: readonly RenderElement[]): RenderElement => (
    <Box key={rowBoxKey(key)} flexDirection="column" backgroundColor={isOpen && lit !== '' ? lit : undefined} hover={lit === '' ? undefined : { backgroundColor: lit }}>
      {children}
    </Box>
  )
  const second =
    line === ''
      ? []
      : [
          <Box marginLeft={2}>
            {typeof subtitle === 'string' ? (
              <Text dimColor>{line}</Text>
            ) : (
              <Text>
                {subtitle.map(run => (
                  <Text color={run.color === '' ? undefined : run.color} bold={run.bold} dimColor={run.color === ''}>
                    {run.text}
                  </Text>
                ))}
              </Text>
            )}
          </Box>,
        ]
  if (ui.Row !== undefined) {
    // The Box lights the row, so the region keeps only the terminal's inverted title.
    return rowBox([ui.Row(key, { press, segments: [...segments], gap: data.space.gap, isOpen, highlight: { background: '', isTitleInverse: highlight.isTitleInverse } }), ...second])
  }
  return rowBox([
    <Box flexDirection="row" alignItems="center">
      <Box flexShrink={0} width={1} marginRight={1}>
        <Text color="claude">{isOpen ? OPEN_BAR : ' '}</Text>
      </Box>
      <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} columnGap={data.space.gap} alignItems="center">
        {segments.map(segment =>
          segment.role === 'title' ? (
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Button key={key} label={oneLine(segment.text, Math.max(24, data.columns - 50))} plain onPress={() => onPress()} />
            </Box>
          ) : (
            <Box flexShrink={0} width={segment.width > 0 ? segment.width : undefined}>
              <Text color={segment.color === '' ? undefined : segment.color} bold={segment.bold} dimColor={segment.dim}>
                {segment.text}
              </Text>
            </Box>
          ),
        )}
      </Box>
    </Box>,
    ...second,
  ])
}

export const energySum = (totals: Totals): number => totals.energyJ + totals.energyEstJ

export const energyText = (totals: Totals): string => `${totals.energyEstJ > 0.0005 ? '≈' : ''}${fmtEnergy(energySum(totals))}`

export const accessBadge = (ui: Ui, access: Access): RenderElement => {
  const { Text } = ui
  return (
    <Text color={accessTone(access)} bold>
      {accessLetter(access)}
    </Text>
  )
}

export const label = (ui: Ui, text: string, width: number): RenderElement => {
  const { Box, Text } = ui
  return (
    <Box width={width} flexShrink={0}>
      <Text dimColor>{text}</Text>
    </Box>
  )
}

/**
 * A titled block. The title is a markdown heading where the surface draws one
 * larger than body text (a tree cannot set a font size); the dim aside sits
 * beside it, or under it where the heading takes the line.
 */
export const section = (ui: Ui, title: string, aside: string, children: readonly RenderElement[]): RenderElement => {
  const { Box, Text } = ui
  return (
    <Box flexDirection="column" rowGap={0}>
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} alignItems="center">
        {heading(ui, title)}
        {aside !== '' && <Text dimColor>{aside}</Text>}
      </Box>
      {children}
    </Box>
  )
}

/** A title within a section: a smaller markdown heading where the kit has one; bold text in the terminal. */
export const subheading = (ui: Ui, title: string): RenderElement => {
  const { Markdown, Text } = ui
  return Markdown === undefined ? <Text bold>{oneLine(title, 200)}</Text> : <Markdown text={`### ${mdText(title, 200)}`} />
}

/** A colour for memory in charts and keys. */
export const MEM = '#10b981'

// --- ui polish ---
/** A title: a markdown heading, drawn larger, where the kit has one; bold accent text in the terminal. */
export const heading = (ui: Ui, title: string): RenderElement => {
  const { Markdown, Text } = ui
  if (Markdown === undefined) {
    return (
      <Text bold color="claude">
        {oneLine(title, 200)}
      </Text>
    )
  }
  return <Markdown text={`## ${mdText(title, 200)}`} />
}
// --- ui polish ---

/** How tall `chart` draws. */
const AREA_HEIGHT = 56

/** An SVG area chart of up to two series, `width` by `height` px, for surfaces that draw Svg; it stretches to the box it is drawn in. */
export const areaChart = (series: readonly { values: readonly number[]; color: string }[], width: number, height: number): ChartSvg => {
  const count = Math.max(2, ...series.map(one => one.values.length))
  const top = Math.max(1e-9, ...series.flatMap(one => one.values))
  const paths = series
    .map(({ values, color }) => {
      if (values.length < 2) {
        return ''
      }
      const step = width / (count - 1)
      const offset = (count - values.length) * step
      const points = values.map((value, index) => {
        const x = offset + index * step
        const y = height - 2 - (Math.max(0, value) / top) * (height - 6)
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      const first = points[0]?.split(',')[0] ?? '0'
      const last = points[points.length - 1]?.split(',')[0] ?? `${width}`
      return (
        `<path d="M${first},${height} L${points.join(' L')} L${last},${height} Z" fill="${color}" fill-opacity="0.18"/>` +
        `<polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>`
      )
    })
    .join('')
  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" width="${width}" height="${height}">${paths}</svg>`,
    width,
    height,
  }
}

/**
 * A chart: Svg where the surface draws it, block characters elsewhere. The
 * Svg is drawn as wide as the pane's charts and given its size up front, as
 * every chart is (see `chartSize`); in a narrower box it stretches to fit.
 */
export const chart = (
  data: Pick<PaneData, 'surface' | 'columns'>,
  ui: Pick<Ui, 'Box' | 'Text' | 'Svg'>,
  alt: string,
  series: readonly { values: readonly number[]; color: string; tone: Tone }[],
): RenderElement => {
  const { Box, Text, Svg } = ui
  if (Svg !== undefined && data.surface !== 'terminal') {
    const drawn = areaChart(series, chartWidth(chartRoom(data.columns, PANE_INSET_CH)), AREA_HEIGHT)
    return <Svg source={drawn.source} alt={alt} width={drawn.width} height={drawn.height} />
  }
  const width = Math.max(10, Math.min(120, data.columns - 14))
  return (
    <Box flexDirection="column">
      {series.map(one => (
        <Text color={one.tone}>{sparkline(one.values, width)}</Text>
      ))}
    </Box>
  )
}

/** A Select where the surface draws one, a row of buttons where it does not (mobile). */
export const picker = <V extends string>(
  ui: Ui,
  key: string,
  text: string,
  value: V,
  options: readonly { value: V; label: string }[],
  onPick: (value: V) => void,
): RenderElement => {
  const { Box, Button, Select } = ui
  if (Select !== undefined) {
    return (
      <Select
        key={key}
        label={text}
        value={value}
        options={options}
        onSelect={picked => {
          const option = options.find(one => one.value === picked)
          if (option !== undefined) {
            onPick(option.value)
          }
        }}
      />
    )
  }
  return (
    <Box flexDirection="row" columnGap={2} rowGap={1}>
      {options.map(option => (
        <Button
          key={`${key}:${option.value}`}
          label={option.label}
          variant={option.value === value ? 'primary' : 'secondary'}
          onPress={() => onPick(option.value)}
        />
      ))}
    </Box>
  )
}

export const NET_IN = '#3b82f6'
export const NET_OUT = '#a855f7'
export const CPU = '#f59e0b'
export const POWER = '#ef4444'

// ------------------------------------------------------------------------- //
// Cards: the look of the Prompts and Compute tabs, for every tab
// ------------------------------------------------------------------------- //

/** A card's soft background, where the surface blends a translucent one (not the terminal). */
export const CARD_BACKGROUND = '#7f7f7f12'

export type CardOptions = {
  /** The border's colour: `subtle` at rest; a tone flags the card (`warning` while it runs, `error` when it failed). */
  tone?: Tone
  /** Less room inside, for a card in a long list. */
  isCompact?: boolean
  /** Drawn at the header's right end: the card's own button. */
  action?: RenderElement
}

/**
 * A card: a rounded box, softly filled where the surface blends it, with
 * room inside and between its lines. `key` must be unique among its siblings
 * (it also scopes `hover` styles beneath it).
 */
export const card = (ui: Ui, data: PaneData, key: string, children: readonly RenderElement[], options: CardOptions = {}): RenderElement => {
  const { Box } = ui
  const isTerminal = data.surface === 'terminal'
  return (
    <Box
      key={key}
      flexDirection="column"
      borderStyle="round"
      borderColor={options.tone ?? 'subtle'}
      backgroundColor={isTerminal ? undefined : CARD_BACKGROUND}
      paddingX={isTerminal ? 1 : options.isCompact === true ? 2 : 3}
      paddingY={isTerminal || options.isCompact === true ? 0 : 1}
      rowGap={isTerminal ? 0 : 1}
    >
      {children}
    </Box>
  )
}

/** A call's card's background in the desktop app: a shade above its section's, so the call stands out from it. */
export const CALL_BACKGROUND = '#7f7f7f1f'

/** A call's card's edge in the desktop app when it finished well: the title blue, faint. */
export const CALL_EDGE = '#58a6ff59'

/** A call's card's key. */
export const callCardKey = (id: string): string => `callcard:${keyOf(id)}`

/** A call's card's edge: red when it failed, amber while it runs, grey when stopped, else the faint title blue (the terminal's quiet grey). */
export const callEdge = (status: CommandStatus, surface: PaneData['surface']): string =>
  status === 'error'
    ? 'error'
    : status === 'running' || status === 'background'
      ? 'warning'
      : status === 'denied'
        ? 'inactive'
        : surface === 'terminal'
          ? 'subtle'
          : CALL_EDGE

/**
 * One call as a card of its own, so each stands apart from the next: edged
 * in its status's colour, a shade above its section, with room inside.
 */
export const callCard = (ui: Ui, data: PaneData, id: string, status: CommandStatus, children: readonly RenderElement[]): RenderElement =>
  itemCard(ui, data, callCardKey(id), callEdge(status, data.surface), children)

/** An agent's card's key on Overview. */
export const agentCardKeyOf = (id: string): string => `ovagent:${keyOf(id)}`

/** An agent's card's edge: amber while it works, red when it failed, grey when stopped, else the faint title blue (the terminal's quiet grey). */
export const agentEdge = (status: AgentRunStatus, surface: PaneData['surface']): string =>
  status === 'failed'
    ? 'error'
    : status === 'killed'
      ? 'inactive'
      : status === 'completed'
        ? surface === 'terminal'
          ? 'subtle'
          : CALL_EDGE
        : 'warning'

/** One agent as a card of its own on Overview, edged by its status as a call's is. */
export const agentItemCard = (ui: Ui, data: PaneData, id: string, status: AgentRunStatus, children: readonly RenderElement[]): RenderElement =>
  itemCard(ui, data, agentCardKeyOf(id), agentEdge(status, data.surface), children)

/** An agent's card's key on the Agents tab. */
export const agentItemKey = (id: string): string => `agentitem:${keyOf(id)}`

/** A parent agent's card's background in the desktop app (a workflow's, one that started agents or shells): a purple shade, set apart from its children's grey. */
export const PARENT_BACKGROUND = '#a371f71f'

/** A parent agent's card's edge: the workflow purple, red when it failed, grey when stopped, so it stands apart from its children's. */
export const parentEdge = (status: AgentRunStatus): string => (status === 'failed' ? 'error' : status === 'killed' ? 'inactive' : 'merged')

/**
 * One agent as a card of its own on the Agents tab: its row, and its details
 * while open, edged by its status as a call's is; a parent's (`isParent`)
 * edged and shaded apart from the cards under it.
 */
export const agentTabCard = (ui: Ui, data: PaneData, id: string, status: AgentRunStatus, children: readonly RenderElement[], isParent = false): RenderElement =>
  itemCard(ui, data, agentItemKey(id), isParent ? parentEdge(status) : agentEdge(status, data.surface), children, isParent ? PARENT_BACKGROUND : CALL_BACKGROUND)

/** One item of a list as a card: edged in `edge`, a shade above its section, with room inside. */
const itemCard = (ui: Ui, data: PaneData, key: string, edge: string, children: readonly RenderElement[], background: string = CALL_BACKGROUND): RenderElement => {
  const { Box } = ui
  const isTerminal = data.surface === 'terminal'
  return (
    <Box
      key={key}
      flexDirection="column"
      borderStyle="round"
      borderColor={edge}
      backgroundColor={isTerminal ? undefined : background}
      paddingX={isTerminal ? 1 : 2}
      paddingY={isTerminal ? 0 : 1}
      rowGap={data.space.row}
    >
      {children}
    </Box>
  )
}

/** Cards one under another, with room between them. */
export const cardStack = (ui: Ui, data: PaneData, cards: readonly RenderElement[]): RenderElement => {
  const { Box } = ui
  return (
    <Box flexDirection="column" rowGap={data.surface === 'terminal' ? 1 : 2}>
      {cards}
    </Box>
  )
}

/** A section drawn as a card: its title and dim aside on top, then what it holds. */
export const sectionCard = (
  ui: Ui,
  data: PaneData,
  key: string,
  title: string,
  aside: string,
  children: readonly RenderElement[],
  options: CardOptions = {},
): RenderElement => {
  const { Box, Text } = ui
  return card(
    ui,
    data,
    key,
    [
      <Box flexDirection="row" columnGap={2} alignItems="center" justifyContent="space-between">
        <Box flexDirection="row" flexWrap="wrap" columnGap={2} alignItems="center" flexGrow={1} flexShrink={1} minWidth={0}>
          {heading(ui, title)}
          {aside !== '' && <Text dimColor>{aside}</Text>}
        </Box>
        {options.action}
      </Box>,
      ...children,
    ],
    options,
  )
}

/** What each kind of token is called in a cost breakdown. */
const PART_NAMES: Readonly<Record<keyof CostBreakdown, string>> = {
  input: 'Input tokens',
  cacheRead: 'Cache reads',
  cacheWrite5m: 'Cache writes (kept 5 min)',
  cacheWrite1h: 'Cache writes (kept 1 hour)',
  output: 'Output tokens',
}

/**
 * A cost broken down by the kind of token, one line each: its name, its
 * tokens, what they cost and their share of it; input and output always,
 * the cache's kinds where there were any; then the total. `caption` says
 * whose cost it is.
 */
export const costBreakdown = (ui: Ui, data: PaneData, key: string, parts: CostBreakdown, caption: string): RenderElement => {
  const { Box, Text } = ui
  const total = partsTotal(parts)
  const line = (name: string, tokens: number, usd: number, isTotal: boolean): RenderElement => (
    <Box flexDirection="row" columnGap={data.space.gap}>
      <Box width={26} flexShrink={0}>
        <Text bold={isTotal} dimColor={!isTotal}>
          {name}
        </Text>
      </Box>
      <Box width={7} flexShrink={0} justifyContent="flex-end">
        <Text bold={isTotal}>{fmtTokens(tokens)}</Text>
      </Box>
      <Box width={9} flexShrink={0} justifyContent="flex-end">
        <Text bold color={toneUsd(usd)}>
          {fmtUsd(usd)}
        </Text>
      </Box>
      {!isTotal && <Text dimColor>{total.usd > 0 ? fmtPct((usd / total.usd) * 100) : ''}</Text>}
    </Box>
  )
  return (
    <Box key={key} flexDirection="column">
      <Text>
        <Text bold>Cost breakdown</Text>
        <Text dimColor> · {caption}</Text>
      </Text>
      {PART_KINDS.filter(kind => kind === 'input' || kind === 'output' || parts[kind].tokens > 0).map(kind => line(PART_NAMES[kind], parts[kind].tokens, parts[kind].usd, false))}
      {line('Total', total.tokens, total.usd, true)}
    </Box>
  )
}

/** A figure with its name above it, for a row of them in a card. */
export const figure = (ui: Ui, data: PaneData, name: string, value: string, tone?: Tone): RenderElement => {
  const { Box, Text } = ui
  return (
    <Box flexDirection="column" flexShrink={0} minWidth={data.surface === 'terminal' ? 12 : 16}>
      <Text dimColor>{name}</Text>
      <Text bold color={tone}>
        {value}
      </Text>
    </Box>
  )
}

/** A row of figures that wraps, with room between them. */
export const figureRow = (ui: Ui, data: PaneData, figures: readonly RenderElement[]): RenderElement => {
  const { Box } = ui
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap} rowGap={1}>
      {figures}
    </Box>
  )
}

/**
 * What the button that brings a prompt into view is called. Only the
 * terminal's fullscreen transcript can be scrolled by a plugin; elsewhere (the
 * desktop app) it copies the prompt's opening for the app's Find (⌘F).
 */
export const jumpLabel = (surface: RenderSurface, isShort = false): string =>
  surface === 'terminal' ? (isShort ? '↗ Jump' : '↗ Jump to prompt') : isShort ? '⌕ Find' : '⌕ Find in conversation'

/** The Prompts tab's offer to let Find press its keys: its card's key and its button's. */
export const FIND_ACCESS_CARD = 'card:find:access'
export const FIND_ALLOW_KEY = 'find:allow'

/**
 * On the desktop, while macOS refuses Find's keystrokes: which app to switch
 * on under Privacy & Security → Accessibility (the engine, “Claude Code”, not
 * Claude), and a button that opens that list. Null elsewhere, and once allowed.
 */
export const findAccessCard = (data: PaneData, ui: Ui, act: Actions): RenderElement | null => {
  const access = data.ui.findAccess
  if (data.surface !== 'desktop' || access === undefined || access.isAllowed) {
    return null
  }
  const { Box, Text, Button } = ui
  const name = access.app?.name ?? ENGINE_APP
  const why = name === ENGINE_APP ? 'That is the engine Claude runs, which macOS holds responsible for the keys, not Claude itself.' : 'macOS holds that app responsible for the keys.'
  return card(
    ui,
    data,
    FIND_ACCESS_CARD,
    [
      <Text bold>{`${jumpLabel(data.surface)} only copies a prompt's opening for now`}</Text>,
      <Text dimColor>{`To have it press ⌘F and paste for you, switch on “${name}” in System Settings → Privacy & Security → Accessibility. ${why}`}</Text>,
      <Box flexDirection="row" columnGap={data.space.gap}>
        <Button key={FIND_ALLOW_KEY} label="Allow in System Settings…" variant="primary" onPress={press => act.allowFindKeys(press)} />
      </Box>,
    ],
    { tone: 'warning', isCompact: true },
  )
}

// ------------------------------------------------------------------------- //
// Cards on Overview, Files, Commits, Sources, Resources and Ports
// ------------------------------------------------------------------------- //

/**
 * A figure with a dim note under its value (what it is out of, or what it
 * came from), as Compute's stat cards have. A string value is drawn bold in
 * `tone`; a Text of several tones is drawn as given.
 */
export const notedFigure = (ui: Ui, data: PaneData, name: string, value: string | RenderElement, note: string, tone?: Tone): RenderElement => {
  const { Box, Text } = ui
  return (
    <Box flexDirection="column" flexShrink={0} minWidth={data.surface === 'terminal' ? 12 : 16}>
      <Text dimColor>{name}</Text>
      {typeof value === 'string' ? (
        <Text bold color={tone}>
          {value}
        </Text>
      ) : (
        value
      )}
      {note !== '' && <Text dimColor>{note}</Text>}
    </Box>
  )
}

/** How far an opened row's detail card sits in from the row, in cells: past the row's open bar. */
export const DETAIL_INDENT = 2

/**
 * What an opened row shows (a commit, a task, a process) as a compact card,
 * set in under the row, with a line's room above and below it where the
 * surface spaces its rows.
 */
export const rowDetailCard = (ui: Ui, data: PaneData, key: string, children: readonly RenderElement[], tone?: Tone): RenderElement => {
  const { Box } = ui
  return (
    <Box flexDirection="column" marginLeft={DETAIL_INDENT} marginY={data.space.row}>
      {card(ui, data, key, children, { tone, isCompact: true })}
    </Box>
  )
}

// ------------------------------------------------------------------------- //
// Panels: the parts of an opened row's card, each in an accent of its own
// ------------------------------------------------------------------------- //

/**
 * A titled panel inside a card (an opened call's Flow, its Context & cost):
 * a compact card edged and headed in its own accent, so the parts of the card
 * read apart. `key` must be unique among its siblings.
 */
export const panel = (ui: Ui, data: PaneData, key: string, title: string, accent: Tone, children: readonly RenderElement[]): RenderElement => {
  const { Text } = ui
  return card(
    ui,
    data,
    key,
    [
      <Text bold color={accent}>
        {title}
      </Text>,
      ...children,
    ],
    { tone: accent, isCompact: true },
  )
}
