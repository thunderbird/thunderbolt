/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { relations } from 'drizzle-orm'
import { chatMessagesTable, chatThreadsTable, modelProfilesTable, modelsSecretsTable, modelsTable } from './tables'

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

export const modelsRelations = relations(modelsTable, ({ one, many }) => ({
  chatMessages: many(chatMessagesTable),
  profile: one(modelProfilesTable, {
    fields: [modelsTable.id],
    references: [modelProfilesTable.modelId],
  }),
  secret: one(modelsSecretsTable, {
    fields: [modelsTable.id],
    references: [modelsSecretsTable.modelId],
  }),
}))

export const modelsSecretsRelations = relations(modelsSecretsTable, ({ one }) => ({
  model: one(modelsTable, {
    fields: [modelsSecretsTable.modelId],
    references: [modelsTable.id],
  }),
}))

export const modelProfilesRelations = relations(modelProfilesTable, ({ one }) => ({
  model: one(modelsTable, {
    fields: [modelProfilesTable.modelId],
    references: [modelsTable.id],
  }),
}))
