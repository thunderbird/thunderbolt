/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Voice engine selection (THU-718). `thunderbolt` uses the hosted enclave STT/TTS
 * (via the /tinfoil proxy); `openai-compatible` points at any OpenAI-shaped
 * `/v1/audio/*` endpoint — another provider or a self-hosted local server.
 * Device-local (not synced): holds a key and a machine-specific URL.
 */
export type VoiceProviderConfig = {
  kind: 'thunderbolt' | 'openai-compatible'
  /** Base URL including the version prefix, e.g. http://localhost:8000/v1. */
  baseUrl: string
  apiKey: string
  sttModel: string
  ttsModel: string
  ttsVoice: string
}

export const defaultVoiceProvider: VoiceProviderConfig = {
  kind: 'thunderbolt',
  baseUrl: '',
  apiKey: '',
  sttModel: 'whisper-large-v3-turbo',
  ttsModel: 'qwen3-tts',
  ttsVoice: 'aiden',
}

type LocalSettingsState = {
  cloudUrl: string
  debugPosthog: boolean
  isNativeFetchEnabled: boolean
  hapticsEnabled: boolean
  syncEnabled: boolean
  theme: 'light' | 'dark' | 'system'
  voiceProvider: VoiceProviderConfig
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
  voiceProvider: defaultVoiceProvider,
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
        cloudUrl: s.cloudUrl,
        debugPosthog: s.debugPosthog,
        isNativeFetchEnabled: s.isNativeFetchEnabled,
        hapticsEnabled: s.hapticsEnabled,
        syncEnabled: s.syncEnabled,
        theme: s.theme,
        voiceProvider: s.voiceProvider,
      }),
    },
  ),
)

/**
 * Type-safe synchronous read for non-React consumers.
 * Return type narrows per key (e.g. `getLocalSetting('cloudUrl')` → `string`).
 */
export const getLocalSetting = <K extends keyof LocalSettingsState>(key: K): LocalSettingsState[K] =>
  useLocalSettingsStore.getState()[key]
