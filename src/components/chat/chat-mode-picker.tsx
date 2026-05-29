/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useChatStore, useCurrentChatSession } from '@/chats/chat-store'
import { useHaptics } from '@/hooks/use-haptics'
import { ModeSelector } from '@/components/ui/mode-selector'
import { useCallback } from 'react'

type ChatModePickerProps = {
  iconOnly?: boolean
}

/**
 * Mode picker for the chat composer. Renders the Chat/Search/Research selector
 * only for the built-in Thunderbolt agent — managed-acp and remote-acp agents
 * own their own conversation mode upstream, so the picker is hidden for them.
 *
 * The previously selected mode is preserved in the chat store, so switching
 * back to the built-in agent restores the same mode without re-deriving state.
 */
export const ChatModePicker = ({ iconOnly = false }: ChatModePickerProps) => {
  const modes = useChatStore((state) => state.modes)
  const setSelectedMode = useChatStore((state) => state.setSelectedMode)
  const { id: chatThreadId, selectedAgent, selectedMode } = useCurrentChatSession()
  const { triggerSelection } = useHaptics()

  const handleModeChange = useCallback(
    (modeId: string) => {
      triggerSelection()
      setSelectedMode(chatThreadId, modeId).catch(console.error)
    },
    [chatThreadId, setSelectedMode, triggerSelection],
  )

  if (selectedAgent.type !== 'built-in' || modes.length === 0) {
    return null
  }

  return <ModeSelector modes={modes} selectedMode={selectedMode} onModeChange={handleModeChange} iconOnly={iconOnly} />
}
