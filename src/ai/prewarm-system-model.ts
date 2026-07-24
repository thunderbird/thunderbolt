/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Model } from '@/types'

/**
 * Warm a managed Tinfoil model without pulling the AI provider pipeline into
 * the initial bundle for every other model and agent.
 */
export const prewarmSystemModel = async (model: Pick<Model, 'provider' | 'isSystem'> | null | undefined) => {
  if (!model || model.provider !== 'tinfoil' || !model.isSystem) {
    return
  }
  const { prewarmSystemModel: prewarm } = await import('./fetch')
  await prewarm(model)
}
