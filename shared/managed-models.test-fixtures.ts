/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultModelDeepseekV4Flash } from './defaults/models'
import { toManagedModel, type ManagedModels } from './managed-models'

const futureDirectModelId = '019f0000-0000-7000-8000-000000000001'

/** Create a schema-v1 catalog containing a direct model unknown to production code. */
export const createFutureDirectManagedModelsFixture = (): ManagedModels => ({
  schemaVersion: 1,
  version: 1,
  defaultModelId: futureDirectModelId,
  models: [
    toManagedModel({
      ...defaultModelDeepseekV4Flash,
      id: futureDirectModelId,
      model: 'future-direct-fixture',
      name: 'Future Direct Fixture',
      description: 'Test-only future direct managed model',
    }),
  ],
})
