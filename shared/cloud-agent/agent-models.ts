/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { CloudAgentConfig, CloudAgentModel } from './contracts'

type ModelConfig = Pick<CloudAgentConfig, 'models' | 'model' | 'localModelId'>

/** Read older single-model agents as an ordered selection without migrating stored ciphertext. */
export const agentModels = (config: ModelConfig): CloudAgentModel[] =>
  config.models ??
  (config.model || config.localModelId
    ? [
        {
          localModelId: config.localModelId ?? config.model?.sourceId,
          name: config.model?.modelId ?? config.localModelId ?? '',
          model: config.model,
        },
      ]
    : [])

/** The first enabled model is authoritative; retain default fields for existing runtime readers. */
export const agentModelPatch = (models: CloudAgentModel[]): ModelConfig => ({
  models,
  localModelId: models[0]?.localModelId,
  model: models[0]?.model ?? null,
})

/** Move one enabled model without changing the remaining models' relative order. */
export const moveAgentModel = <T>(models: T[], index: number, target: number): T[] => {
  if (index < 0 || index >= models.length || target < 0 || target >= models.length) {
    return models
  }
  const reordered = [...models]
  reordered.splice(index, 1)
  reordered.splice(target, 0, models[index])
  return reordered
}
