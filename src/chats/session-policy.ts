/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isAgentAvailable } from '@/acp/agent-availability'
import { isBuiltInAgent, isModelAllowedForAgent } from '@/defaults/agents'
import { needsApiKey } from '@/settings/models/model-policy'
import type { ChatSession } from './chat-store'
import { exposesPrivateThread } from './private-thread'

/** Validate every send path, including regeneration and automatic continuations. */
export const assertSessionCanSend = (
  session: Pick<ChatSession, 'chatThread' | 'selectedAgent' | 'selectedModel'>,
): void => {
  const { chatThread, selectedAgent, selectedModel } = session
  if (!isAgentAvailable(selectedAgent)) {
    throw new Error('This chat’s agent is unavailable. Start a new chat to use another agent.')
  }
  if (chatThread?.agentId && chatThread.agentId !== selectedAgent.id) {
    throw new Error('Cannot change the agent after a chat has started')
  }
  if (exposesPrivateThread(chatThread, selectedAgent)) {
    throw new Error('This private chat cannot run on the selected agent')
  }
  if (!isBuiltInAgent(selectedAgent)) {
    return
  }
  if (!selectedModel) {
    throw new Error('No selected model')
  }
  if (
    !isModelAllowedForAgent(selectedAgent, selectedModel) ||
    selectedModel.enabled !== 1 ||
    selectedModel.deletedAt ||
    needsApiKey(selectedModel)
  ) {
    throw new Error('This model is not available for the selected agent')
  }
}
