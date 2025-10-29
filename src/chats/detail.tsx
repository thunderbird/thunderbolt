import { ChatDataProvider } from './chat-data-provider'
import ChatState from './chat-state'

export default function ChatDetailPage() {
  return (
    <ChatDataProvider>
      <div className="h-full w-full">
        <ChatState />
      </div>
    </ChatDataProvider>
  )
}
