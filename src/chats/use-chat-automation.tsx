/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef } from 'react'
import { useCurrentChatSession } from './chat-store'
import { useChat as useChat_default } from '@ai-sdk/react'

type UseChatAutomationProps = {
  useChat?: typeof useChat_default
}

export const useChatAutomation = ({ useChat = useChat_default }: UseChatAutomationProps = {}) => {
  const { chatInstance } = useCurrentChatSession()

  const { messages } = useChat({ chat: chatInstance })

  const hasMessages = messages.length

  const hasTriggeredRef = useRef(false)

  // Auto-run assistant if thread ends with user message (e.g., automation) and no assistant response yet
  useEffect(() => {
    if (
      !hasTriggeredRef.current &&
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
  }, [chatInstance, hasMessages])
}
