/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useChatStore, useCurrentChatSession } from '@/chats/chat-store'
import { isBuiltInAgent } from '@/defaults/agents'
import { useLocalProviders } from '@/hooks/use-local-providers'
import { isModelReady } from '@/settings/models/model-policy'
import { useLocalSettingsStore } from '@/stores/local-settings-store'

/** Keeps the empty-chat presentation and composer setup gate in sync. */
export const useModelNeedsSetup = (): boolean => {
  const { selectedAgent, selectedModel } = useCurrentChatSession()
  const models = useChatStore((state) => state.models)
  const cloudUrl = useLocalSettingsStore((state) => state.cloudUrl)
  const needsOwnModel = useLocalProviders()
  return (
    isBuiltInAgent(selectedAgent) &&
    !models.some((model) => model.id === selectedModel.id && isModelReady(model, needsOwnModel ? '' : cloudUrl))
  )
}
