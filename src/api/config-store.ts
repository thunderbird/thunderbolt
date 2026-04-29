/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type AppConfig = {
  e2eeEnabled?: boolean
}

type ConfigStore = {
  config: AppConfig
  updateConfig: (config: AppConfig) => void
}

const initialState = { config: {} as AppConfig }

export const useConfigStore = create<ConfigStore>()(
  persist(
    (set) => ({
      ...initialState,
      updateConfig: (config) => set({ config }),
    }),
    { name: 'thunderbolt-config' },
  ),
)
