/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCurrentChatSession } from '@/chats/chat-store'
import { isBuiltInAgent } from '@/defaults/agents'
import { useLocalProviders } from '@/hooks/use-local-providers'
import { isModelAvailable } from '@/settings/models/model-policy'
import { useLocalSettingsStore } from '@/stores/local-settings-store'

/** Keeps the empty-chat presentation and composer setup gate in sync. */
export const useModelNeedsSetup = (): boolean => {
  const { selectedAgent, selectedModel } = useCurrentChatSession()
  const cloudUrl = useLocalSettingsStore((state) => state.cloudUrl)
  const needsOwnModel = useLocalProviders()
  return isBuiltInAgent(selectedAgent) && !isModelAvailable(selectedModel, needsOwnModel ? '' : cloudUrl)
}
