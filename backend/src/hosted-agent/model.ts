/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import { createManagedProviderConnection, type InferenceLogger, type ManagedDirectProvider } from '@/inference/client'
import type { ManagedInferenceIdentity } from '@/inference/usage-ledger'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'

export type AgentIdentity = ManagedInferenceIdentity & { provider: ManagedDirectProvider }

/** Fireworks serverless model ids, which are also the ids its price rows are keyed on. */
const fireworksModelPrefix = 'accounts/fireworks/models/'

/**
 * The managed provider that serves `AGENT_MODEL`: Fireworks for an `accounts/fireworks/models/` id, Anthropic
 * for anything else. The id alone decides, so a deployment cannot name a model one provider serves while
 * pointing the agent at the other.
 */
export const getAgentIdentity = (agentModel: string): AgentIdentity => ({
  provider: agentModel.startsWith(fireworksModelPrefix) ? 'fireworks' : 'anthropic',
  model: agentModel,
})

type ManagedProviderConnection = ReturnType<typeof createManagedProviderConnection>

const agentModelFactories = {
  anthropic: (connection, model) => createAnthropic(connection)(model),
  // Usage only arrives on an OpenAI-compatible stream when it is asked for, and without it the run is unbilled.
  fireworks: (connection, model) =>
    createOpenAICompatible({ name: 'fireworks', includeUsage: true, ...connection })(model),
} satisfies Record<ManagedDirectProvider, (connection: ManagedProviderConnection, model: string) => LanguageModel>

/**
 * The hosted agent's default model, on the managed key of its provider. Throws when that key is unset, so
 * building it at startup fails the boot rather than the first request.
 */
export const createAgentModel = (
  { provider, model }: AgentIdentity,
  settings: Settings,
  options: { fetchFn?: typeof fetch; logger?: InferenceLogger },
): LanguageModel =>
  agentModelFactories[provider](
    createManagedProviderConnection(provider, settings, { ...options, source: 'agent' }),
    model,
  )
