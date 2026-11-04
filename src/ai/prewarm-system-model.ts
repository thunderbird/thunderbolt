/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isBuiltInAgent } from '@/defaults/agents'
import type { Model } from '@/types'
import type { Agent } from '@/types/acp'

/**
 * Warm a managed Tinfoil model without pulling the AI provider pipeline into
 * the initial bundle for every other model and agent. Best-effort: it never
 * rejects, so callers can fire and forget.
 */
export const prewarmSystemModel = async (
  model: Pick<Model, 'provider' | 'isSystem'> | null | undefined,
  loadPrewarm = async () => (await import('./tinfoil-client')).runSystemModelPrewarm,
) => {
  if (!model || model.provider !== 'tinfoil' || !model.isSystem) {
    return
  }
  try {
    const runSystemModelPrewarm = await loadPrewarm()
    await runSystemModelPrewarm(model)
  } catch (error) {
    // WebKit rejects the import when a navigation cancels the chunk fetch mid-flight.
    console.warn('prewarmSystemModel: warm-up skipped', error)
  }
}

/** Warm locally executed agents' model transport before a first send. */
export const prewarmAgentModel = async (
  agent: Agent,
  model: Pick<Model, 'provider' | 'isSystem'> | null | undefined,
  prewarm = prewarmSystemModel,
): Promise<void> => {
  if (isBuiltInAgent(agent)) {
    await prewarm(model)
  }
}
