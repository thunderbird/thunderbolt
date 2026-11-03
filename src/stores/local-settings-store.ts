/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ExternalLinkBehavior } from '@/lib/external-link-behavior'
import { isTauri } from '@/lib/platform'

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
  /** Keep local routes available after optionally connecting a server. Never grants server access. */
  localMode: boolean
  /** A successful session permanently binds this installation's data to its server. */
  serverHasAuthenticated: boolean
  externalLinkBehavior: ExternalLinkBehavior
  debugPosthog: boolean
  isNativeFetchEnabled: boolean
  hapticsEnabled: boolean
  syncEnabled: boolean
  /** A recovery phrase was minted but the user has not confirmed saving it.
   *  Survives reload/crash so the app can re-prompt — the phrase itself is
   *  unrecoverable (AK = PBKDF2(seed, salt)), so the prompt offers a rotation. */
  recoveryPhrasePending: boolean
  theme: 'light' | 'dark' | 'system'
  voiceProvider: VoiceProviderConfig
}

type LocalSettingsActions = {
  setLocalSetting: <K extends keyof LocalSettingsState>(key: K, value: LocalSettingsState[K]) => void
}

type LocalSettingsStore = LocalSettingsState & LocalSettingsActions

const initialCloudUrl =
  isTauri() && import.meta.env.VITE_AUTH_MODE !== 'sso' ? '' : import.meta.env.VITE_THUNDERBOLT_CLOUD_URL || ''

export const initialLocalSettings: LocalSettingsState = {
  // A downloaded app starts locally; managed SSO builds keep their deployment.
  // Persisted settings still win, so an upgrade preserves an existing server.
  cloudUrl: initialCloudUrl,
  localMode: !initialCloudUrl,
  serverHasAuthenticated: !!initialCloudUrl,
  externalLinkBehavior: 'ask',
  debugPosthog: false,
  isNativeFetchEnabled: false,
  hapticsEnabled: true,
  syncEnabled: false,
  recoveryPhrasePending: false,
  theme: 'system',
  voiceProvider: defaultVoiceProvider,
}

/** Legacy server installations stay account-bound; new local installs can correct an unused server. */
export const mergeLocalSettings = (persistedState: unknown, currentState: LocalSettingsStore): LocalSettingsStore => {
  const persisted = (persistedState ?? {}) as Partial<LocalSettingsState>
  const cloudUrl = persisted.cloudUrl ?? currentState.cloudUrl
  return {
    ...currentState,
    ...persisted,
    localMode: persisted.localMode ?? !cloudUrl,
    serverHasAuthenticated: persisted.serverHasAuthenticated ?? !!cloudUrl,
  }
}

export const useLocalSettingsStore = create<LocalSettingsStore>()(
  persist(
    (set) => ({
      ...initialLocalSettings,
      setLocalSetting: (key, value) => set({ [key]: value }),
    }),
    {
      name: 'thunderbolt-local-settings',
      merge: mergeLocalSettings,
      // Listed explicitly (rather than spread + omit) so TS errors if a new
      // LocalSettingsState field is added without persisting it, and so no
      // future store action can silently leak into localStorage.
      partialize: (s): LocalSettingsState => ({
        cloudUrl: s.cloudUrl,
        localMode: s.localMode,
        serverHasAuthenticated: s.serverHasAuthenticated,
        externalLinkBehavior: s.externalLinkBehavior,
        debugPosthog: s.debugPosthog,
        isNativeFetchEnabled: s.isNativeFetchEnabled,
        hapticsEnabled: s.hapticsEnabled,
        syncEnabled: s.syncEnabled,
        recoveryPhrasePending: s.recoveryPhrasePending,
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

/** Keep a selected server bound after the first credential, including after that credential expires. */
export const markServerAuthenticated = (): void => {
  const settings = useLocalSettingsStore.getState()
  if (settings.cloudUrl && !settings.serverHasAuthenticated) {
    useLocalSettingsStore.setState({ serverHasAuthenticated: true })
  }
}
