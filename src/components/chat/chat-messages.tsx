import { AssistantMessage } from './assistant-message'
import { TriggerMessage } from './trigger-message'
import { UserMessage } from './user-message'
import { EncryptionMessage } from './encryption-message'
import { ErrorMessage } from './error-message'
import { useMemo } from 'react'
import { useCurrentChatSession } from '@/chats/chat-store'
import { useChat as useChat_default } from '@ai-sdk/react'
import { shouldUseViewportPositioning } from '@/chats/use-chat-scroll-handler'

type ChatMessagesProps = {
  useChat?: typeof useChat_default
}

export const ChatMessages = ({ useChat = useChat_default }: ChatMessagesProps) => {
  const {
    chatInstance,
    chatThread,
    id: chatThreadId,
    triggerData,
    retryCount,
    retriesExhausted,
  } = useCurrentChatSession()

  const { error: chatError, status, messages, regenerate } = useChat({ chat: chatInstance })

  const isStreaming = status === 'streaming'

  const hasError = useMemo(() => {
    if (chatError) return true

    const lastMessage = messages[messages.length - 1]
    return lastMessage?.role === 'assistant' && !lastMessage.parts?.length && !isStreaming
  }, [chatError, messages, isStreaming])

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
      {!!chatThread?.isEncrypted && <EncryptionMessage />}
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
          // Hide the last assistant message only if it's the broken empty response
          // that regenerate() will remove. Don't hide valid previous responses.
          if (hasError && !message.parts?.length) return null

          const isLastMessage = i === messages.length - 1
          // Only apply viewport positioning from second message onwards
          const shouldApplyViewport = isLastMessage && shouldUseViewportPositioning(messages.length)

          return (
            <AssistantMessage
              key={message.id}
              message={message}
              isStreaming={isStreaming && isLastMessage}
              isLastMessage={shouldApplyViewport}
            />
          )
        } else if (message.role === 'user') {
          return <UserMessage key={message.id} message={message} />
        }

        return null
      })}

      {/* Show error message if there's an error */}
      {hasError && (
        <ErrorMessage retryCount={retryCount} retriesExhausted={retriesExhausted} onRetry={() => regenerate()} />
      )}
    </div>
  )
}
