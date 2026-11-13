/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isBuiltInAgent } from '@/defaults/agents'
import { isModelReady } from '@/settings/models/model-policy'
import type { Model } from '@/types'
import type { Agent } from '@/types/acp'

/**
 * Resolve built-in inference against the current available-model list so edits,
 * credential changes, and provider disconnects cannot leave a stale selection.
 * Prefer the selected model when still usable, then the first available model. With none, retain a placeholder: the composer
 * and send guard independently reject selections absent from the usable list.
 * Other agents manage their own inference and keep their selection untouched.
 */
export const resolveSessionModel = (
  agent: Agent,
  _chatThread: { isEncrypted: number } | null,
  currentModel: Model,
  models: Model[],
): Model => {
  if (!isBuiltInAgent(agent)) {
    return currentModel
  }
  const available = models.filter((model) => isModelReady(model))
  return available.find((model) => model.id === currentModel.id) ?? available[0] ?? currentModel
}
