/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { OtariSearchStatus } from '@/integrations/otari-search/capabilities'

export type SearchSelection = 'auto' | 'connection' | 'cloud' | 'none'
export type SearchConnectionStatus = { connectionId: string; status: OtariSearchStatus }

type SearchProviderState = {
  selection: SearchSelection
  connectionId: string | null
  connectionStatus: SearchConnectionStatus | null
  selectSearchProvider: (selection: Exclude<SearchSelection, 'connection'>) => void
  selectSearchConnection: (connectionId: string) => void
  configureProviderSearch: (connectionId: string, status: OtariSearchStatus, options?: { select?: boolean }) => void
  clearSearchProvider: () => void
}

export const searchSelectionStorageKey = 'thunderbolt-search-selection'
export const legacySearchStorageKey = 'thunderbolt-search-provider'
const initialConfiguration = { selection: 'auto', connectionId: null, connectionStatus: null } as const

/** Device-local routing intent only. Credentials belong to the provider connection's local secret table. */
export const useSearchProviderStore = create<SearchProviderState>()(
  persist(
    (set) => ({
      ...initialConfiguration,
      selectSearchProvider: (selection) => set({ selection, connectionId: null }),
      selectSearchConnection: (connectionId) => set({ selection: 'connection', connectionId }),
      configureProviderSearch: (connectionId, status, { select = true } = {}) =>
        set({
          connectionStatus: { connectionId, status },
          ...(select && status === 'available' ? { selection: 'connection', connectionId } : {}),
        }),
      clearSearchProvider: () => {
        localStorage.removeItem(legacySearchStorageKey)
        set(initialConfiguration)
      },
    }),
    {
      name: searchSelectionStorageKey,
      partialize: ({ selection, connectionId, connectionStatus }) => ({ selection, connectionId, connectionStatus }),
      merge: (persisted, current) => ({
        ...current,
        ...initialConfiguration,
        ...(persisted as Partial<SearchProviderState>),
      }),
    },
  ),
)

const onStorage = (event: StorageEvent) => {
  if (event.storageArea === localStorage && (event.key === searchSelectionStorageKey || event.key === null)) {
    void useSearchProviderStore.persist.rehydrate()
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', onStorage)
  import.meta.hot?.dispose(() => window.removeEventListener('storage', onStorage))
}
