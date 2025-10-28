import ChatState from './chat-state'
import { useChatPersistence } from './use-chat-persistence'

export default function ChatDetailPage() {
  const { chatThread, id, isLoading, messages, saveMessages } = useChatPersistence()

  if (!id) {
    return <div>No chat thread ID</div>
  }

  if (isLoading) {
    return null
  }

  return (
    <div className="h-full w-full">
      <ChatState key={id} chatThread={chatThread} id={id} initialMessages={messages} saveMessages={saveMessages} />
    </div>
  )
}
