/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isBuiltInAgent, isModelAvailableForAgent } from '@/defaults/agents'
import type { Model } from '@/types'
import type { Agent } from '@/types/acp'

/**
 * Pick an available model within the agent's policy. A legacy thread's
 * confidentiality flag does not choose its model anymore. If no compatible
 * model is configured, retain its latest unavailable value so the composer and
 * send guard can report the problem instead of silently changing agents. A
 * removed model is marked disabled so stale credentials cannot keep it running.
 */
export const resolveSessionModel = (agent: Agent, currentModel: Model, models: Model[]): Model => {
  if (!isBuiltInAgent(agent)) {
    return currentModel
  }
  const isAvailable = (model: Model) => isModelAvailableForAgent(agent, model)
  const latestModel = models.find((model) => model.id === currentModel.id) ?? { ...currentModel, enabled: 0 }
  if (isAvailable(latestModel)) {
    return latestModel
  }
  return models.find(isAvailable) ?? latestModel
}
