import { AssistantMessage } from './assistant-message'
import { TriggerMessage } from './trigger-message'
import { UserMessage } from './user-message'
import { EncryptionMessage } from './encryption-message'
import { ErrorMessage } from './error-message'
import { useEffect, useMemo, useRef } from 'react'
import { useCurrentChatSession } from '@/chats/chat-store'
import { shouldUseViewportPositioning } from '@/chats/use-chat-scroll-handler'
import { useHaptics } from '@/hooks/use-haptics'
import { useAcpChatActions } from '@/chats/use-acp-chat'
import type { SaveMessagesFunction } from '@/types'

type ChatMessagesProps = {
  saveMessages?: SaveMessagesFunction
}

export const ChatMessages = ({ saveMessages }: ChatMessagesProps) => {
  const {
    chatThread,
    id: chatThreadId,
    triggerData,
    retryCount,
    retriesExhausted,
    messages,
    status,
    error: chatError,
    agentConfig,
  } = useCurrentChatSession()

  const { regenerate } = useAcpChatActions(saveMessages)
  const { triggerNotification } = useHaptics()

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

  const hasError = useMemo(() => {
    if (chatError) {
      return true
    }
    return lastMessage?.role === 'assistant' && !lastMessage.parts?.length && !isStreaming
  }, [chatError, lastMessage, isStreaming])

  // Extract prompt from the first message (automation prompt) for trigger display
  const triggerPromptContent = useMemo(
    () =>
      triggerData?.wasTriggeredByAutomation && messages[0]?.parts?.[0]?.type === 'text'
        ? messages[0].parts[0].text
        : undefined,
    [messages, triggerData?.wasTriggeredByAutomation],
  )

  return (
    <div>
      {!!chatThread?.isEncrypted && agentConfig.type === 'built-in' && <EncryptionMessage />}
      {/* Automation trigger banner */}
      {triggerData?.wasTriggeredByAutomation && (
        <TriggerMessage
          chatThreadId={chatThreadId}
          title={triggerData.prompt?.title ?? undefined}
          prompt={triggerPromptContent}
          isDeleted={triggerData.isAutomationDeleted}
        />
      )}

      {messages.map((message, i) => {
        // Skip OAuth retry messages (they're hidden, only used to trigger regeneration)
        if (message.metadata?.oauthRetry === true) {
          return null
        }

        // Skip the very first user message if it was the automation prompt (already shown above)
        if (triggerData?.wasTriggeredByAutomation && i === 0) {
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
            />
          )
        }
        if (message.role === 'user') {
          return <UserMessage key={message.id} message={message} />
        }

        return null
      })}

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
