import { createModel } from '@/ai/fetch'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { emailMessagesTable, modelsTable, tasksTable } from '@/db/schema'
import { ImapSyncer } from '@/imap/sync'
import { generateObject } from 'ai'
import { eq, isNotNull } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'

export type RefreshTasksParams = {
  db: AnyDrizzleDatabase
}

export const refreshTasks = async ({ db }: RefreshTasksParams) => {
  // Delete existing tasks with email_thread_id
  await db.delete(tasksTable).where(isNotNull(tasksTable.emailMessageId))

  // Fetch emails from inbox
  // const { messages } = await imapClient.fetchMessages('INBOX', 1, 10)

  const syncer = new ImapSyncer(db, 'INBOX', 10)
  await syncer.syncPage(1, 10)

  const messages = await db.select().from(emailMessagesTable).where(eq(emailMessagesTable.mailbox, 'INBOX'))

  const modelConfigResults = await db.select().from(modelsTable).where(eq(modelsTable.isSystem, 1)).limit(1)
  const modelConfig = modelConfigResults.length > 0 ? modelConfigResults[0] : null

  if (!modelConfig) {
    throw new Error('No model found')
  }

  const model = await createModel(modelConfig)

  const emailsContext = messages
    .map(
      (message) =>
        `Message ID: ${message.id}\nSubject: ${message.subject || 'No subject'}\nFrom: ${message.fromAddress || 'Unknown'}\nSnippet: ${message.textBody?.substring(0, 300) || 'No content'}`,
    )
    .join('\n\n')

  const result = await generateObject({
    model,
    system: `You are an email assistant that turns emails into a to-do list. Provide up to 10 to-do items based on the emails provided while ensuring that you never duplicate items. Only include items that are appear important and actionable. Ignore items that appear to be newsletters, informational, solicitation, or promotional. If you reference a person, use their full name (the user might not know who they are). Assume the user has not read the emails and doesn't know anything about them or the people, places, or ideas mentioned in them. Don't refer to "the ___" (the user might not know what that is) - only refer to things by name. Keep each line under 100 characters.`,
    messages: [
      {
        role: 'user',
        content: `Here are the latest emails in my inbox. Please provide a summary:\n\n${emailsContext}`,
      },
    ],
    output: 'array',
    schema: z.object({
      emailMessageId: z.string(),
      item: z.string(),
    }),
    mode: 'json',
  })

  for (const task of result.object) {
    await db.insert(tasksTable).values({
      id: uuidv7(),
      item: task.item,
      emailMessageId: task.emailMessageId,
      order: 0,
      isComplete: 0,
    })
  }
}
