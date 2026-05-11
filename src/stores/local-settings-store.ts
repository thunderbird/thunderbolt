/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type LocalSettingsState = {
  cloudUrl: string
  debugPosthog: boolean
  isNativeFetchEnabled: boolean
  hapticsEnabled: boolean
  syncEnabled: boolean
  theme: 'light' | 'dark' | 'system'
  lastActiveWorkspaceId: string | null
}

type LocalSettingsActions = {
  setLocalSetting: <K extends keyof LocalSettingsState>(key: K, value: LocalSettingsState[K]) => void
}

type LocalSettingsStore = LocalSettingsState & LocalSettingsActions

export const initialLocalSettings: LocalSettingsState = {
  cloudUrl: import.meta.env.VITE_THUNDERBOLT_CLOUD_URL || 'http://localhost:8000/v1',
  debugPosthog: false,
  isNativeFetchEnabled: false,
  hapticsEnabled: true,
  syncEnabled: false,
  theme: 'system',
  lastActiveWorkspaceId: null,
}

export const useLocalSettingsStore = create<LocalSettingsStore>()(
  persist(
    (set) => ({
      ...initialLocalSettings,
      setLocalSetting: (key, value) => set({ [key]: value }),
    }),
    {
      name: 'thunderbolt-local-settings',
      partialize: ({ setLocalSetting: _, ...settings }) => settings,
    },
  ),
)

/**
 * Type-safe synchronous read for non-React consumers.
 * Return type narrows per key (e.g. `getLocalSetting('cloudUrl')` → `string`).
 */
export const getLocalSetting = <K extends keyof LocalSettingsState>(key: K): LocalSettingsState[K] =>
  useLocalSettingsStore.getState()[key]
