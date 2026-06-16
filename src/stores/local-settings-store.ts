/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Note: `cloudUrl` lives on the active server entry in the trust-domain registry
// (THU-549, commit 6) — runtime consumers read via `getActiveCloudUrl` /
// `useActiveCloudUrl`. `VITE_THUNDERBOLT_CLOUD_URL` is only the bootstrap default.
type LocalSettingsState = {
  debugPosthog: boolean
  isNativeFetchEnabled: boolean
  hapticsEnabled: boolean
  syncEnabled: boolean
  theme: 'light' | 'dark' | 'system'
}

type LocalSettingsActions = {
  setLocalSetting: <K extends keyof LocalSettingsState>(key: K, value: LocalSettingsState[K]) => void
}

type LocalSettingsStore = LocalSettingsState & LocalSettingsActions

export const initialLocalSettings: LocalSettingsState = {
  debugPosthog: false,
  isNativeFetchEnabled: false,
  hapticsEnabled: true,
  syncEnabled: false,
  theme: 'system',
}

export const useLocalSettingsStore = create<LocalSettingsStore>()(
  persist(
    (set) => ({
      ...initialLocalSettings,
      setLocalSetting: (key, value) => set({ [key]: value }),
    }),
    {
      name: 'thunderbolt-local-settings',
      // Listed explicitly (rather than spread + omit) so TS errors if a new
      // LocalSettingsState field is added without persisting it, and so no
      // future store action can silently leak into localStorage.
      partialize: (s): LocalSettingsState => ({
        debugPosthog: s.debugPosthog,
        isNativeFetchEnabled: s.isNativeFetchEnabled,
        hapticsEnabled: s.hapticsEnabled,
        syncEnabled: s.syncEnabled,
        theme: s.theme,
      }),
    },
  ),
)

/**
 * Type-safe synchronous read for non-React consumers.
 * Return type narrows per key (e.g. `getLocalSetting('debugPosthog')` → `boolean`).
 */
export const getLocalSetting = <K extends keyof LocalSettingsState>(key: K): LocalSettingsState[K] =>
  useLocalSettingsStore.getState()[key]
