/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  defaultModelOpus5,
  defaultModels,
  defaultModelsVersion,
  type SharedModel,
  vendorSupportsImages,
} from './defaults/models'

export type ManagedModelTransport = 'direct' | 'confidential'
export type ManagedModelInput = 'text' | 'image'

export type ManagedModel = {
  id: string
  model: string
  name: string
  description: string
  vendor: string
  transport: ManagedModelTransport
  capabilities: {
    input: ManagedModelInput[]
    tools: boolean
    parallelToolCalls: boolean
    reasoning: boolean
    contextWindow: number
  }
  defaults: { startWithReasoning: boolean }
}

export type ManagedModels = {
  schemaVersion: 1
  version: number
  defaultModelId: string
  models: ManagedModel[]
}

/** Convert a shipped model default into its public managed-catalog shape. */
export const toManagedModel = (model: SharedModel): ManagedModel => ({
  id: model.id,
  model: model.model,
  name: model.name,
  description: model.description!,
  vendor: model.vendor!,
  transport: model.isConfidential === 1 ? 'confidential' : 'direct',
  capabilities: {
    input: vendorSupportsImages(model.vendor) ? ['text', 'image'] : ['text'],
    tools: model.toolUsage === 1,
    parallelToolCalls: model.supportsParallelToolCalls === 1,
    reasoning: true,
    contextWindow: model.contextWindow!,
  },
  defaults: { startWithReasoning: model.startWithReasoning === 1 },
})

export const managedModels: ManagedModels = {
  schemaVersion: 1,
  version: defaultModelsVersion,
  defaultModelId: defaultModelOpus5.id,
  models: defaultModels.map(toManagedModel),
}
