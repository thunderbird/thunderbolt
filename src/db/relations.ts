import { relations } from 'drizzle-orm'
import {
  chatMessagesTable,
  chatThreadsTable,
  contactsTable,
  emailAddressesTable,
  emailMessagesTable,
  emailMessagesToAddressesTable,
  emailThreadsTable,
  embeddingsTable,
  modelsTable,
  settingsTable,
  tasksTable,
} from './tables'

export const chatThreadsRelations = relations(chatThreadsTable, ({ many }) => ({
  messages: many(chatMessagesTable),
}))

export const chatMessagesRelations = relations(chatMessagesTable, ({ one }) => ({
  thread: one(chatThreadsTable, {
    fields: [chatMessagesTable.chatThreadId],
    references: [chatThreadsTable.id],
  }),
  model: one(modelsTable, {
    fields: [chatMessagesTable.modelId],
    references: [modelsTable.id],
  }),
}))

export const embeddingsRelations = relations(embeddingsTable, ({ one }) => ({
  emailMessage: one(emailMessagesTable, {
    fields: [embeddingsTable.emailMessageId],
    references: [emailMessagesTable.id],
  }),
  emailThread: one(emailThreadsTable, {
    fields: [embeddingsTable.emailThreadId],
    references: [emailThreadsTable.id],
  }),
}))

export const emailMessagesRelations = relations(emailMessagesTable, ({ one, many }) => ({
  embedding: one(embeddingsTable, {
    fields: [emailMessagesTable.id],
    references: [embeddingsTable.emailMessageId],
  }),
  thread: one(emailThreadsTable, {
    fields: [emailMessagesTable.emailThreadId],
    references: [emailThreadsTable.id],
  }),
  sender: one(emailAddressesTable, {
    fields: [emailMessagesTable.fromAddress],
    references: [emailAddressesTable.address],
  }),
  recipients: many(emailMessagesToAddressesTable),
}))

export const emailThreadsRelations = relations(emailThreadsTable, ({ many, one }) => ({
  emailMessages: many(emailMessagesTable),
  embedding: one(embeddingsTable, {
    fields: [emailThreadsTable.id],
    references: [embeddingsTable.emailThreadId],
  }),
  tasks: many(tasksTable),
}))

export const contactsRelations = relations(contactsTable, ({ many }) => ({
  emailAddresses: many(emailAddressesTable),
}))

export const emailAddressesRelations = relations(emailAddressesTable, ({ one, many }) => ({
  contact: one(contactsTable, {
    fields: [emailAddressesTable.contactId],
    references: [contactsTable.id],
  }),
  sentEmailMessages: many(emailMessagesTable, { relationName: 'fromEmailAddress' }),
  receivedEmailMessages: many(emailMessagesToAddressesTable),
}))

export const emailMessagesToAddressesRelations = relations(emailMessagesToAddressesTable, ({ one }) => ({
  message: one(emailMessagesTable, {
    fields: [emailMessagesToAddressesTable.emailMessageId],
    references: [emailMessagesTable.id],
  }),
  address: one(emailAddressesTable, {
    fields: [emailMessagesToAddressesTable.emailAddressId],
    references: [emailAddressesTable.address],
  }),
}))

export const tasksRelations = relations(tasksTable, ({ many }) => ({
  emailThreads: many(emailThreadsTable),
}))

export const settingsRelations = relations(settingsTable, () => ({}))

export const modelsRelations = relations(modelsTable, ({ many }) => ({
  chatMessages: many(chatMessagesTable),
}))
