/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isSearchProvider, type SearchProvider } from '@/integrations/standalone-search/providers'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useServerAuthentication } from '@/hooks/use-local-providers'
import { useSettings } from '@/hooks/use-settings'
import { hasProAccess } from '@/integrations/thunderbolt-pro/utils'
import { resolveSearchSelection } from '@/integrations/standalone-search/selection'
import { useSearchProviderAvailability } from '@/integrations/standalone-search/use-search-provider-availability'
import { useSearchProviderStore } from '@/stores/search-provider-store'

/** Keeps the visible selection aligned with runtime availability without copying provider credentials. */
export const useSearchSettingsState = () => {
  const authenticated = useServerAuthentication()
  const stored = useSearchProviderStore()
  const [panel, setPanel] = useState<SearchProvider | 'tinfoil' | 'otari' | 'cloud' | null>(null)
  const { custom, tinfoil, tinfoilConfigured, otari, otariConfigured, loading } = useSearchProviderAvailability()
  const { data: proAccess } = useQuery({ queryKey: ['pro-access'], queryFn: hasProAccess })
  const { integrationsProIsEnabled } = useSettings({ integrations_pro_is_enabled: false })
  const cloudVisible = authenticated && Boolean(proAccess)
  const available = {
    custom,
    tinfoil,
    tinfoilConfigured,
    otari,
    otariConfigured,
    cloud: cloudVisible && integrationsProIsEnabled.value,
  }
  const selected = resolveSearchSelection(stored.selection, available)
  return {
    stored,
    panel,
    setPanel,
    available,
    cloudVisible,
    selected: selected === 'custom' ? stored.provider : selected,
    loading,
    toggle: (provider: SearchProvider | 'tinfoil' | 'otari' | 'cloud', enabled: boolean) => {
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
