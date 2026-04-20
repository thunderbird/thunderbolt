import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type AppConfig = {
  // Will grow with e2eeEnabled, feature flags, etc.
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
