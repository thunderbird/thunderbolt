/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isSearchProvider, type SearchProvider } from '@/integrations/standalone-search/providers'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useQuery as usePowerSyncQuery } from '@powersync/tanstack-react-query'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useDatabase } from '@/contexts'
import { getAllModels } from '@/dal/models'
import { getIntegrationCredentials } from '@/dal/integrations'
import { useLocalProviders } from '@/hooks/use-local-providers'
import { useSettings } from '@/hooks/use-settings'
import { findTinfoilSearchModel } from '@/integrations/tinfoil-search/connection'
import { hasProAccess } from '@/integrations/thunderbolt-pro/utils'
import { resolveSearchSelection } from '@/integrations/standalone-search/selection'
import { useSearchProviderStore } from '@/stores/search-provider-store'

/** Keeps the visible selection aligned with runtime availability without copying provider credentials. */
export const useSearchSettingsState = () => {
  const db = useDatabase()
  const local = useLocalProviders()
  const stored = useSearchProviderStore()
  const [panel, setPanel] = useState<SearchProvider | 'tinfoil' | 'cloud' | null>(null)
  const { data: models = [], isLoading: modelsLoading } = usePowerSyncQuery({
    queryKey: ['models', 'search-providers'],
    query: toCompilableQuery(getAllModels(db)),
  })
  const { data: session, isLoading: sessionLoading } = useQuery({
    queryKey: ['tinfoil-session'],
    queryFn: () => getIntegrationCredentials(db, 'tinfoil'),
  })
  const { data: proAccess } = useQuery({ queryKey: ['pro-access'], queryFn: hasProAccess })
  const { integrationsProIsEnabled } = useSettings({ integrations_pro_is_enabled: false })
  const oauthAvailable = Boolean(
    session?.enabled && session.credentials.access_token && !session.credentials.reauth_required,
  )
  const tinfoilModel = local ? findTinfoilSearchModel(models, oauthAvailable) : undefined
  const available = {
    custom: Boolean(stored.provider && stored.apiKey),
    tinfoil: Boolean(tinfoilModel),
    cloud: !local && Boolean(proAccess && integrationsProIsEnabled.value),
  }
  const selected = resolveSearchSelection(stored.selection, available)
  return {
    stored,
    panel,
    setPanel,
    available,
    selected: selected === 'custom' ? stored.provider : selected,
    loading: modelsLoading || sessionLoading,
    toggle: (provider: SearchProvider | 'tinfoil' | 'cloud', enabled: boolean) => {
      const selection = isSearchProvider(provider) ? 'custom' : provider
      const ready = selection === 'custom' ? available.custom && stored.provider === provider : available[selection]
      if (enabled && !ready) {
        setPanel(provider)
        return
      }
      stored.selectSearchProvider(enabled ? selection : 'none')
    },
  }
}
