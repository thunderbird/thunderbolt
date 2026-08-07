/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The run spec for a runner-placed turn: which model executes it, and how deeply
 * it reasons.
 *
 * The client owns both choices and the runner never substitutes a model, so the
 * spec must carry the id the backend inference gateway accepts — `Model.model`,
 * the gateway id — and never `Model.id`, which is a local row id meaningless off
 * this device. Reasoning depth comes from the model's profile, the same signal
 * the in-browser harness reads, so a thread reasons identically wherever it runs.
 */

import { getModelProfile as defaultGetModelProfile } from '@/dal/model-profiles'
import { getDb as defaultGetDb } from '@/db/database'
import type { Model } from '@/types'
import type { RunSpec } from '@shared/acp-types'
import { deriveThinkingLevel } from './thinking-level'

/** DI seam so tests resolve a run spec without a database. */
export type RunSpecDeps = {
  getDb?: typeof defaultGetDb
  getModelProfile?: typeof defaultGetModelProfile
}

/**
 * Resolve the run spec for a model.
 *
 * @param model - the thread's selected model
 * @param deps - profile-read overrides for tests
 */
export const resolveRunSpec = async (model: Model, deps: RunSpecDeps = {}): Promise<RunSpec> => {
  const getModelProfile = deps.getModelProfile ?? defaultGetModelProfile
  const profile = await getModelProfile((deps.getDb ?? defaultGetDb)(), model.id)
  return { modelId: model.model, thinkingLevel: deriveThinkingLevel(profile) }
}
