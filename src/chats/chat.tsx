import { getAvailableModels, getAllSettings } from '@/lib/dal'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { useQuery } from '@tanstack/react-query'
import ChatState from './chat-state'

interface ChatProps {
  id: string
  initialMessages?: ThunderboltUIMessage[]
  saveMessages: SaveMessagesFunction
}

export default function Chat({ id, initialMessages, saveMessages }: ChatProps) {
  const { data: models = [] } = useQuery({
    queryKey: ['models'],
    queryFn: getAvailableModels,
  })

  const { data: settings = [] } = useQuery({
    queryKey: ['settings'],
    queryFn: getAllSettings,
  })

  if (!models || !settings) {
    return <div>Loading...</div>
  }

  return <ChatState id={id} models={models} initialMessages={initialMessages} saveMessages={saveMessages} />
}
