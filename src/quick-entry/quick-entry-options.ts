/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resolveChatAgent } from '@/chats/resolve-chat-agent'
import {
  getAllAgents,
  getAllChatThreads,
  getAllSystemAgents,
  getAvailableModels,
  getSelectedModel,
  getSettings,
  updateSettings,
} from '@/dal'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { isBuiltInAgent } from '@/defaults/agents'
import { chatTitleLabel } from '@/lib/title-generator'
import type { I18n } from '@lingui/core'
import { type QuickEntryOptionsPayload, redactedApiKey } from './events'

/**
 * What the Quick Entry pickers show. Runs in the main window, which owns the
 * database.
 *
 * Models: the ones a new chat could start on, with the one it would start on
 * selected. Empty when a new chat would land on an external agent: those choose
 * their model upstream, and the composer hides its picker for them too.
 *
 * Chats: every chat the sidebar lists, most recently active first, except Mini
 * App chats, which open inside their app rather than at `/chats/:id`.
 */
export const loadQuickEntryOptions = async (db: AnyDrizzleDatabase, i18n: I18n): Promise<QuickEntryOptionsPayload> => {
  const [settings, models, selectedModel, customAgentRows, systemAgentRows, threads] = await Promise.all([
    getSettings(db, { selected_model: String, selected_agent: String }),
    getAvailableModels(db),
    getSelectedModel(db),
    getAllAgents(db),
    getAllSystemAgents(db),
    getAllChatThreads(db),
  ])
  const chats = threads
    .filter((thread) => !thread.miniAppId)
    .map((thread) => ({ id: thread.id, title: chatTitleLabel(i18n, thread.title) }))
  const agent = resolveChatAgent({ chatThread: null, settings, customAgentRows, systemAgentRows })
  if (!isBuiltInAgent(agent)) {
    return { models: [], selectedModelId: null, chats }
  }
  return {
    models: models.map((model) => ({ ...model, apiKey: model.apiKey ? redactedApiKey : null })),
    selectedModelId: selectedModel.id,
    chats,
  }
}

/**
 * Make the model picked in Quick Entry the one a new chat starts on. A new chat
 * reads `selected_model` when it hydrates, and picking a model in the composer
 * writes the same setting, so this is the composer's pick made one step early.
 */
export const applyQuickEntryModel = async (db: AnyDrizzleDatabase, modelId: string | null) => {
  if (!modelId) {
    return
  }
  const { selectedModel } = await getSettings(db, { selected_model: String })
  if (selectedModel !== modelId) {
    await updateSettings(db, { selected_model: modelId })
  }
}
