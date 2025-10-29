import { createContext, type PropsWithChildren, useCallback, useContext, useMemo } from 'react'
import { useChatData } from './chat-data-provider'
import { useChatModel } from './use-chat-model'
import { useChatHelpers } from './use-chat-helpers'
import { useSavePartialAssistantMessages } from './use-save-partial-assistant-messages'
import { useChatAutomation } from './use-chat-automation'
import type { Model, ThunderboltUIMessage } from '@/types'
import { trackEvent } from '@/lib/posthog'

type ChatStateState = {
  error: Error | undefined
  handleModelChange: (modelId: string | null) => void
  handleSendMessage: (text: string) => Promise<void>
  handleStop: () => Promise<void>
  hasMessages: boolean
  isStreaming: boolean
  messages: ThunderboltUIMessage[]
  selectedModel: Model
}

const ChatStateContext = createContext<ChatStateState>({} as ChatStateState)

export function ChatStateProvider({ children }: PropsWithChildren) {
  const { chatThread } = useChatData()

  const { handleModelChange, selectedModel } = useChatModel()

  const chatHelpers = useChatHelpers({
    selectedModel,
  })

  const isStreaming = useMemo(() => chatHelpers.status === 'streaming', [chatHelpers.status])

  const messages = useMemo(() => chatHelpers.messages, [chatHelpers.messages])

  useSavePartialAssistantMessages({ isStreaming, messages })

  useChatAutomation({ chatHelpers, selectedModelId: selectedModel.id })

  const validateEncryptionState = useCallback(() => {
    if (chatThread && chatThread.isEncrypted !== selectedModel?.isConfidential) {
      throw new Error(
        `This model is not available for ${chatThread.isEncrypted === 1 ? 'encrypted' : 'unencrypted'} conversations.`,
      )
    }
  }, [chatThread, selectedModel])

  const handleSendMessage = useCallback(
    async (text: string) => {
      await validateEncryptionState()

      await chatHelpers.sendMessage({
        text,
        metadata: {
          modelId: selectedModel.id,
        },
      })

      trackEvent('chat_send_prompt', {
        model: selectedModel,
        length: text.length,
        prompt_number: chatHelpers.messages.length + 1,
      })
    },
    [chatHelpers, selectedModel, validateEncryptionState],
  )

  return (
    <ChatStateContext.Provider
      value={{
        handleModelChange,
        handleSendMessage,
        handleStop: chatHelpers.stop,
        error: chatHelpers.error,
        hasMessages: chatHelpers.messages.length > 0,
        isStreaming,
        messages,
        selectedModel,
      }}
    >
      {children}
    </ChatStateContext.Provider>
  )
}

export const useChatState = () => {
  const context = useContext(ChatStateContext)

  if (context === undefined) throw new Error('useChatState must be used within a ChatStateProvider')

  return context
}
