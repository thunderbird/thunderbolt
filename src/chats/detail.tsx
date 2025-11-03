import ChatUI from '@/components/chat/chat-ui'
import { useHydrateChatStore } from './use-hydrate-chat-store'
import { useEffect } from 'react'
import { useChatAutomation } from './use-chat-automation'
import { SavePartialAssistantMessagesHandler } from './save-partial-assistant-messages-handler'

export default function ChatDetailPage() {
  const { hydrateChatStore, isReady, saveMessages } = useHydrateChatStore()

  useChatAutomation()

  useEffect(() => {
    hydrateChatStore()
  }, [hydrateChatStore])

  if (!isReady) {
    return null
  }

  return (
    <SavePartialAssistantMessagesHandler saveMessages={saveMessages}>
      <ChatUI />
    </SavePartialAssistantMessagesHandler>
  )
}
