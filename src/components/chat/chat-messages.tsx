/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AssistantMessage } from './assistant-message'
import { SyntheticLoadingPart } from './synthetic-loading-part'
import { UserMessage } from './user-message'
import { ErrorMessage } from './error-message'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useCurrentChatSession } from '@/chats/chat-store'
import { useChat as useChat_default } from '@ai-sdk/react'
import { shouldUseViewportPositioning } from '@/chats/use-chat-scroll-handler'
import { isAttachmentPart } from '@/lib/attachments'
import { useHaptics } from '@/hooks/use-haptics'
import { useAttachmentRemediation } from './use-attachment-remediation'
import { getLoadingLabel } from '@/lib/loading-labels'
import { isBuiltInAgent } from '@/defaults/agents'

type ChatMessagesProps = {
  useChat?: typeof useChat_default
}

export const ChatMessages = ({ useChat = useChat_default }: ChatMessagesProps) => {
  const { chatInstance, retryCount, retriesExhausted, selectedAgent, selectedMode } = useCurrentChatSession()

  const { error: chatError, status, messages, regenerate, setMessages } = useChat({ chat: chatInstance })
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

  // Re-deliver a failed turn's attachments as text/images (auto on a detected
  // content-rejection, or via the buttons below). Gate auto-fire on a settled error.
  const { suppressError, deliveryExhausted } = useAttachmentRemediation({
    messages,
    setMessages,
    regenerate,
    error: chatError,
    active: hasError && !isStreaming,
  })

  // Manual override for the latest turn's attachments: re-deliver a single file
  // as text/images and re-run (for when auto-remediation delivered something but
  // the answer was poor). Scoped to the last user message so older bubbles stay
  // presentational and don't re-render while streaming.
  const lastUserMessageId = useMemo(() => messages.findLast((m) => m.role === 'user')?.id, [messages])
  const resendAttachment = useCallback(
    (messageId: string, localFileId: string, target: 'text' | 'images') => {
      setMessages((prev) =>
        prev.map((message) =>
          message.id === messageId
            ? {
                ...message,
                parts: message.parts.map((part) =>
                  isAttachmentPart(part) && part.data.localFileId === localFileId
                    ? { ...part, data: { ...part.data, deliverAs: target } }
                    : part,
                ),
              }
            : message,
        ),
      )
      regenerate()
    },
    [setMessages, regenerate],
  )

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
          return (
            <UserMessage
              key={message.id}
              message={message}
              onResendAttachment={
                message.id === lastUserMessageId
                  ? (localFileId, target) => resendAttachment(message.id, localFileId, target)
                  : undefined
              }
            />
          )
        }

        return null
      })}

      {/* Keep a loading indicator up while remediation re-delivers + retries, so
          the suppressed error doesn't leave a blank gap. */}
      {(showSubmittedLoading || suppressError) && <SyntheticLoadingPart isStreaming message={loadingMessage} />}

      {/* Show error message if there's an error and remediation isn't taking over */}
      {hasError && !suppressError && (
        <ErrorMessage
          retryCount={retryCount}
          retriesExhausted={retriesExhausted}
          error={chatError}
          onRetry={() => regenerate()}
          deliveryExhausted={deliveryExhausted}
        />
      )}
    </div>
  )
}
