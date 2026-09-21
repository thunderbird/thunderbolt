/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef } from 'react'
import { useCurrentChatSession } from './chat-store'
import { useChat as useChat_default } from '@ai-sdk/react'
import { messageBookkeepingThrottleMs } from './chat-throttle'

type UseChatAutomationProps = {
  useChat?: typeof useChat_default
}

export const useChatAutomation = ({ useChat = useChat_default }: UseChatAutomationProps = {}) => {
  const { chatInstance, stopping } = useCurrentChatSession()

  const { messages } = useChat({ chat: chatInstance, experimental_throttle: messageBookkeepingThrottleMs })

  const hasMessages = messages.length

  const hasTriggeredRef = useRef(false)

  // Auto-run assistant if thread ends with user message (e.g., automation) and no
  // assistant response yet. Gated on `stopping`: a stopped turn also ends with a
  // trailing user message (the aborted shell is dropped), so without the gate this
  // effect would restart the very turn the user just cancelled (THU-791).
  useEffect(() => {
    if (
      !hasTriggeredRef.current &&
      !stopping &&
      chatInstance?.status === 'ready' &&
      hasMessages &&
      chatInstance?.messages[chatInstance?.messages.length - 1].role === 'user'
    ) {
      hasTriggeredRef.current = true
      // Regenerate assistant response for the last user message
      chatInstance?.regenerate().catch((err) => {
        console.error('Auto regenerate error', err)
      })
    }
  }, [chatInstance, hasMessages, stopping])
}
