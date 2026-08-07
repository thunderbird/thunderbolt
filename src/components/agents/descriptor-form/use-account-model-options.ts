/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Resolves the `account-models` option source for descriptor `select` fields:
 * the user's deployable account models, read reactively from the already-synced
 * local `models` table. `value` is the model's local id (so the submit step can
 * resolve the full model + its local-only apiKey to build the deploy connection);
 * `label` is the human name shown in the picker.
 */

import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useMemo } from 'react'

import { useDatabase } from '@/contexts'
import { getAllModels } from '@/dal'
import { isLoopbackHost } from '@/lib/mcp-url-validation'
import type { AgentFieldOption } from '@shared/agent-descriptors'
import type { Model } from '@/types'

/**
 * A model is deployable to a sandbox agent when the sandbox can dial it directly:
 *  - managed Thunderbolt system models (backend mints a scoped token),
 *  - BYOK providers with a reachable base URL (`openai`/`openrouter`/`anthropic`),
 *  - `custom` models whose URL is set and NOT loopback.
 * Excludes `tinfoil` (HPKE enclave, no plain base URL) and loopback `custom` URLs
 * (LM Studio / Ollama on the user's machine — unreachable from a cloud sandbox).
 */
const isDeployableModel = (model: Model): boolean => {
  if (model.provider === 'thunderbolt') {
    return model.isSystem === 1
  }
  if (model.provider === 'openai' || model.provider === 'openrouter' || model.provider === 'anthropic') {
    return true
  }
  if (model.provider === 'custom') {
    return Boolean(model.url) && URL.canParse(model.url!) && !isLoopbackHost(new URL(model.url!).hostname)
  }
  return false
}

export const useAccountModelOptions = (): { options: AgentFieldOption[]; isLoading: boolean } => {
  const db = useDatabase()
  // Same key + query as the settings models page, so they share one cached
  // PowerSync subscription rather than opening a redundant one on identical data.
  const { data: models = [], isLoading } = useQuery({
    queryKey: ['models'],
    query: toCompilableQuery(getAllModels(db)),
  })

  const options = useMemo<AgentFieldOption[]>(
    () => models.filter(isDeployableModel).map((model) => ({ value: model.id, label: model.name ?? '' })),
    [models],
  )

  return { options, isLoading }
}
