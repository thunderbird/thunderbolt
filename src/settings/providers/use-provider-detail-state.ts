/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useQuery } from '@powersync/tanstack-react-query'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useDatabase } from '@/contexts'
import { getAllModels, updateProvider, type Provider } from '@/dal'
import { useActiveWorkspaceId } from '@/lib/active-workspace'
import { useActiveUserId } from '@/stores/trust-domain-registry'
import { useSettings } from '@/hooks/use-settings'
import { useProviderModelCatalog } from '@/hooks/use-provider-catalog'
import { toggleCatalogModel } from '@/lib/providers/model-catalog'
import { getProviderDefinition, type ProviderCapability, type ProviderType } from '@shared/providers'
import type { CatalogModel } from '@/lib/providers/validate'
import { filterCatalogModels } from './provider-helpers'

/** The settings key for the single active search provider (spec.md §7). */
export const searchProviderSettingKey = 'search_provider_id' as const

/**
 * State + actions for the provider detail page: the live model catalog, which
 * models are currently curated ("Show in chat"), capability toggles, and the
 * active-search-provider setting. Keeps computation out of the view per the
 * CLAUDE.md testable-hook convention.
 */
export const useProviderDetailState = (provider: Provider) => {
  const db = useDatabase()
  const workspaceId = useActiveWorkspaceId()
  const userId = useActiveUserId()
  const [search, setSearch] = useState('')

  const def = getProviderDefinition(provider.type as ProviderType)
  const enabledCapabilities = provider.enabledCapabilities ?? def.capabilities

  const catalog = useProviderModelCatalog(def.capabilities.includes('models') ? provider : null)

  const { data: models = [] } = useQuery({
    queryKey: ['models', workspaceId],
    query: toCompilableQuery(getAllModels(db, workspaceId ?? '')),
    enabled: !!workspaceId,
  })

  const enabledModelIds = useMemo(
    () => new Set(models.filter((model) => model.providerId === provider.id).map((model) => model.model)),
    [models, provider.id],
  )

  const filteredModels = useMemo(() => filterCatalogModels(catalog.data ?? [], search), [catalog.data, search])

  const searchSetting = useSettings({ search_provider_id: String })
  const activeSearchProviderId = searchSetting.searchProviderId.value
  const isActiveSearchProvider = activeSearchProviderId === provider.id

  const toggleModelMutation = useMutation({
    mutationFn: async ({ catalogModel, on }: { catalogModel: CatalogModel; on: boolean }) => {
      if (!workspaceId || !userId) {
        throw new Error('No active workspace or user')
      }
      await toggleCatalogModel(
        db,
        workspaceId,
        {
          providerId: provider.id,
          providerType: provider.type as ProviderType,
          catalogModel,
          userId,
          scope: provider.scope ?? 'workspace',
        },
        on,
      )
    },
  })

  const toggleCapabilityMutation = useMutation({
    mutationFn: async (capability: ProviderCapability) => {
      if (!workspaceId) {
        throw new Error('No active workspace')
      }
      const next = enabledCapabilities.includes(capability)
        ? enabledCapabilities.filter((item) => item !== capability)
        : [...enabledCapabilities, capability]
      await updateProvider(db, workspaceId, provider.id, { enabledCapabilities: next })
    },
  })

  const setActiveSearchMutation = useMutation({
    mutationFn: () => searchSetting.searchProviderId.setValue(provider.id),
  })

  return {
    def,
    search,
    setSearch,
    catalog,
    filteredModels,
    enabledModelIds,
    enabledCapabilities,
    isActiveSearchProvider,
    toggleModel: (catalogModel: CatalogModel, on: boolean) => toggleModelMutation.mutate({ catalogModel, on }),
    toggleCapability: (capability: ProviderCapability) => toggleCapabilityMutation.mutate(capability),
    setActiveSearchProvider: () => setActiveSearchMutation.mutate(),
  }
}
