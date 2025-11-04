import { useChatStore } from '@/chats/chat-store'
import { useChat } from '@ai-sdk/react'
import { Lock } from 'lucide-react'
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { AssistantMessage } from './assistant-message'
import TimelineMessage from './timeline-message'
import { TriggerMessage } from './trigger-message'
import { UserMessage } from './user-message'

export const ChatMessages = () => {
  const { chatInstance, chatThread, chatThreadId, triggerData } = useChatStore(
    useShallow((state) => ({
      chatInstance: state.chatInstance!,
      chatThread: state.chatThread,
      chatThreadId: state.id!,
      triggerData: state.triggerData,
    })),
  )

  const { error, status, messages } = useChat({ chat: chatInstance })

  const isStreaming = status === 'streaming'

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
      {chatThread?.isEncrypted === 1 && (
        <TimelineMessage>
          <div className="flex flex-row items-center gap-2">
            <Lock className="size-4 text-blue-600 dark:text-blue-400" />
            <p className="text-blue-700 dark:text-blue-300">This conversation is encrypted</p>
          </div>
        </TimelineMessage>
      )}
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
      {error && (
        <div className="p-4 rounded-md bg-destructive/10 border border-destructive/20 mr-auto w-full">
          <p className="text-destructive font-medium mb-1">Error</p>
          <p className="text-destructive/80 text-sm">
            {error.message || 'An unexpected error occurred. Please try again.'}
          </p>
        </div>
      )}
    </div>
  )
}
