/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import { createManagedProviderConnection, type InferenceLogger, type ManagedDirectProvider } from '@/inference/client'
import { managedAgentModels, type ManagedAgentIdentity } from '@/inference/managed-models'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAICompatible, type OpenAICompatibleProviderSettings } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { createHash } from 'crypto'

/**
 * The managed identity `AGENT_MODEL` runs as, looked up in `managedAgentModels`. Throws for an id the table
 * does not list, so a typo, a Fireworks model in another account or an unpriced model fails the boot instead
 * of every request.
 */
export const getAgentIdentity = (agentModel: string): ManagedAgentIdentity => {
  const identity = managedAgentModels.get(agentModel)
  if (!identity) {
    const supported = [...managedAgentModels.keys()].join(', ')
    throw new Error(
      `AGENT_MODEL "${agentModel}" is not a hosted-agent model. Use a Fireworks serverless id ` +
        `(accounts/fireworks/models/<name>) or a bare Anthropic id, one of: ${supported}. ` +
        'Fireworks models in other accounts are not supported yet.',
    )
  }
  return identity
}

type FireworksUsageConverter = NonNullable<OpenAICompatibleProviderSettings['convertUsage']>

/**
 * Fireworks usage in the AI SDK's shape. The provider's default reads a null count as 0, which would land a
 * zero-cost ledger row; a missing count here reads as no usage, so the run logs `agent_usage_missing` instead.
 */
const convertFireworksUsage: FireworksUsageConverter = (usage) => {
  const inputTokens = usage?.prompt_tokens
  const outputTokens = usage?.completion_tokens
  if (inputTokens == null || outputTokens == null) {
    return {
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    }
  }
  const cacheRead = usage?.prompt_tokens_details?.cached_tokens ?? 0
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? 0
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens - cacheRead, cacheRead, cacheWrite: undefined },
    outputTokens: { total: outputTokens, text: Math.max(0, outputTokens - reasoning), reasoning },
  }
}

type ManagedProviderConnection = ReturnType<typeof createManagedProviderConnection>

type TransformRequestBody = NonNullable<OpenAICompatibleProviderSettings['transformRequestBody']>

// Priority is less likely to be load-shed than Standard. Standard sends no `service_tier` field at all.
const priorityTier: TransformRequestBody = (body) => ({ ...body, service_tier: 'priority' })

const agentModelFactories = {
  anthropic: (connection, model) => createAnthropic(connection)(model),
  // includeUsage requests the usage chunk explicitly rather than relying on Fireworks sending it by default.
  fireworks: (connection, model, { agentFireworksServiceTier }) =>
    createOpenAICompatible({
      name: 'fireworks',
      includeUsage: true,
      convertUsage: convertFireworksUsage,
      ...(agentFireworksServiceTier === 'priority' && { transformRequestBody: priorityTier }),
      ...connection,
    })(model),
} satisfies Record<
  ManagedDirectProvider,
  (connection: ManagedProviderConnection, model: string, settings: Settings) => LanguageModel
>

/**
 * The hosted agent's default model, on the managed key of its provider. Throws for an unset key, as
 * `createManagedProviderConnection` does.
 */
export const createAgentModel = (
  { provider, model }: ManagedAgentIdentity,
  settings: Settings,
  options: { fetchFn?: typeof fetch; logger?: InferenceLogger },
): LanguageModel =>
  agentModelFactories[provider](
    createManagedProviderConnection(provider, settings, { ...options, source: 'agent' }),
    model,
    settings,
  )

const agentRequestHeaders = {
  anthropic: () => undefined,
  // Fireworks shares one prompt cache across the account, which a timing probe could read across users.
  fireworks: (userId) => ({ 'x-prompt-cache-isolation-key': createHash('sha256').update(userId).digest('hex') }),
} satisfies Record<ManagedDirectProvider, (userId: string) => Record<string, string> | undefined>

/** Per-user upstream headers for one run. Keyed on a hash, so the raw user id never leaves the deployment. */
export const getAgentRequestHeaders = ({ provider }: ManagedAgentIdentity, userId: string) =>
  agentRequestHeaders[provider](userId)
