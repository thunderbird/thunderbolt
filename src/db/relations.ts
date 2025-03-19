import { relations } from 'drizzle-orm'
import { chatMessagesTable, chatThreadsTable, emailMessagesTable, embeddingsTable } from './schema'

export const chatThreadsRelations = relations(chatThreadsTable, ({ many }) => ({
  messages: many(chatMessagesTable),
}))

export const chatMessagesRelations = relations(chatMessagesTable, ({ one }) => ({
  thread: one(chatThreadsTable, {
    fields: [chatMessagesTable.chat_thread_id],
    references: [chatThreadsTable.id],
  }),
}))

export const embeddingsRelations = relations(embeddingsTable, ({ one }) => ({
  emailMessage: one(emailMessagesTable, {
    fields: [embeddingsTable.email_message_id],
    references: [emailMessagesTable.id],
  }),
}))

export const emailMessagesRelations = relations(emailMessagesTable, ({ one }) => ({
  embedding: one(embeddingsTable, {
    fields: [emailMessagesTable.id],
    references: [embeddingsTable.email_message_id],
  }),
}))
