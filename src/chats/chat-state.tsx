import ChatUI from '@/components/chat/chat-ui'
import { useChatModel } from './use-chat-model'
import { useChatAutomation } from './use-chat-automation'
import { useChatHelpers } from './use-chat-helpers'
import { useSavePartialAssistantMessages } from './use-save-partial-assistant-messages'
import { useChatData } from './chat-data-provider'

export default function ChatState() {
  const { chatThread, id, messages: initialMessages, models, saveMessages, triggerData } = useChatData()

  const { handleModelChange, selectedModelId } = useChatModel(id)

  const chatHelpers = useChatHelpers({
    chatThread,
    chatThreadId: id,
    initialMessages,
    saveMessages,
    models,
    selectedModelId,
  })

  useSavePartialAssistantMessages({ chatHelpers, chatThreadId: id, saveMessages })

  useChatAutomation({ chatHelpers, selectedModelId })

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
      chatThread={chatThread}
    />
  )
}
