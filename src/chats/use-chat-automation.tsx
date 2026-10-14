/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef } from 'react'
import { useCurrentChatSession } from './chat-store'
import { useChat as useChat_default } from '@ai-sdk/react'
import { messageBookkeepingThrottleMs } from './chat-throttle'
import { isPrivateAutoRunBlocked } from './private-thread'

type UseChatAutomationProps = {
  useChat?: typeof useChat_default
}

export const useChatAutomation = ({ useChat = useChat_default }: UseChatAutomationProps = {}) => {
  const { chatInstance, stopping, chatThread, selectedAgent } = useCurrentChatSession()

  const { messages } = useChat({ chat: chatInstance, experimental_throttle: messageBookkeepingThrottleMs })

  const hasMessages = messages.length

  const hasTriggeredRef = useRef(false)
  // The thread/agent pair last refused, so a block logs once rather than on
  // every re-render of the effect while it holds.
  const warnedBlockRef = useRef<string | null>(null)

  // Auto-run assistant if thread ends with user message (e.g., automation) and no
  // assistant response yet. Gated on `stopping`: a stopped turn also ends with a
  // trailing user message (the aborted shell is dropped), so without the gate this
  // effect would restart the very turn the user just cancelled (THU-791).
  // A private chat that resolved to a non-built-in agent (an automation thread
  // has no agent of its own, so it takes the last-used one) is never sent
  // unasked. Switching it to the built-in agent re-runs the effect and sends.
  useEffect(() => {
    if (
      !hasTriggeredRef.current &&
      !stopping &&
      chatInstance?.status === 'ready' &&
      hasMessages &&
      chatInstance?.messages[chatInstance?.messages.length - 1].role === 'user'
    ) {
      if (
        isPrivateAutoRunBlocked({
          chatThread,
          agent: selectedAgent,
          status: chatInstance.status,
          stopping,
          lastRole: chatInstance.messages.at(-1)?.role,
        })
      ) {
        const block = `${chatInstance.id}:${selectedAgent.id}`
        if (warnedBlockRef.current !== block) {
          warnedBlockRef.current = block
          console.warn(
            `Not auto-running private chat ${chatInstance.id} on agent ${selectedAgent.id}: it would leave the device unencrypted`,
          )
        }
        return
      }
      hasTriggeredRef.current = true
      // Regenerate assistant response for the last user message
      chatInstance?.regenerate().catch((err) => {
        console.error('Auto regenerate error', err)
      })
    }
  }, [chatInstance, hasMessages, stopping, chatThread, selectedAgent])
}
