/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { SearchProvider } from '@/integrations/standalone-search/providers'

export type SearchSelection = 'auto' | 'custom' | 'tinfoil' | 'cloud' | 'none'

type SearchProviderState = {
  selection: SearchSelection
  selectSearchProvider: (selection: SearchSelection) => void
  provider: SearchProvider | null
  apiKey: string
  configureSearchProvider: (apiKey: string, provider?: SearchProvider) => void
  clearSearchProvider: () => void
}

/** Device-local search credentials, deliberately excluded from synced settings. */
export const useSearchProviderStore = create<SearchProviderState>()(
  persist(
    (set) => ({
      selection: 'auto',
      selectSearchProvider: (selection) => set({ selection }),
      provider: null,
      apiKey: '',
      configureSearchProvider: (apiKey, provider = 'brave') =>
        set({ provider, apiKey: apiKey.trim(), selection: 'custom' }),
      clearSearchProvider: () => set({ provider: null, apiKey: '', selection: 'auto' }),
    }),
    {
      name: 'thunderbolt-search-provider',
      partialize: ({ provider, apiKey, selection }) => ({ provider, apiKey, selection }),
    },
  ),
)
