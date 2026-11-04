/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { RequestAgentToolApproval } from '@/ai/agent-tool-approval'
import { createCloudAgentClient, type CloudAgentClient, type CloudConnectionView } from '@/cloud-agent/client'
import { createCloudOfflineStore } from '@/cloud-agent/offline'
import { agentModels } from '@shared/cloud-agent/agent-models'
import { getModel } from '@/dal/models'
import { getDb } from '@/db/database'
import type { HttpClient } from '@/lib/http'
import type { NamedMCPClient } from '@/lib/mcp-provider'
import { matchesThreadConfidentiality } from '@/settings/models/model-policy'
import type { Model } from '@/types'
import type { AgentAdapter, AgentAdapterContext, CloudAgent } from '@/types/acp'
import type { CloudAgentConfig } from '@shared/cloud-agent/contracts'
import { createBuiltInAdapter, type BuiltInAdapterOptions } from './built-in-adapter'

type LocalAgentClient = Pick<CloudAgentClient, 'agents' | 'connections'>

export type LocalAgentAdapterOptions = BuiltInAdapterOptions & {
  createLocalAgentClient?: (httpClient: HttpClient, ownerId: string) => LocalAgentClient
  loadLocalAgentModel?: (id: string) => Promise<Model | null>
}

/** Resolve legacy cloud connection selections to library IDs without reusing their credentials. */
export const localAgentMcpSelection = (
  config: CloudAgentConfig,
  connections: readonly CloudConnectionView[] = [],
): { sourceId: string; name: string }[] => {
  if (config.mcpServers !== undefined) {
    return config.mcpServers
  }
  return config.connectionIds.flatMap((id) => {
    const connection = connections.find(({ record }) => record.id === id)
    if (!connection || connection.config.libraryRef?.kind !== 'mcp') {
      return []
    }
    return [{ sourceId: connection.config.libraryRef.id, name: connection.config.name }]
  })
}

/** Match only explicitly selected library connections against this device's live MCP clients. */
export const selectLocalAgentMcpClients = (
  selected: readonly { sourceId: string; name: string }[],
  clients: readonly NamedMCPClient[],
): { clients: NamedMCPClient[]; unavailable: string[] } => {
  const ids = new Set(selected.map(({ sourceId }) => sourceId))
  const availableIds = new Set(clients.map(({ id }) => id))
  return {
    clients: clients.filter(({ id }) => ids.has(id)),
    unavailable: selected.filter(({ sourceId }) => !availableIds.has(sourceId)).map(({ name }) => name),
  }
}

/** Old saved selections still run when their optional cloud bindings cannot be read. */
const loadLegacyConnections = async (client: LocalAgentClient): Promise<CloudConnectionView[]> => {
  try {
    return await client.connections()
  } catch {
    return []
  }
}

/** Serialize local permission prompts; a missing UI or cancellation never grants tool access. */
export const createLocalAgentToolApproval = (context: AgentAdapterContext): RequestAgentToolApproval => {
  const queue = { pending: Promise.resolve() }
  return async ({ toolName, toolCallId, input }, signal) => {
    const previous = queue.pending
    const completion = Promise.withResolvers<void>()
    queue.pending = completion.promise
    try {
      await previous
      if (signal?.aborted) {
        return false
      }
      if (context.agentApprovalMode === 'full-access') {
        return true
      }
      if (!context.requestPermission) {
        return false
      }
      const cancelled = Promise.withResolvers<null>()
      const onAbort = () => cancelled.resolve(null)
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const response = await Promise.race([
          context.requestPermission({
            sessionId: context.threadId,
            toolCall: {
              toolCallId,
              title: toolName,
              kind: 'other',
              status: 'pending',
              rawInput: input,
              content: [{ type: 'content', content: { type: 'text', text: JSON.stringify(input, null, 2) } }],
            },
            options: [
              { optionId: 'approved', kind: 'allow_once', name: i18n._(msg`Allow once`) },
              { optionId: 'denied', kind: 'reject_once', name: i18n._(msg`Deny`) },
            ],
          }),
          cancelled.promise,
        ])
        return !signal?.aborted && response?.outcome.outcome === 'selected' && response.outcome.optionId === 'approved'
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    } finally {
      completion.resolve()
    }
  }
}

/** Run a saved agent with the built-in engine and this device's models and connections. */
export const createLocalAgentAdapter = (
  agent: CloudAgent,
  httpClient: HttpClient,
  options: LocalAgentAdapterOptions = {},
): AgentAdapter => {
  const builtIn = createBuiltInAdapter(agent, options)
  const client = options.createLocalAgentClient
    ? options.createLocalAgentClient(httpClient, agent.userId)
    : createCloudAgentClient(httpClient, agent.userId, createCloudOfflineStore(getDb(), agent.userId))
  const loadModel = options.loadLocalAgentModel ?? ((id: string) => getModel(getDb(), id))

  return {
    ...builtIn,
    fetch: async (init, context) => {
      const view = (await client.agents()).find(
        ({ record }) => record.id === agent.cloudAgentId && record.ownerId === agent.userId,
      )
      if (!view || view.record.deletedAt || !view.record.enabled) {
        throw new Error(i18n._(msg`This agent is no longer available.`))
      }
      const { config } = view
      const defaultModel = agentModels(config)[0]
      const modelId = defaultModel?.localModelId ?? defaultModel?.model?.sourceId
      const model = modelId ? await loadModel(modelId) : null
      if (!model || model.deletedAt) {
        throw new Error(
          i18n._(msg`This agent's model is unavailable on this device. Choose a model in the agent's settings.`),
        )
      }
      if (context.chatThread && !matchesThreadConfidentiality(model, context.chatThread)) {
        throw new Error(
          i18n._(
            msg`This agent's model no longer matches this chat's privacy setting. Start a new chat to use the updated model.`,
          ),
        )
      }
      // New definitions carry library IDs directly. Old definitions may need the
      // cloud bindings just to recover those IDs; an unavailable legacy binding
      // removes that connection from this turn rather than blocking the chat.
      const legacyConnections =
        config.mcpServers === undefined && config.connectionIds.length ? await loadLegacyConnections(client) : []
      const selected = localAgentMcpSelection(config, legacyConnections)
      const scoped = selectLocalAgentMcpClients(selected, context.mcpClients)
      const unmappedLegacy = config.mcpServers === undefined && selected.length < config.connectionIds.length
      return builtIn.fetch(init, {
        ...context,
        selectedModel: model,
        mcpClients: scoped.clients,
        agentConfiguration: {
          instructions: config.instructions,
          skills: config.skills,
          searchEnabled: config.searchEnabled,
          requestToolApproval: createLocalAgentToolApproval(context),
          unavailableCapabilities: [
            ...scoped.unavailable,
            ...(unmappedLegacy ? ['Some saved connections have no connection on this device'] : []),
          ],
        },
      })
    },
  }
}
