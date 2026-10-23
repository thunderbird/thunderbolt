/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Agent } from '@/types/acp'
import type { Model } from '@/types'
import { needsApiKey } from '@/settings/models/model-policy'
import { defaultModelOpus55, defaultModels } from '@shared/defaults/models'

/**
 * The built-in confidential agent, Vesta. Lives in code only — never a DB row.
 *
 * The chat layer treats this special case as a thin adapter over the existing
 * `aiFetchStreamingResponse` pipeline; the ACP protocol is not involved.
 * Always present, always first in the agent list, never removable. Its stable
 * ID preserves saved chats and preferences across display-name changes.
 */
export const builtInAgent: Agent = {
  id: 'thunderbolt-built-in',
  name: 'Vesta',
  type: 'built-in',
  transport: 'in-process',
  url: null,
  description: 'Private AI assistant powered by Tinfoil',
  icon: 'lock',
  isPrivate: true,
  voice: {
    provider: 'tinfoil',
    sttModel: 'whisper-large-v3-turbo',
    ttsModel: 'qwen3-tts',
    ttsVoice: 'ryan',
  },
  isSystem: 1,
  enabled: 1,
  deletedAt: null,
  userId: null,
}

/** The non-confidential built-in assistant using Thunderbolt-hosted Opus. */
export const zeusAgent: Agent = {
  ...builtInAgent,
  id: 'superbolt-built-in',
  name: 'Zeus',
  description: 'AI assistant powered by Opus 5.5',
  icon: 'zap',
  isPrivate: false,
  voice: { provider: 'fireworks', sttModel: null, ttsModel: null, ttsVoice: null },
}

/** Built-in agents in their canonical picker order. */
export const builtInAgents: readonly Agent[] = [builtInAgent, zeusAgent]

/** Whether the agent promises confidential inference. */
export const isPrivateAgent = (agent: Agent): boolean =>
  isBuiltInAgent(agent) && agent.id === builtInAgent.id && agent.isPrivate === true

/**
 * Built-in agents use only their preconfigured model identities and providers.
 * Stable row IDs survive model-slug updates from OTA defaults and newer devices.
 * User-created remote agents select their own models upstream.
 */
export const isModelAllowedForAgent = (agent: Agent, model: Pick<Model, 'id' | 'provider'>): boolean => {
  if (!isBuiltInAgent(agent)) {
    return true
  }
  if (agent.id === builtInAgent.id) {
    return (
      model.provider === 'tinfoil' &&
      defaultModels.some((configured) => configured.provider === 'tinfoil' && configured.id === model.id)
    )
  }
  return (
    agent.id === zeusAgent.id && model.provider === defaultModelOpus55.provider && model.id === defaultModelOpus55.id
  )
}

/** Resolve the built-in owner from the same policy used by model selection and sends. */
export const builtInAgentForModel = (model: Pick<Model, 'id' | 'provider'>): Agent => {
  const agent = builtInAgents.find((candidate) => isModelAllowedForAgent(candidate, model))
  if (!agent) {
    throw new Error('No built-in agent supports this model')
  }
  return agent
}

/** Shared availability gate for selection, resolution, the composer, and sending. */
export const isModelAvailableForAgent = (agent: Agent, model: Model): boolean =>
  isModelAllowedForAgent(agent, model) && model.enabled === 1 && !model.deletedAt && !needsApiKey(model)

/**
 * Whether an agent is an in-process built-in agent (vs. an ACP
 * agent). Built-in-only chat affordances — the mode picker and the mode-aware
 * loading label — gate on this; ACP agents own their conversation mode upstream.
 */
export const isBuiltInAgent = (agent: Agent): boolean => agent.type === 'built-in'

/**
 * Whether an agent is the backend's hosted agent (`managed-http`). It runs on
 * the server with a model of its own, so the chat's selected model is unused,
 * the chat's content reaches the backend unencrypted (its threads are never
 * private), and it takes no attachments for now.
 */
export const isHostedAgent = (agent: Agent): boolean => agent.type === 'managed-http'
