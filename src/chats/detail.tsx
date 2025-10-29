import ChatUI from '@/components/chat/chat-ui'
import { ChatDataProvider } from './chat-data-provider'
import { ChatStateProvider } from './chat-state-provider'

export default function ChatDetailPage() {
  return (
    <ChatDataProvider>
      <ChatStateProvider>
        <ChatUI />
      </ChatStateProvider>
    </ChatDataProvider>
  )
}
