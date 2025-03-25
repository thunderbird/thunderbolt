import { eq } from 'drizzle-orm'
import { settingsTable } from './db/schema'
import ImapClient from './imap/imap'
import { DrizzleContextType } from './types'

export const setSettings = async (db: DrizzleContextType['db'], key: string, value: any) => {
  await db
    .insert(settingsTable)
    .values({
      key,
      value: JSON.stringify(value),
      updated_at: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: settingsTable.key,
      set: {
        value: JSON.stringify(value),
        updated_at: new Date().toISOString(),
      },
    })
}

export const getSettings = async <T>(db: DrizzleContextType['db'], key: string): Promise<T | null> => {
  const result = await db.select().from(settingsTable).where(eq(settingsTable.key, key)).limit(1)

  if (result.length === 0) return null

  return JSON.parse(result[0].value as string) as T
}

export const getInboxSummary = async (db: DrizzleContextType['db'], imapClient: ImapClient) => {
  const inbox = await imapClient.fetchInbox()

  const summary = {
    totalMessages: inbox.length,
    unreadMessages: inbox.filter((message) => !message.seen).length,
    newMessages: inbox.filter((message) => !message.seen && !message.flagged).length,
  }

  return summary
}
