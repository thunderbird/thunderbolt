/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useChatStore, useCurrentChatSession } from '@/chats/chat-store'
import { useCreateItem } from '@/components/create-item/context'
import { ModelSelector } from '@/components/ui/model-selector'
import { isModelAllowedForAgent } from '@/defaults/agents'
import { useIsMobile } from '@/hooks/use-mobile'

/**
 * Model picker for the chat composer. Renders only for the built-in
 * Thunderbolt agent. Managed-acp, managed-http and remote-acp agents own
 * their own model selection upstream, so it is hidden for them.
 *
 * Uses the `composer` ModelSelector variant, opening down on desktop and up
 * on mobile (above the bottom-anchored composer).
 */
export const ChatModelPicker = () => {
  const models = useChatStore((state) => state.models)
  const setSelectedModel = useChatStore((state) => state.setSelectedModel)
  const { openCreateItem } = useCreateItem()
  const { isMobile } = useIsMobile()
  const { id: chatThreadId, selectedAgent, selectedModel } = useCurrentChatSession()

  const agentModels = models.filter((model) => isModelAllowedForAgent(selectedAgent, model))

  if (selectedAgent.type !== 'built-in' || agentModels.length === 0) {
    return null
  }

  const handleModelChange = (modelId: string) => {
    setSelectedModel(chatThreadId, modelId).catch(console.error)
  }

  return (
    <ModelSelector
      variant="composer"
      models={agentModels}
      selectedModel={selectedModel ?? null}
      onModelChange={handleModelChange}
      onAddModels={() => openCreateItem({ kind: 'model' })}
      side={isMobile ? 'top' : 'bottom'}
      align="end"
    />
  )
}
