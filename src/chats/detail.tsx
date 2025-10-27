import ChatState from './chat-state'
import { useChatPersistence } from './use-chat-persistence'

export default function ChatDetailPage() {
  const { id, isLoading, messages, saveMessages } = useChatPersistence()

  if (!id) {
    return <div>No chat thread ID</div>
  }

  if (isLoading) {
    return null
  }

  return (
    <div className="h-full w-full">
      <ChatState key={id} id={id} initialMessages={messages} saveMessages={saveMessages} />
    </div>
  )
}
