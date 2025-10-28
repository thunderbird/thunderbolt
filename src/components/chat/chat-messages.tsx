import type { AutomationRun, ThunderboltUIMessage } from '@/types'
import { AssistantMessage } from './assistant-message'
import { TriggerMessage } from './trigger-message'
import { UserMessage } from './user-message'
import { EncryptionMessage } from './encryption-message'
import { ErrorMessage } from './error-message'
import { memo } from 'react'

interface ChatMessagesProps {
  chatThreadId: string
  error: string
  isEncrypted: boolean
  isStreaming: boolean
  messages: ThunderboltUIMessage[]
  triggerAutomation?: AutomationRun | null
}

export const ChatMessages = memo(
  ({ chatThreadId, error, isEncrypted, isStreaming, messages, triggerAutomation }: ChatMessagesProps) => {
    // Extract prompt from the first message (automation prompt) for trigger display
    const triggerPromptContent =
      triggerAutomation?.wasTriggeredByAutomation && messages[0]?.parts?.[0]?.type === 'text'
        ? messages[0].parts[0].text
        : undefined

    return (
      <>
        {isEncrypted && <EncryptionMessage />}
        {/* Automation trigger banner */}
        {triggerAutomation?.wasTriggeredByAutomation && (
          <TriggerMessage
            chatThreadId={chatThreadId}
            title={triggerAutomation.prompt?.title ?? undefined}
            prompt={triggerPromptContent}
            isDeleted={triggerAutomation.isAutomationDeleted}
          />
        )}

        {messages.map((message, i) => {
          // Skip the very first user message if it was the automation prompt (already shown above)
          if (triggerAutomation?.wasTriggeredByAutomation && i === 0) {
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
        {error && <ErrorMessage message={error} />}
      </>
    )
  },
)
