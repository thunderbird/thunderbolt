import { AssistantMessage } from './assistant-message'
import { TriggerMessage } from './trigger-message'
import { UserMessage } from './user-message'
import { EncryptionMessage } from './encryption-message'
import { ErrorMessage } from './error-message'
import { useMemo } from 'react'
import { useChatState } from '@/chats/chat-state-provider'
import { useChatData } from '@/chats/chat-data-provider'

export const ChatMessages = () => {
  const { chatThread, id: chatThreadId, triggerData } = useChatData()

  const { error, isStreaming, messages } = useChatState()

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
        // Skip the very first user message if it was the automation prompt (already shown above)
        if (triggerData?.wasTriggeredByAutomation && i === 0) {
          return null
        }

        if (message.role === 'assistant') {
          return (
            <AssistantMessage
              key={message.id}
              message={message}
              isStreaming={isStreaming && i === messages.length - 1}
            />
          )
        } else if (message.role === 'user') {
          return <UserMessage key={message.id} message={message} />
        }

        return null
      })}

      {/* Show error message if there's an error */}
      {!!error && <ErrorMessage message={error.message} />}
    </div>
  )
}
