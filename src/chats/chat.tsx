import { modelsTable, settingsTable } from '@/db/tables'
import { DatabaseSingleton } from '@/db/singleton'
import { Model, SaveMessagesFunction, Setting, type ThunderboltUIMessage } from '@/types'
import { useQuery } from '@tanstack/react-query'
import { eq } from 'drizzle-orm'
import ChatState from './chat-state'

interface ChatProps {
  id: string
  initialMessages?: ThunderboltUIMessage[]
  saveMessages: SaveMessagesFunction
}

export default function Chat({ id, initialMessages, saveMessages }: ChatProps) {
  const db = DatabaseSingleton.instance.db

  const { data: models = [] } = useQuery<Model[]>({
    queryKey: ['models'],
    queryFn: async () => {
      // Only fetch enabled models from the database
      return await db.select().from(modelsTable).where(eq(modelsTable.enabled, 1))
    },
  })

  const { data: settings = [] } = useQuery<Setting[]>({
    queryKey: ['settings'],
    queryFn: async () => {
      return await db.select().from(settingsTable)
    },
  })

  if (!models || !settings) {
    return <div>Loading...</div>
  }

  return <ChatState id={id} models={models} initialMessages={initialMessages} saveMessages={saveMessages} />
}
