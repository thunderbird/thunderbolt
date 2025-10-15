import { relations } from 'drizzle-orm'
import { chatMessagesTable, chatThreadsTable, modelsTable } from './tables'

export const chatThreadsRelations = relations(chatThreadsTable, ({ many }) => ({
  messages: many(chatMessagesTable),
}))

export const chatMessagesRelations = relations(chatMessagesTable, ({ one, many }) => ({
  thread: one(chatThreadsTable, {
    fields: [chatMessagesTable.chatThreadId],
    references: [chatThreadsTable.id],
  }),
  model: one(modelsTable, {
    fields: [chatMessagesTable.modelId],
    references: [modelsTable.id],
  }),
  parent: one(chatMessagesTable, {
    fields: [chatMessagesTable.parentId],
    references: [chatMessagesTable.id],
    relationName: 'messageThread',
  }),
  children: many(chatMessagesTable, {
    relationName: 'messageThread',
  }),
}))

export const modelsRelations = relations(modelsTable, ({ many }) => ({
  chatMessages: many(chatMessagesTable),
}))
