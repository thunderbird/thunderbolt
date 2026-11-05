/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ModelThinkingLevel } from '@earendil-works/pi-ai'

/** Wire values, deliberately distinct from Pi's `off` and an omitted preference. */
export const reasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningEffort = (typeof reasoningEfforts)[number]

/** Pi uses `off` for the native API's `none` effort; all other levels retain their order. */
export const piThinkingLevels: readonly ModelThinkingLevel[] = reasoningEfforts.map((effort) =>
  effort === 'none' ? 'off' : effort,
)
export type ReasoningCapabilities = { kind?: 'effort' | 'toggle'; efforts: readonly ReasoningEffort[] }
export const noReasoningEffort: ReasoningCapabilities = { efforts: [] }

/** Validate persisted preferences and provider metadata without inventing support. */
export const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  typeof value === 'string' && reasoningEfforts.some((effort) => effort === value)

/** Unsupported saved selections resolve to omission, never a silently clamped level. */
export const resolveReasoningEffort = (
  value: unknown,
  capabilities: ReasoningCapabilities,
): ReasoningEffort | undefined => (isReasoningEffort(value) && capabilities.efforts.includes(value) ? value : undefined)

/** Separate one chat/model's preference from global model profiles; settings values are encrypted and synced. */
export const reasoningEffortSettingKey = (threadId: string, modelId: string): string =>
  `chat-reasoning-effort:${threadId}:${modelId}`

/** Native levels from https://docs.tinfoil.sh/guides/reasoning (2026-11-05).
 * https://inference.tinfoil.sh/v1/models exposes preset effort_map values, not complete native support:
 * Kimi has no mapping, and DeepSeek's mapping omits the supported max level.
 */
export const tinfoilReasoningCapabilities = (modelId: string): ReasoningCapabilities => {
  switch (modelId) {
    case 'glm-5-3':
    case 'kimi-k3':
      return { efforts: ['low', 'high', 'max'] }
    case 'deepseek-v4-1-flash':
      return { efforts: ['none', 'low', 'high', 'xhigh', 'max'] }
    case 'gemma4-31b':
      return { efforts: reasoningEfforts }
    case 'gpt-oss-120b':
    case 'gpt-oss-safeguard-120b':
      return { efforts: ['low', 'medium', 'high'] }
    default:
      return noReasoningEffort
  }
}

/** Select the effort encoding for an OpenAI-compatible provider. */
export const reasoningEffortFormat = (providerId: string): 'openai' | 'openrouter' | 'tinfoil' =>
  providerId === 'openrouter' || providerId === 'tinfoil' ? providerId : 'openai'

/** OpenRouter distinguishes omitted support (unknown/unavailable) from null (all gateway values). */
export const openRouterReasoningCapabilities = (
  reasoning:
    | {
        supported_efforts?: readonly string[] | null
        mandatory?: boolean
      }
    | undefined,
): ReasoningCapabilities => ({
  efforts: reasoningEfforts.filter(
    (effort) =>
      !(effort === 'none' && reasoning?.mandatory) &&
      (reasoning?.supported_efforts === null || reasoning?.supported_efforts?.includes(effort)),
  ),
})

/** Apply an explicit choice at the provider boundary, after Pi's compatibility mappings.
 * An omitted preference returns the original payload unchanged. Exact native choices must not be
 * remapped by catalog aliases (e.g. Tinfoil DeepSeek high -> xhigh).
 */
export const applyReasoningEffort = (
  payload: unknown,
  effort: ReasoningEffort | undefined,
  format: 'openai' | 'openrouter' | 'tinfoil',
): unknown => {
  if (effort === undefined) {
    return payload
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Expected a provider request object')
  }
  const result = { ...payload } as Record<string, unknown>
  delete result.reasoning_effort
  if (format === 'openrouter') {
    const existing = result.reasoning
    const reasoning = existing && typeof existing === 'object' ? ({ ...existing } as Record<string, unknown>) : {}
    delete reasoning.max_tokens
    delete reasoning.enabled
    result.reasoning = { ...reasoning, effort }
    return result
  }
  delete result.reasoning
  if (format === 'tinfoil') {
    delete result.thinking
    const kwargs = result.chat_template_kwargs
    if (kwargs && typeof kwargs === 'object' && !Array.isArray(kwargs)) {
      const rest = { ...kwargs } as Record<string, unknown>
      delete rest.thinking
      delete rest.enable_thinking
      delete rest.reasoning_effort
      if (Object.keys(rest).length) {
        result.chat_template_kwargs = rest
      } else {
        delete result.chat_template_kwargs
      }
    }
  }
  return { ...result, reasoning_effort: effort }
}
