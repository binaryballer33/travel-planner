// Resources: each process group under the session, live and in total, and
// the commands ranked by energy, CPU, network or memory, each list a card.
// Memory reads with its share of the Mac's RAM.

import type { RenderElement } from 'claude-code'

import type { CommandRecord, GroupSample, ResourceSort, Totals } from '../../types'
import {
  fmtBytes,
  fmtCpuSeconds,
  fmtDuration,
  fmtMemory,
  fmtPct,
  fmtWatts,
  meter,
  oneLine,
  statusTone,
  toneCpu,
  toneEnergy,
  toneMem,
  toneNetTotal,
  toneWatts,
  type Tone,
} from '../lib/format'
import { accessBadge, cardStack, energySum, energyText, picker, ROW_HIGHLIGHT, sectionCard, type Actions, type PaneData, type Ui } from './kit'

type Row = {
  key: string
  name: string
  tone: Tone
  cpuPct: number
  mem: number
  watts: number
  totals: Totals
  isLive: boolean
}

/** The Resources tab's cards: the process groups, and the commands ranked. */
export const GROUPS_CARD_KEY = 'card:resources:groups'
export const BOARD_CARD_KEY = 'card:resources:commands'

const sortValue = (row: { totals: Totals; mem: number }, sort: ResourceSort): number =>
  sort === 'energy' ? energySum(row.totals) : sort === 'cpu' ? row.totals.cpuS : sort === 'net' ? row.totals.netIn + row.totals.netOut : row.mem

/** The table's columns after the name; Mem is wide enough for its share of RAM (`1.21 GB (7.6%)`). */
const COLUMNS = [
  { title: 'CPU', width: 7 },
  { title: 'Mem', width: 16 },
  { title: 'Power', width: 9 },
  { title: 'Energy', width: 11 },
  { title: '↓ In', width: 10 },
  { title: '↑ Out', width: 10 },
  { title: 'Net time', width: 10 },
  { title: 'CPU time', width: 9 },
]

/** Cells a card takes from the body's width in the terminal: its border and padding on each side, and two to spare. */
const CARD_CELLS = 6

