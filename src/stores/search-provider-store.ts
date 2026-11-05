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
  disconnectSearchProvider: () => void
}

const storageKey = 'thunderbolt-search-provider'
const initialConfiguration = { selection: 'auto', provider: null, apiKey: '' } as const

/** Device-local search credentials, deliberately excluded from synced settings. */
export const useSearchProviderStore = create<SearchProviderState>()(
  persist(
    (set) => ({
      ...initialConfiguration,
      selectSearchProvider: (selection) => set({ selection }),
      configureSearchProvider: (apiKey, provider = 'brave') =>
        set({ provider, apiKey: apiKey.trim(), selection: 'custom' }),
      clearSearchProvider: () => set(initialConfiguration),
      disconnectSearchProvider: () =>
        set(({ selection }) => ({
          provider: null,
          apiKey: '',
          selection: selection === 'custom' || selection === 'auto' ? 'none' : selection,
        })),
    }),
    {
      name: storageKey,
      partialize: ({ provider, apiKey, selection }) => ({ provider, apiKey, selection }),
      // Removal in another window must discard the in-memory key too. Rehydration
      // otherwise merges missing storage over the current (still connected) state.
      merge: (persisted, current) => ({
        ...current,
        ...initialConfiguration,
        ...(persisted as Partial<SearchProviderState>),
      }),
    },
  ),
)

const onStorage = (event: StorageEvent) => {
  if (event.storageArea === localStorage && (event.key === storageKey || event.key === null)) {
    void useSearchProviderStore.persist.rehydrate()
  }
}

// The evaluation CLI imports provider selection too, but has no browser windows to synchronize.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', onStorage)
  import.meta.hot?.dispose(() => window.removeEventListener('storage', onStorage))
}
