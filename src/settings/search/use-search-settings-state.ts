/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useServerAuthentication } from '@/hooks/use-local-providers'
import { useSettings } from '@/hooks/use-settings'
import { hasProAccess } from '@/integrations/thunderbolt-pro/utils'
import { canSupplySearch } from '@/integrations/standalone-search/eligibility'
import { resolveSearchSelection } from '@/integrations/standalone-search/selection'
import { useSearchProviderAvailability } from '@/integrations/standalone-search/use-search-provider-availability'
import { useSearchProviderStore } from '@/stores/search-provider-store'

/** Selects reusable named connections without reading or copying their credentials into Settings. */
export const useSearchSettingsState = () => {
  const authenticated = useServerAuthentication()
  const stored = useSearchProviderStore()
  const [panel, setPanel] = useState<string | null>(null)
  const availability = useSearchProviderAvailability()
  const { data: proAccess } = useQuery({ queryKey: ['pro-access'], queryFn: hasProAccess })
  const { integrationsProIsEnabled } = useSettings({ integrations_pro_is_enabled: false })
  const cloudVisible = authenticated && Boolean(proAccess)
  const cloud = cloudVisible && integrationsProIsEnabled.value
  const selected = resolveSearchSelection(stored.selection, { connection: availability.connectionAvailable, cloud })
  return {
    ...availability,
    panel,
    setPanel,
    cloudVisible,
    cloud,
    selectedId: selected === 'connection' ? stored.connectionId : selected,
    toggle: (id: string, enabled: boolean) => {
      if (!enabled) {
        stored.selectSearchProvider('none')
        return
      }
      if (id === 'cloud' && cloud) {
        stored.selectSearchProvider('cloud')
        return
      }
      const connection = availability.connections.find((item) => item.id === id)
      if (connection && canSupplySearch(connection)) {
        stored.selectSearchConnection(id)
      } else {
        setPanel(id)
      }
    },
  }
}
