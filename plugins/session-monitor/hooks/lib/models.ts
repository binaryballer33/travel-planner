// Which model and effort level did the work: model requests, turns, prompts
// and tool calls per (model, effort) pair, from the session's `turn.step`s.

import type { ModelUse } from '../../types'

export type Step = {
  model: string
  effort: string
  /** The step opens a turn (its first request). */
  isTurnStart: boolean
  /** That turn began with something the person typed. */
  isPrompt: boolean
  /** Made inside a sub-agent's loop. */
  isAgent: boolean
}

export const effortText = (effort: string | number | undefined): string => (effort === undefined ? 'default' : String(effort))

const find = (list: readonly ModelUse[], model: string, effort: string): ModelUse =>
  list.find(one => one.model === model && one.effort === effort) ?? {
    model,
    effort,
    turns: 0,
    prompts: 0,
    requests: 0,
    toolCalls: 0,
    agentRequests: 0,
  }

const put = (list: readonly ModelUse[], entry: ModelUse): ModelUse[] =>
  [...list.filter(one => !(one.model === entry.model && one.effort === entry.effort)), entry].sort(
    (a, b) => b.requests + b.toolCalls - (a.requests + a.toolCalls),
  )

/** Counts one model request. */
export const recordStep = (list: readonly ModelUse[], step: Step): ModelUse[] => {
  const entry = find(list, step.model, step.effort)
  return put(list, {
    ...entry,
    requests: entry.requests + (step.isAgent ? 0 : 1),
    agentRequests: entry.agentRequests + (step.isAgent ? 1 : 0),
    turns: entry.turns + (step.isTurnStart && !step.isAgent ? 1 : 0),
    prompts: entry.prompts + (step.isTurnStart && step.isPrompt && !step.isAgent ? 1 : 0),
  })
}

/** Counts one tool call against the model and effort that asked for it. */
export const recordToolCall = (list: readonly ModelUse[], model: string, effort: string): ModelUse[] => {
  const entry = find(list, model, effort)
  return put(list, { ...entry, toolCalls: entry.toolCalls + 1 })
}
