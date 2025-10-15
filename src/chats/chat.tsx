import { getAvailableModels } from '@/lib/dal'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { useQuery } from '@tanstack/react-query'
import ChatState from './chat-state'
import { useEffect } from 'react'

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

  useEffect(() => {
    console.log('DEBUG: Chat -> mounting')
    return () => {
      console.log('DEBUG: Chat -> unmounting')
    }
  }, [])

  return <ChatState id={id} models={models} initialMessages={initialMessages} saveMessages={saveMessages} />
}
