/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isBuiltInAgent } from '@/defaults/agents'
import { matchesThreadConfidentiality, needsApiKey } from '@/settings/models/model-policy'
import type { Model } from '@/types'
import type { Agent } from '@/types/acp'

/**
 * Pick the model a session runs on once its agent is resolved. Only the
 * built-in agent uses the model, so `currentModel` stands unless the agent is
 * the built-in and the thread's private-chat lock rejects it. The send guard
 * in `chat-instance.ts` holds ACP agents to the lock too (every agent but the
 * hosted one); this helper does not cover that case.
 *
 * The built-in case happens when a hosted-agent thread (always `isEncrypted`
 * 0) reaches the built-in while the session still holds a confidential model:
 * the user switched agents (`setSelectedAgent`), or the hosted agent was not
 * yet synced on this device and hydration fell back (`useHydrateChatStore`).
 *
 * The replacement is the first of `models` the model picker leaves enabled
 * for the thread: same confidentiality, no missing API key. With none,
 * `currentModel` is kept and the composer holds the send until the model list
 * changes: `setModels` runs this again for every chat.
 */
export const resolveSessionModel = (
  agent: Agent,
  chatThread: { isEncrypted: number } | null,
  currentModel: Model,
  models: Model[],
): Model => {
  if (!isBuiltInAgent(agent) || matchesThreadConfidentiality(currentModel, chatThread)) {
    return currentModel
  }
  return models.find((model) => matchesThreadConfidentiality(model, chatThread) && !needsApiKey(model)) ?? currentModel
}
