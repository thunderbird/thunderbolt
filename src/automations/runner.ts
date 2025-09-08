import { DatabaseSingleton } from '@/db/singleton'
import { chatMessagesTable, chatThreadsTable, modelsTable, promptsTable } from '@/db/tables'
import { convertUIMessageToDbChatMessage } from '@/lib/utils'
import type { UIMessage } from 'ai'
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

type Navigate = (url: string) => void

/**
 * Runs an automation by creating a new chat thread and seeding it with the prompt.
 * Navigation to the thread will trigger the AI streaming response.
 */
export const runAutomation = async (promptId: string, navigate?: Navigate) => {
  const db = DatabaseSingleton.instance.db

  const prompt = await db.select().from(promptsTable).where(eq(promptsTable.id, promptId)).get()
  if (!prompt) throw new Error('Prompt not found')

  const model = await db.select().from(modelsTable).where(eq(modelsTable.id, prompt.modelId)).get()
  if (!model) throw new Error('Model not found')

  const threadId = uuidv7()

  await db.insert(chatThreadsTable).values({
    id: threadId,
    title: prompt.title ?? 'Automation',
    triggeredBy: prompt.id,
    wasTriggeredByAutomation: 1,
  })

  const userMessage: UIMessage = {
    id: uuidv7(),
    role: 'user',
    metadata: { modelId: model.id },
    parts: [{ type: 'text', text: prompt.prompt }],
  }

  await db.insert(chatMessagesTable).values(convertUIMessageToDbChatMessage(userMessage, threadId))

  navigate?.(`/chats/${threadId}`)
}
