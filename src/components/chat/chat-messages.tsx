/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AssistantMessage } from './assistant-message'
import { SyntheticLoadingPart } from './synthetic-loading-part'
import { UserMessage } from './user-message'
import { ErrorMessage } from './error-message'
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef } from 'react'
import { useCurrentChatSession } from '@/chats/chat-store'
import { useChat as useChat_default } from '@ai-sdk/react'
import { messageRenderThrottleMs } from '@/chats/chat-throttle'
import { shouldUseViewportPositioning } from '@/chats/use-chat-scroll-handler'
import { isAttachmentPart } from '@/lib/attachments'
import { filterMessageParts } from '@/lib/assistant-message'
import { useHaptics } from '@/hooks/use-haptics'
import { useAttachmentRemediation } from './use-attachment-remediation'
import { QuoteReplyButton } from './quote-reply-button'
import { selectDebugTranscriptsEnabled, useConfigStore } from '@/api/config-store'
import type { ThunderboltUIMessage } from '@/types'

const ShareDebugTranscriptAction = lazy(async () => {
  const module = await import('@/components/share-debug-transcript')
  return { default: module.ShareDebugTranscriptAction }
})

// A failed turn leaves an assistant message whose parts render nothing (e.g. a lone
// `step-start`). It must not host the share action, or the button ends up floating
// alone under an invisible bubble instead of beside the copy button of the last
// message the user can actually see.
const rendersContent = (message: ThunderboltUIMessage) =>
  message.role === 'user' || filterMessageParts(message.parts).length > 0

type ChatMessagesProps = {
  useChat?: typeof useChat_default
}

// Memoized so it re-renders only on its own throttled `useChat` messages
// subscription (and chat-store changes), not every time the parent `ChatUI`
// re-renders. ChatUI re-renders at the union of several subscription timers
// (its own messages hook plus `useChatAutomation` / `useChatScrollHandler`), and
// without this, each of those forced this markdown/katex subtree to re-read the
// live message and re-render, multiplying per-token render work well past the
// intended throttle cadence. It takes no props that change (`useChat` defaults
// to the real hook), so the shallow prop compare holds across parent renders.
export const ChatMessages = memo(({ useChat = useChat_default }: ChatMessagesProps) => {
  const { chatInstance, chatThread, retryCount, retriesExhausted } = useCurrentChatSession()
  const debugTranscriptsEnabled = useConfigStore((state) => selectDebugTranscriptsEnabled(state.config))

  const {
    error: chatError,
    status,
    messages,
    regenerate,
    setMessages,
  } = useChat({
    chat: chatInstance,
    experimental_throttle: messageRenderThrottleMs,
  })
  const { triggerNotification } = useHaptics()

  const isStreaming = status === 'streaming'
  const wasStreaming = useRef(false)

  useEffect(() => {
    if (wasStreaming.current && !isStreaming) {
      triggerNotification(chatError ? 'error' : 'success')
    }
    wasStreaming.current = isStreaming
  }, [isStreaming, chatError, triggerNotification])

  const visibleMessages = useMemo(() => messages.filter((message) => message.metadata?.oauthRetry !== true), [messages])
  const lastMessage = useMemo(() => visibleMessages.at(-1), [visibleMessages])
  const shareActionHostId = useMemo(() => visibleMessages.findLast(rendersContent)?.id, [visibleMessages])
  const lastAssistantMessage = useMemo(
    () => visibleMessages.findLast((message) => message.role === 'assistant' && (message.parts?.length ?? 0) > 0),
    [visibleMessages],
  )
  const shareDebugTranscriptAction = useMemo(
    () =>
      debugTranscriptsEnabled &&
      chatThread &&
      visibleMessages.length > 0 &&
      status !== 'submitted' &&
      status !== 'streaming' ? (
        <Suspense fallback={null}>
          <ShareDebugTranscriptAction chatInstance={chatInstance} threadId={chatThread.id} />
        </Suspense>
      ) : undefined,
    [chatInstance, chatThread, debugTranscriptsEnabled, status, visibleMessages.length],
  )

  // After the user sends a message, AI SDK reports status `submitted` until the
  // first assistant delta arrives. During that window there is no assistant
  // message to host the synthetic loading indicator, so render it inline here.
  const showSubmittedLoading = status === 'submitted' && lastMessage?.role !== 'assistant'

  const emptyAssistantTurn = lastMessage?.role === 'assistant' && !lastMessage.parts?.length && !isStreaming
  const pendingEmptyTurnRecovery = emptyAssistantTurn && !chatError && !retriesExhausted

  const hasError = useMemo(() => {
    if (chatError) {
      return true
    }
    return emptyAssistantTurn && retriesExhausted
  }, [chatError, emptyAssistantTurn, retriesExhausted])

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
  const lastUserMessageId = useMemo(
    () => visibleMessages.findLast((message) => message.role === 'user')?.id,
    [visibleMessages],
  )
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
      {visibleMessages.map((message) => {
        if (message.role === 'assistant') {
          // Hide empty assistant messages during errors — these are broken responses
          // that regenerate() will remove. Messages with parts are valid responses.
          if ((hasError || pendingEmptyTurnRecovery) && !message.parts?.length) {
            return null
          }

          // Memoize last message check to avoid recalculating on every iteration
          const isLast = message.id === lastMessage?.id
          // Only apply viewport positioning from second message onwards
          const shouldApplyViewport = isLast && shouldUseViewportPositioning(visibleMessages.length)

          return (
            <AssistantMessage
              key={message.id}
              message={message}
              isStreaming={isStreaming && isLast}
              isLastMessage={shouldApplyViewport}
              isLastAssistantMessage={message.id === lastAssistantMessage?.id}
              lastAssistantAction={message.id === shareActionHostId ? shareDebugTranscriptAction : undefined}
            />
          )
        }
        if (message.role === 'user') {
          return (
            <UserMessage
              key={message.id}
              message={message}
              lastMessageAction={message.id === shareActionHostId ? shareDebugTranscriptAction : undefined}
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
      {(showSubmittedLoading || suppressError || pendingEmptyTurnRecovery) && <SyntheticLoadingPart isStreaming />}

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

      {/* Floating "Reply" button over any text selection within a response. */}
      <QuoteReplyButton />
    </div>
  )
})

ChatMessages.displayName = 'ChatMessages'
