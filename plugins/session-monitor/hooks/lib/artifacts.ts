// Artifacts: the pages the session published with the Artifact tool, and the
// files it sent you, read from those tools' calls and results.

import type { ArtifactRecord } from '../../types'
import { oneLine } from './format'

export const MAX_ARTIFACTS = 200

type Json = Readonly<Record<string, unknown>>

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

const base = (path: string): string => path.replace(/\/+$/, '').split('/').pop() ?? path

const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+/

/** What one finished call published or sent; nothing for other tools, failed calls, or reads. */
export const extractArtifacts = (tool: string, input: Json, result: unknown, text: string, now: number): ArtifactRecord[] => {
  if (tool === 'Artifact') {
    const action = str(input.action) ?? 'publish'
    if (action !== 'publish' || input.asset === true) {
      return []
    }
    const details = isRecord(result) ? result : {}
    const url = str(details.url) ?? ARTIFACT_URL.exec(text)?.[0] ?? str(input.url)
    if (url === undefined) {
      return []
    }
    const path = str(details.path) ?? str(input.file_path)
    const title = str(details.title) ?? str(input.title) ?? (path !== undefined ? base(path) : 'Artifact')
    return [{ id: url, kind: 'page', title: oneLine(title, 120), url, path, version: str(details.version), count: 1, firstAt: now, lastAt: now }]
  }
  if (tool === 'SendUserFile') {
    const files = Array.isArray(input.files) ? input.files.filter((one): one is string => typeof one === 'string') : []
    const caption = str(input.caption)
    return files.map(path => ({
      id: `file:${path}`,
      kind: 'file',
      title: base(path),
      path,
      count: 1,
      firstAt: now,
      lastAt: now,
      caption: caption !== undefined ? oneLine(caption, 160) : undefined,
    }))
  }
  return []
}

/** Adds what a call produced: a page published again keeps its first time and counts the new version. */
export const mergeArtifacts = (list: readonly ArtifactRecord[], added: readonly ArtifactRecord[]): ArtifactRecord[] => {
  const byId = new Map(list.map(one => [one.id, one]))
  for (const one of added) {
    const existing = byId.get(one.id)
    byId.set(
      one.id,
      existing === undefined
        ? one
        : { ...existing, ...one, firstAt: existing.firstAt, count: existing.count + 1, title: one.title !== 'Artifact' ? one.title : existing.title },
    )
  }
  return [...byId.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX_ARTIFACTS)
}
