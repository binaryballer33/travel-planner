// How a tool call fits the flow of its loop: the calls whose outputs Claude
// had read when it made the call, when Claude read the call's own output and
// what it said, and the calls it made next, with the bits of this output
// they reused. Pure: register.tsx feeds the events.

import type { CommandFlow, CommandRecord, FlowLink } from '../../types'
import { oneLine } from './format'

/** How many links a call keeps each way, and how much of what Claude said. */
export const MAX_LINKS = 8
const SAID_CHARS = 300
const MAX_USES = 3
/** How much of an output is searched for reusable bits. */
const SCAN_CHARS = 40_000

/** Paths, file names, identifiers and long numbers: the bits of an output a later call could reuse. */
const CANDIDATES = /(?:[\w.-]*\/)+[\w.-]+|\b[\w-]+\.[A-Za-z]{1,6}\b|\b[A-Za-z_][A-Za-z0-9_]{5,}\b|\b\d{3,}\b/g

/** Words too common to count as reuse. */
const COMMON = new Set(['return', 'import', 'export', 'const', 'function', 'string', 'number', 'boolean', 'undefined', 'Promise', 'result', 'value'])

/**
 * The bits of an earlier call's output that a later call's input repeats,
 * longest first; bits the earlier call's own input already held (a grep's
 * pattern found again in its matches) do not count.
 */
export const usesOf = (output: string, laterInput: string, earlierInput: string): string[] => {
  const found = new Set<string>()
  for (const match of output.slice(0, SCAN_CHARS).matchAll(CANDIDATES)) {
    const bit = match[0]
    if (bit.length >= 4 && !COMMON.has(bit) && !earlierInput.includes(bit) && laterInput.includes(bit)) {
      found.add(bit)
    }
  }
  // A path's file name is found again inside the path: keep the longer one.
  const bits = [...found].sort((a, b) => b.length - a.length)
  return bits.filter((bit, index) => !bits.slice(0, index).some(longer => longer.includes(bit))).slice(0, MAX_USES)
}

/** A link to another call, as a flow shows it. */
export const linkOf = (record: CommandRecord, uses: readonly string[]): FlowLink => ({
  id: record.id,
  tool: record.tool,
  summary: oneLine(record.summary, 120),
  uses: [...uses],
})

const addLink = (links: readonly FlowLink[] | undefined, link: FlowLink): FlowLink[] =>
  [...(links ?? []).filter(one => one.id !== link.id), link].slice(-MAX_LINKS)

/** The request that read these calls' outputs finished: when, what Claude said, and whether it asked for more calls. */
export const markRead = (
  list: readonly CommandRecord[],
  ids: ReadonlySet<string>,
  read: { at: number; said: string; asked: readonly string[] },
): CommandRecord[] =>
  list.map(record => {
    if (!ids.has(record.id)) {
      return record
    }
    const flow: CommandFlow = {
      ...record.flow,
      readAt: read.at,
      said: read.said.trim() === '' ? undefined : oneLine(read.said, SAID_CHARS),
      asked: [...read.asked],
      isLast: read.asked.length === 0,
    }
    return { ...record, flow }
  })

/** A new call came of reading earlier outputs: each side learns of the other, with what it reused. */
export const linkCalls = (list: readonly CommandRecord[], laterId: string, earlier: readonly { id: string; uses: readonly string[] }[]): CommandRecord[] => {
  const later = list.find(record => record.id === laterId)
  if (later === undefined || earlier.length === 0) {
    return [...list]
  }
  const uses = new Map(earlier.map(one => [one.id, one.uses]))
  return list.map(record => {
    const reused = uses.get(record.id)
    if (reused !== undefined) {
      return { ...record, flow: { ...record.flow, next: addLink(record.flow?.next, linkOf(later, reused)) } }
    }
    if (record.id === laterId) {
      const after = earlier
        .map(one => list.find(candidate => candidate.id === one.id))
        .filter((found): found is CommandRecord => found !== undefined)
        .map(found => linkOf(found, uses.get(found.id) ?? []))
      return { ...record, flow: { ...record.flow, after: after.slice(-MAX_LINKS) } }
    }
    return record
  })
}

const fmtGap = (ms: number): string => (ms < 1_000 ? `${Math.max(0, Math.round(ms))} ms` : `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`)

const quoted = (bits: readonly string[]): string => bits.map(bit => `“${oneLine(bit, 40)}”`).join(', ')

/** The flow in a sentence or two: what led to the call, and what came of its output. */
export const flowSentence = (record: CommandRecord): string => {
  const flow = record.flow
  const parts: string[] = []
  const after = flow?.after ?? []
  if (after.length > 0) {
    const reused = after.filter(link => link.uses.length > 0)
    parts.push(
      reused.length > 0
        ? `Claude made it after reading ${after.length === 1 ? 'the output of' : `${after.length} outputs, including`} “${reused[0]?.summary ?? ''}”, reusing ${quoted(reused[0]?.uses ?? [])} from it.`
        : `Claude made it after reading ${after.length === 1 ? `the output of “${after[0]?.summary ?? ''}”` : `${after.length} outputs`}.`,
    )
  }
  if (record.endedAt === undefined) {
    parts.push('It is still running.')
  } else if (flow?.readAt === undefined) {
    parts.push(record.actor.kind === 'plugin' ? 'A plugin made it, so no model request reads its output.' : 'Claude has not read its output yet.')
  } else {
    const gap = fmtGap(flow.readAt - record.endedAt)
    const next = flow.next ?? []
    if (next.length > 0) {
      const reusedBy = next.filter(link => link.uses.length > 0)
      const names = next.map(link => `“${link.summary}”`).slice(0, 3).join(', ')
      parts.push(
        `Claude read its output ${gap} after it finished and then ran ${names}${next.length > 3 ? ` and ${next.length - 3} more` : ''}` +
          (reusedBy.length > 0 ? `; “${reusedBy[0]?.summary ?? ''}” reused ${quoted(reusedBy[0]?.uses ?? [])} from it.` : '; none of them repeats anything from its output.'),
      )
    } else if (flow.isLast === true) {
      parts.push(`Claude read its output ${gap} after it finished and answered without another call.`)
    } else {
      parts.push(`Claude read its output ${gap} after it finished and asked for ${(flow.asked ?? []).join(', ') || 'more calls'}.`)
    }
  }
  return parts.join(' ')
}

/** The row's second line: the call itself, then where its output went. */
export const flowHint = (record: CommandRecord): string => {
  const next = record.flow?.next ?? []
  if (next.length > 0) {
    const reused = next.some(link => link.uses.length > 0)
    return `→ ${next[0]?.summary ?? ''}${next.length > 1 ? ` +${next.length - 1}` : ''}${reused ? ' (used its output)' : ''}`
  }
  return record.flow?.isLast === true ? '→ Claude answered' : ''
}
