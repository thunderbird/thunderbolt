/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { runSystemModelPrewarm } from './tinfoil-client'

import type { Model } from '@/types'

/**
 * Warm a managed Tinfoil model. Best-effort: it never
 * rejects, so callers can fire and forget.
 */
export const prewarmSystemModel = async (
  model: Pick<Model, 'provider' | 'isSystem'> | null | undefined,
  loadPrewarm = async () => runSystemModelPrewarm,
) => {
  if (!model || model.provider !== 'tinfoil' || !model.isSystem) {
    return
  }
  try {
    const runSystemModelPrewarm = await loadPrewarm()
    await runSystemModelPrewarm(model)
  } catch (error) {
    console.warn('prewarmSystemModel: warm-up skipped', error)
  }
}
