/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Reasoning depth for a model, derived from its profile.
 *
 * There is no thinking-level column: a model's reasoning config lives inside its
 * profile's `providerOptions`, in whichever dialect that provider speaks. This
 * module is the single translation of those dialects into the one level enum both
 * the in-browser harness and the runner accept, so a thread's reasoning depth is
 * identical wherever the turn executes. Kept free of engine imports so the
 * placement/run-spec path can use it without pulling the harness onto the bundle.
 */

import type { ModelProfile } from '@/types'
import { runnerThinkingLevels, type RunnerThinkingLevel } from '@shared/acp-types'

const thinkingLevels: ReadonlySet<string> = new Set<string>(runnerThinkingLevels)

/** Reasoning depth used when a model carries no explicit profile config. Mirrors
 *  the adaptive default the anthropic path has always used, so deriving the level
 *  never regresses a model that didn't configure one. */
const fallbackThinkingLevel: RunnerThinkingLevel = 'medium'

/** Maps an Anthropic-style thinking budget (tokens) to a level by upper bound:
 *  ≤0 → off, ≤1024 → minimal, ≤4096 → low, ≤12288 → medium, else high. */
const budgetToThinkingLevel = (budget: number): RunnerThinkingLevel => {
  if (budget <= 0) {
    return 'off'
  }
  if (budget <= 1024) {
    return 'minimal'
  }
  if (budget <= 4096) {
    return 'low'
  }
  if (budget <= 12288) {
    return 'medium'
  }
  return 'high'
}

/** Coerce a profile effort string to a level. Maps the explicit "off" signals
 *  ('off'/'none'), accepts the levels verbatim, and rejects anything else
 *  (returning null so the caller can keep looking / fall back). */
const effortToThinkingLevel = (value: unknown): RunnerThinkingLevel | null => {
  if (typeof value !== 'string') {
    return null
  }
  if (value === 'none') {
    return 'off'
  }
  return thinkingLevels.has(value) ? (value as RunnerThinkingLevel) : null
}

/**
 * Pull a thinking level out of a profile's `providerOptions`, the only per-model
 * reasoning signal in the data model. Recognizes the OpenAI
 * `reasoningEffort`/`reasoning_effort` strings, a nested `reasoning.effort`, and
 * the Anthropic-style `thinking` object (`{ type: 'disabled' }` → off;
 * `{ budgetTokens }` → bucketed level).
 *
 * @param providerOptions - the profile's raw provider options
 * @returns the configured level, or null when the profile configures no reasoning
 */
export const readProfileThinkingLevel = (
  providerOptions: Record<string, unknown> | null | undefined,
): RunnerThinkingLevel | null => {
  if (!providerOptions) {
    return null
  }
  const direct =
    effortToThinkingLevel(providerOptions.reasoningEffort) ?? effortToThinkingLevel(providerOptions.reasoning_effort)
  if (direct) {
    return direct
  }
  const reasoning = providerOptions.reasoning
  if (reasoning && typeof reasoning === 'object') {
    const nested = effortToThinkingLevel((reasoning as { effort?: unknown }).effort)
    if (nested) {
      return nested
    }
  }
  const thinking = providerOptions.thinking
  if (thinking && typeof thinking === 'object') {
    const { type, budgetTokens } = thinking as { type?: unknown; budgetTokens?: unknown }
    if (type === 'disabled') {
      return 'off'
    }
    if (typeof budgetTokens === 'number') {
      return budgetToThinkingLevel(budgetTokens)
    }
  }
  return null
}

/**
 * The thinking level for a model: its explicit profile reasoning config, else the
 * adaptive fallback.
 *
 * @param profile - the selected model's profile, or null when it has none
 */
export const deriveThinkingLevel = (profile: ModelProfile | null): RunnerThinkingLevel =>
  readProfileThinkingLevel(profile?.providerOptions) ?? fallbackThinkingLevel

/** Whether a model should request reasoning at all. Only models whose profile
 *  configures a non-`off` effort opt in; without config (or with an explicit
 *  `off`/`disabled`) the synthetic model stays non-reasoning. */
export const hasExplicitReasoning = (profile: ModelProfile | null): boolean => {
  const level = readProfileThinkingLevel(profile?.providerOptions)
  return level !== null && level !== 'off'
}
