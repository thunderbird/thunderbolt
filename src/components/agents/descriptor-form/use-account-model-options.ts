/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Resolves the `account-models` option source for descriptor `select` fields:
 * the user's servable managed system models, read reactively from the already-
 * synced local `models` table. `value` is the provider-side model id the backend
 * validates against; `label` is the human name shown in the picker.
 */

import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useMemo } from 'react'

import { useDatabase } from '@/contexts'
import { getAllModels } from '@/dal'
import type { AgentFieldOption } from '@shared/agent-descriptors'
import type { Model } from '@/types'

/**
 * A model is servable to a deployed agent's sandbox only when it's a managed
 * system model served by Thunderbolt's gateway. This deliberately excludes
 * confidential/tinfoil models (e.g. GLM), which are not reachable from a sandbox.
 * Kept as one predicate so the servable set is easy to narrow later.
 */
const isServableSystemModel = (model: Model): boolean => model.isSystem === 1 && model.provider === 'thunderbolt'

export const useAccountModelOptions = (): { options: AgentFieldOption[]; isLoading: boolean } => {
  const db = useDatabase()
  // Same key + query as the settings models page, so they share one cached
  // PowerSync subscription rather than opening a redundant one on identical data.
  const { data: models = [], isLoading } = useQuery({
    queryKey: ['models'],
    query: toCompilableQuery(getAllModels(db)),
  })

  const options = useMemo<AgentFieldOption[]>(
    () => models.filter(isServableSystemModel).map((model) => ({ value: model.model ?? '', label: model.name ?? '' })),
    [models],
  )

  return { options, isLoading }
}