/** One row of the table; the whole session's in bold, set off by a band where the surface blends one. */
const resourceRow = (row: Row, data: PaneData, ui: Ui, nameWidth: number, isTotal = false): RenderElement => {
  const { Box, Text } = ui
  const cells: { text: string; tone: Tone }[] = [
    { text: row.isLive ? fmtPct(row.cpuPct) : '—', tone: toneCpu(row.cpuPct) },
    { text: row.mem > 0 ? fmtMemory(row.mem, data.memTotal) : '—', tone: toneMem(row.mem) },
    { text: row.isLive ? fmtWatts(row.watts) : '—', tone: toneWatts(row.watts) },
    { text: energyText(row.totals), tone: toneEnergy(energySum(row.totals)) },
    { text: fmtBytes(row.totals.netIn), tone: toneNetTotal(row.totals.netIn) },
    { text: fmtBytes(row.totals.netOut), tone: toneNetTotal(row.totals.netOut) },
    { text: fmtDuration(row.totals.netActiveS * 1000), tone: row.totals.netActiveS > 0 ? 'suggestion' : 'subtle' },
    { text: fmtCpuSeconds(row.totals.cpuS), tone: 'text' },
  ]
  return (
    <Box flexDirection="row" backgroundColor={isTotal && data.surface !== 'terminal' ? ROW_HIGHLIGHT : undefined}>
      <Box width={nameWidth} flexShrink={1} minWidth={0}>
        <Text color={row.tone} bold={isTotal}>
          {row.name}
        </Text>
      </Box>
      {cells.map((cell, index) => (
        <Box width={COLUMNS[index]?.width ?? 8} flexShrink={0} justifyContent="flex-end">
          <Text color={cell.tone} bold={isTotal}>
            {cell.text}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

const groupRow = (group: GroupSample): Row => ({
  key: group.id,
  name:
    group.kind === 'claude'
      ? 'Claude engine (API, web tools)'
      : group.kind === 'monitor'
        ? 'Session Monitor (this mod)'
        : group.kind === 'bash'
          ? `$ ${oneLine(group.label, 120)}`
          : group.label,
  tone: group.kind === 'claude' ? 'claude' : group.kind === 'service' ? 'suggestion' : group.kind === 'bash' ? 'warning' : 'inactive',
  cpuPct: group.cpuPct,
  mem: group.mem,
  watts: group.watts,
  totals: group.tot,
  isLive: true,
})

export const resourcesTab = (data: PaneData, ui: Ui, act: Actions): RenderElement => {
  const { Box, Text } = ui
  const live = data.live
  if (live === null) {
    return <Text dimColor>Loading…</Text>
  }
  const sort = data.ui.resourceSort
  const columnsWidth = COLUMNS.reduce((total, column) => total + column.width, 0)
  const nameWidth = Math.max(16, Math.min(44, data.columns - columnsWidth - CARD_CELLS))
  const groups = live.groups.filter(group => group.kind !== 'helper').map(groupRow)
  const helpers = live.groups.filter(group => group.kind === 'helper')
  const helperTotals: Totals = { ...live.shortLived }
  for (const helper of helpers) {
    helperTotals.cpuS += helper.tot.cpuS
    helperTotals.energyJ += helper.tot.energyJ
    helperTotals.energyEstJ += helper.tot.energyEstJ
    helperTotals.netIn += helper.tot.netIn
    helperTotals.netOut += helper.tot.netOut
    helperTotals.netActiveS += helper.tot.netActiveS
  }
  const rows: Row[] = [
    ...groups.sort((a, b) => sortValue(b, sort) - sortValue(a, sort)),
    {
      key: 'helpers',
      name: 'Short-lived helpers & quick commands',
      tone: 'inactive',
      cpuPct: helpers.reduce((total, helper) => total + helper.cpuPct, 0),
      mem: helpers.reduce((total, helper) => total + helper.mem, 0),
      watts: helpers.reduce((total, helper) => total + helper.watts, 0),
      totals: helperTotals,
      isLive: helpers.length > 0,
    },
  ]
  const s = live.session
  const totalRow: Row = { key: 'total', name: 'Whole session', tone: 'text', cpuPct: s.cpuPct, mem: s.mem, watts: s.watts, totals: s, isLive: true }
  const board = data.commands
    .filter(record => record.tool === 'Bash' && (record.metrics.isSampled || record.metrics.cpuS > 0))
    .map(record => ({ record, totals: record.metrics, mem: record.metrics.peakMem }))
    .sort((a, b) => sortValue(b, sort) - sortValue(a, sort))
    .slice(0, 12)
  const top = Math.max(1e-9, ...board.map(entry => sortValue(entry, sort)))
  const sorts: { value: ResourceSort; label: string }[] = [
    { value: 'energy', label: 'Energy' },
    { value: 'cpu', label: 'CPU time' },
    { value: 'net', label: 'Network' },
    { value: 'mem', label: 'Memory' },
  ]
  const sortLabel = sorts.find(one => one.value === sort)?.label ?? 'Energy'
  const valueText = (record: CommandRecord): string =>
    sort === 'energy'
      ? energyText(record.metrics)
      : sort === 'cpu'
        ? fmtCpuSeconds(record.metrics.cpuS)
        : sort === 'net'
          ? fmtBytes(record.metrics.netIn + record.metrics.netOut)
          : fmtMemory(record.metrics.peakMem, data.memTotal)
  return cardStack(ui, data, [
    <Box flexDirection="row" flexWrap="wrap" columnGap={data.space.gap} rowGap={data.space.row} alignItems="center">
      {picker(ui, 'sort', 'Sort by', sort, sorts, value => act.setResourceSort(value))}
      <Text dimColor>orders the process groups and the commands</Text>
    </Box>,
    sectionCard(ui, data, GROUPS_CARD_KEY, 'Process groups', `live, under this Claude session · by ${sortLabel.toLowerCase()}`, [
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Box width={nameWidth} flexShrink={1} minWidth={0}>
            <Text dimColor bold>
              Process group
            </Text>
          </Box>
          {COLUMNS.map(column => (
            <Box width={column.width} flexShrink={0} justifyContent="flex-end">
              <Text dimColor bold>
                {column.title}
              </Text>
            </Box>
          ))}
        </Box>
        {rows.map(row => resourceRow(row, data, ui, nameWidth))}
        {data.surface === 'terminal' && <Text dimColor>{'─'.repeat(Math.max(10, Math.min(160, nameWidth + columnsWidth, data.columns - CARD_CELLS)))}</Text>}
        {resourceRow(totalRow, data, ui, nameWidth, true)}
      </Box>,
      <Text dimColor>
        CPU and power are live rates; energy, network and times are totals. Net time is how long bytes were moving. Memory is what the
        group holds now, with its share of the Mac’s RAM. Energy is the macOS kernel’s per-process estimate (rusage energy); ≈ adds CPU
        time from processes that exited between samples. Network is per-process byte counts from nettop.
      </Text>,
    ]),
    sectionCard(ui, data, BOARD_CARD_KEY, `Commands by ${sortLabel.toLowerCase()}`, board.length === 0 ? 'none measured yet' : `top ${board.length}`, [
      board.length === 0 ? (
        <Text dimColor>Shell commands appear here once the sampler has measured them.</Text>
      ) : (
        <Box flexDirection="column">
          {board.map(entry => (
            <Box flexDirection="row" columnGap={data.space.gap}>
              <Box width={12} flexShrink={0}>
                <Text color={statusTone(entry.record.status)}>{meter(sortValue(entry, sort) / top, 10)}</Text>
              </Box>
              <Box width={16} flexShrink={0}>
                <Text bold>{valueText(entry.record)}</Text>
              </Box>
              {accessBadge(ui, entry.record.access)}
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Text>{oneLine(entry.record.title, 200)}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      ),
    ]),
  ])
}
