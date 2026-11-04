/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ChatTransport } from 'ai'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useChatStore } from '@/chats/chat-store'
import { isCloudAgent, isPortableAgent } from '@/defaults/agents'
import { getDb } from '@/db/database'
import type { HttpClient } from '@/lib/http'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import type { CloudAgent } from '@/types/acp'
import {
  createCloudAgentClient,
  type CloudAgentClient,
  type CloudAgentView,
  type CloudConversationView,
} from './client'
import { createCloudOfflineStore } from './offline'
import { createCloudChatTransport } from './chat-transport'
import { persistCloudConversation } from './chat-history'
import { portableAgentResourceId } from './agent-inventory'

type AgentChatRoutingDeps = {
  createClient?: (http: HttpClient, ownerId: string) => CloudAgentClient
  createTransport?: typeof createCloudChatTransport
  persistProjection?: (agent: CloudAgentView, projection: CloudConversationView) => Promise<void>
}

/** Dispatch ordinary chat messages through the selected environment's transport. */
export const createAgentChatTransport = (
  {
    id,
    httpClient,
    fallback,
    saveMessages,
  }: {
    id: string
    httpClient: HttpClient
    fallback: ChatTransport<ThunderboltUIMessage>
    saveMessages: SaveMessagesFunction
  },
  deps: AgentChatRoutingDeps = {},
) => {
  type CloudTransport = ReturnType<typeof createCloudChatTransport>
  const state: { agentId?: string; binding?: Promise<CloudTransport> } = {}
  const admissions = new Set<ReturnType<ChatTransport<ThunderboltUIMessage>['sendMessages']>>()
  const selectedAgent = () => {
    const agent = useChatStore.getState().sessions.get(id)?.selectedAgent
    if (
      agent &&
      ((isPortableAgent(agent) && portableAgentResourceId(agent.id) !== agent.cloudAgentId) ||
        (/^(cloud|local):/.test(agent.id) && !isPortableAgent(agent)) ||
        (isPortableAgent(agent) && agent.id.startsWith('local:') !== (agent.executionEnvironment === 'local')))
    ) {
      throw new Error(i18n._(msg`This cloud agent selection is invalid. Choose an agent again.`))
    }
    return agent
  }
  const cloudBinding = (agent: CloudAgent): Promise<CloudTransport> => {
    const bindingId = `${agent.userId}:${agent.id}`
    if (state.agentId === bindingId && state.binding) {
      return state.binding
    }
    const client = deps.createClient
      ? deps.createClient(httpClient, agent.userId)
      : createCloudAgentClient(httpClient, agent.userId, createCloudOfflineStore(getDb(), agent.userId))
    state.agentId = bindingId
    const binding = (async () => {
      const view = (await client.agents()).find(
        ({ record }) => record.id === agent.cloudAgentId && record.ownerId === agent.userId,
      )
      if (!view) {
        throw new Error(i18n._(msg`This cloud agent is no longer available.`))
      }
      return (deps.createTransport ?? createCloudChatTransport)({
        client,
        agent: view.record,
        conversationId: id,
        getApprovalMode: () => useChatStore.getState().sessions.get(id)?.cloudApprovalMode ?? 'ask',
        getMessages: () => useChatStore.getState().sessions.get(id)?.chatInstance.messages ?? [],
        onProjection: async (projection) => {
          if (deps.persistProjection) {
            await deps.persistProjection(view, projection)
          } else {
            await persistCloudConversation(getDb(), view, projection)
          }
        },
        requestPermission: (approval, signal) =>
          new Promise((resolve) => {
            const session = useChatStore.getState().sessions.get(id)
            if (
              signal.aborted ||
              !session ||
              !isCloudAgent(session.selectedAgent) ||
              session.selectedAgent.id !== agent.id ||
              session.selectedAgent.userId !== agent.userId
            ) {
              resolve(null)
              return
            }
            const requestId = approval.record.id
            const finish = (decision: 'approved' | 'denied' | null) => {
              signal.removeEventListener('abort', detach)
              const current = useChatStore.getState().sessions.get(id)
              if (current?.pendingPermission?.requestId === requestId) {
                useChatStore.getState().updateSession(id, { pendingPermission: null })
              }
              resolve(decision)
            }
            const detach = () => finish(null)
            signal.addEventListener('abort', detach, { once: true })
            useChatStore.getState().setPendingPermission(id, {
              agentId: agent.id,
              requestId,
              allowRemember: false,
              request: {
                sessionId: id,
                toolCall: {
                  toolCallId: approval.record.id,
                  title: approval.payload.toolName,
                  kind: 'other',
                  rawInput: approval.payload.arguments,
                  content: [
                    {
                      type: 'content',
                      content: { type: 'text', text: JSON.stringify(approval.payload.arguments, null, 2) },
                    },
                  ],
                },
                options: [
                  { optionId: 'approved', kind: 'allow_once', name: i18n._(msg`Allow once`) },
                  { optionId: 'denied', kind: 'reject_once', name: i18n._(msg`Deny`) },
                ],
              },
              resolve: (response) =>
                finish(
                  response.outcome.outcome === 'selected'
                    ? response.outcome.optionId === 'approved'
                      ? 'approved'
                      : 'denied'
                    : null,
                ),
            })
          }),
      })
    })()
    state.binding = binding.catch((error: unknown) => {
      state.binding = undefined
      throw error
    })
    return state.binding
  }
  const transport: ChatTransport<ThunderboltUIMessage> = {
    sendMessages: async (options) => {
      const agent = selectedAgent()
      if (!agent || !isCloudAgent(agent)) {
        return fallback.sendMessages(options)
      }
      const admission = (async () => {
        await saveMessages({ id, messages: options.messages })
        return (await cloudBinding(agent)).sendMessages(options)
      })()
      admissions.add(admission)
      return admission.finally(() => admissions.delete(admission))
    },
    reconnectToStream: async (options) => {
      const agent = selectedAgent()
      if (!agent || !isCloudAgent(agent)) {
        return fallback.reconnectToStream(options)
      }
      return (await cloudBinding(agent)).reconnectToStream(options)
    },
  }
  return {
    transport,
    stop: async () => {
      const agent = selectedAgent()
      if (agent && isCloudAgent(agent)) {
        // Stop must follow admission even while the local save or cloud inventory is pending.
        await Promise.allSettled([...admissions])
        await (await cloudBinding(agent)).stop()
      }
    },
  }
}
