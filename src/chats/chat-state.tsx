import ChatUI from '@/components/chat/chat-ui'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { useChatModel } from './use-chat-model'
import { useChatAutomation } from './use-chat-automation'
import { useChatHelpers } from './use-chat-helpers'
import { useSavePartialAssistantMessages } from './use-save-partial-assistant-messages'

interface ChatStateProps {
  id: string
  initialMessages: ThunderboltUIMessage[]
  saveMessages: SaveMessagesFunction
}

export default function ChatState({ id, initialMessages, saveMessages }: ChatStateProps) {
  const { handleModelChange, models, selectedModelId, selectedModelIdRef } = useChatModel(id)

  const chatHelpers = useChatHelpers({
    chatThreadId: id,
    initialMessages,
    saveMessages,
    selectedModelIdRef,
  })

  useSavePartialAssistantMessages({ chatHelpers, chatThreadId: id, saveMessages })

  const { triggerData } = useChatAutomation({ chatHelpers, chatThreadId: id, selectedModelId })

  // If we don't pass a selectedModelId to the ChatUI, it will warn about changing an input from uncontrolled to controlled
  if (!selectedModelId) {
    return null
  }

  return (
    <ChatUI
      chatHelpers={chatHelpers}
      models={models}
      selectedModelId={selectedModelId ?? undefined}
      onModelChange={handleModelChange}
      triggerAutomation={triggerData ?? undefined}
      chatThreadId={id}
    />
  )
}
