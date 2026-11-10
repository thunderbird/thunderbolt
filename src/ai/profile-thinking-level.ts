/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import {
  piThinkingLevels,
  resolveReasoningEffort,
  type ReasoningCapabilities,
  type ReasoningEffort,
} from '@shared/reasoning-effort'
import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { ModelProfile } from '@/types'

const piThinkingLevelSchema = z.enum(piThinkingLevels)
const profileThinkingOptionsSchema = z
  .object({
    reasoningEffort: z.string().optional().catch(undefined),
    effort: z.string().optional().catch(undefined),
    reasoning_effort: z.string().optional().catch(undefined),
    reasoning: z
      .object({
        effort: z.string().optional().catch(undefined),
        enabled: z.boolean().optional().catch(undefined),
        max_tokens: z.number().optional().catch(undefined),
      })
      .optional()
      .catch(undefined),
    thinking: z
      .object({
        type: z.string().optional().catch(undefined),
        budgetTokens: z.number().optional().catch(undefined),
      })
      .optional()
      .catch(undefined),
  })
  .passthrough()

/** Maps an Anthropic-style thinking budget (tokens) to a Pi level by upper bound:
 *  ≤0 → off, ≤1024 → minimal, ≤4096 → low, ≤12288 → medium, else high. */
const budgetToThinkingLevel = (budget: number): ThinkingLevel => {
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

/** Coerce a profile effort string to a Pi level. Maps the explicit "off" signals
 *  ('off'/'none') to `off`, accepts the Pi levels verbatim, and rejects anything
 *  else (returning null so the caller can keep looking / fall back). */
const effortToThinkingLevel = (value: string | undefined): ThinkingLevel | null => {
  if (value === undefined) {
    return null
  }
  if (value === 'none') {
    return 'off'
  }
  const parsed = piThinkingLevelSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** Pull a Pi thinking level out of a profile's `providerOptions`.
 *  Recognizes the OpenAI `reasoningEffort`/`reasoning_effort` strings,
 *  nested OpenRouter effort/enabled/budget controls, Anthropic's top-level `effort`, and its `thinking` object
 *  (`{ type: 'disabled' }` → off; `{ budgetTokens }` → bucketed level). Returns
 *  null when no reasoning config is present. */
export const readProfileThinkingLevel = (
  providerOptions: ModelProfile['providerOptions'] | undefined,
): ThinkingLevel | null => {
  if (!providerOptions) {
    return null
  }
  const parsed = profileThinkingOptionsSchema.safeParse(providerOptions)
  if (!parsed.success) {
    return null
  }
  const options = parsed.data
  const direct = effortToThinkingLevel(options.reasoningEffort) ?? effortToThinkingLevel(options.reasoning_effort)
  if (direct) {
    return direct
  }
  const reasoning = options.reasoning
  if (reasoning) {
    const nested = effortToThinkingLevel(reasoning.effort)
    if (nested) {
      return nested
    }
    if (reasoning.enabled === false) {
      return 'off'
    }
    if (reasoning.max_tokens !== undefined) {
      return budgetToThinkingLevel(reasoning.max_tokens)
    }
    if (reasoning.enabled === true) {
      return 'medium'
    }
  }
  const thinking = options.thinking
  if (thinking?.type === 'disabled') {
    return 'off'
  }
  const adaptiveEffort = effortToThinkingLevel(options.effort)
  if (adaptiveEffort) {
    return adaptiveEffort
  }
  return thinking?.budgetTokens === undefined ? null : budgetToThinkingLevel(thinking.budgetTokens)
}

/** Represent configured reasoning with supported controls. Undefined means no configured default;
 * null means an existing profile cannot be represented without changing its native options. */
export const resolveProfileReasoningEffort = (
  providerOptions: ModelProfile['providerOptions'] | undefined,
  capabilities: ReasoningCapabilities,
): ReasoningEffort | null | undefined => {
  const level = readProfileThinkingLevel(providerOptions)
  if (level === null) {
    return undefined
  }
  const effort = level === 'off' ? 'none' : level
  // A budget-based profile is On regardless of which Pi level its budget maps to.
  return (
    resolveReasoningEffort(capabilities.kind === 'toggle' && effort !== 'none' ? 'high' : effort, capabilities) ?? null
  )
}
