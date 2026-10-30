// Time stats: how long commands took, by read / write / execute and by tool.

import type { Access, CommandRecord } from '../../types'

export const ACCESSES: readonly Access[] = ['read', 'write', 'execute']

export type TimeStats = {
  count: number
  totalMs: number
  avgMs: number
  failed: number
  longest?: CommandRecord
}

export const elapsedMs = (record: CommandRecord, now: number): number => Math.max(0, (record.endedAt ?? now) - record.startedAt)

export const timeStats = (records: readonly CommandRecord[], now: number): TimeStats => {
  let totalMs = 0
  let longest: CommandRecord | undefined
  for (const record of records) {
    const ms = elapsedMs(record, now)
    totalMs += ms
    if (longest === undefined || ms > elapsedMs(longest, now)) {
      longest = record
    }
  }
  return {
    count: records.length,
    totalMs,
    avgMs: records.length === 0 ? 0 : totalMs / records.length,
    failed: records.filter(record => record.status === 'error').length,
    longest,
  }
}

export const byAccess = (records: readonly CommandRecord[], now: number): Record<Access, TimeStats> => ({
  read: timeStats(records.filter(record => record.access === 'read'), now),
  write: timeStats(records.filter(record => record.access === 'write'), now),
  execute: timeStats(records.filter(record => record.access === 'execute'), now),
})

export type ToolTime = { tool: string; count: number; totalMs: number }

/** Total time per tool, the most time first. */
export const byTool = (records: readonly CommandRecord[], now: number): ToolTime[] => {
  const tools = new Map<string, ToolTime>()
  for (const record of records) {
    const entry = tools.get(record.tool) ?? { tool: record.tool, count: 0, totalMs: 0 }
    entry.count += 1
    entry.totalMs += elapsedMs(record, now)
    tools.set(record.tool, entry)
  }
  return [...tools.values()].sort((a, b) => b.totalMs - a.totalMs)
}

/** Average throughput while bytes were moving, or 0 when they never did. */
export const activeRate = (bytes: number, activeS: number): number => (activeS > 0 ? bytes / activeS : 0)

/** How many finished calls Overview keeps above "Running now". */
export const RECENT_COUNT = 5

/** The latest calls to finish, the newest first; a background shell counts once it ends. */
export const recentlyFinished = (records: readonly CommandRecord[], count: number = RECENT_COUNT): CommandRecord[] =>
  records
    .filter(record => record.endedAt !== undefined && record.status !== 'running' && record.status !== 'background')
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, count)

/** How long a finished call stays in "Running now", so a quick one is seen at all. */
export const LINGER_MS = 5_000

/** What runs now, plus what finished in the last `lingerMs`, oldest first. */
export const runningOrRecent = (records: readonly CommandRecord[], now: number, lingerMs: number = LINGER_MS): CommandRecord[] =>
  records.filter(
    record =>
      record.status === 'running' ||
      record.status === 'background' ||
      (record.endedAt !== undefined && now - record.endedAt < lingerMs),
  )
