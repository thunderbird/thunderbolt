/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AssistantMessage } from './assistant-message'
import { SyntheticLoadingPart } from './synthetic-loading-part'
import { UserMessage } from './user-message'
import { ErrorMessage } from './error-message'
import { useEffect, useMemo, useRef } from 'react'
import { useCurrentChatSession } from '@/chats/chat-store'
import { useChat as useChat_default } from '@ai-sdk/react'
import { shouldUseViewportPositioning } from '@/chats/use-chat-scroll-handler'
import { useHaptics } from '@/hooks/use-haptics'
import { getLoadingLabel } from '@/lib/loading-labels'
import { isBuiltInAgent } from '@/defaults/agents'

type ChatMessagesProps = {
  useChat?: typeof useChat_default
}

export const ChatMessages = ({ useChat = useChat_default }: ChatMessagesProps) => {
  const { chatInstance, retryCount, retriesExhausted, selectedAgent, selectedMode } = useCurrentChatSession()

  const { error: chatError, status, messages, regenerate } = useChat({ chat: chatInstance })
  const { triggerNotification } = useHaptics()

  // Mode-aware status shown in the loading window before the first token. Pure
  // render-time derive — search/research get a specific label, chat keeps the
  // plain spinner (undefined). ACP agents own their conversation mode upstream
  // and ignore `selectedMode` (mirroring ChatModePicker), so a stale built-in
  // mode must not leak a false "Searching the web…" label onto an ACP chat.
  const loadingMessage = isBuiltInAgent(selectedAgent) ? getLoadingLabel(selectedMode.name) : undefined

  const isStreaming = status === 'streaming'
  const wasStreaming = useRef(false)

  useEffect(() => {
    if (wasStreaming.current && !isStreaming) {
      triggerNotification(chatError ? 'error' : 'success')
    }
    wasStreaming.current = isStreaming
  }, [isStreaming, chatError, triggerNotification])

  const lastMessage = useMemo(() => messages[messages.length - 1], [messages])
  const lastAssistantMessage = useMemo(
    () => messages.findLast((m) => m.role === 'assistant' && (m.parts?.length ?? 0) > 0),
    [messages],
  )

  // After the user sends a message, AI SDK reports status `submitted` until the
  // first assistant delta arrives. During that window there is no assistant
  // message to host the synthetic loading indicator, so render it inline here.
  const showSubmittedLoading = status === 'submitted' && lastMessage?.role !== 'assistant'

  const hasError = useMemo(() => {
    if (chatError) {
      return true
    }
    return lastMessage?.role === 'assistant' && !lastMessage.parts?.length && !isStreaming
  }, [chatError, lastMessage, isStreaming])

  return (
    <div>
      {messages.map((message) => {
        // Skip OAuth retry messages (they're hidden, only used to trigger regeneration)
        if (message.metadata?.oauthRetry === true) {
          return null
        }

        if (message.role === 'assistant') {
          // Hide empty assistant messages during errors — these are broken responses
          // that regenerate() will remove. Messages with parts are valid responses.
          if (hasError && !message.parts?.length) {
            return null
          }

          // Memoize last message check to avoid recalculating on every iteration
          const isLast = message === lastMessage
          // Only apply viewport positioning from second message onwards
          const shouldApplyViewport = isLast && shouldUseViewportPositioning(messages.length)

          return (
            <AssistantMessage
              key={message.id}
              message={message}
              isStreaming={isStreaming && isLast}
              isLastMessage={shouldApplyViewport}
              isLastAssistantMessage={message === lastAssistantMessage}
              loadingMessage={loadingMessage}
            />
          )
        }
        if (message.role === 'user') {
          return <UserMessage key={message.id} message={message} />
        }

        return null
      })}

      {showSubmittedLoading && <SyntheticLoadingPart isStreaming message={loadingMessage} />}

      {/* Show error message if there's an error */}
      {hasError && (
        <ErrorMessage
          retryCount={retryCount}
          retriesExhausted={retriesExhausted}
          error={chatError}
          onRetry={() => regenerate()}
        />
      )}
    </div>
  )
}
