/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Thunderbolt (Tinfoil) VoiceEngine (THU-717) — the default provider.
 *
 * STT + TTS run in Tinfoil's confidential enclave via the OpenAI-compatible
 * `/v1/audio/*` endpoints, reached through the *existing* attested `/tinfoil`
 * HPKE proxy (`SecureClient`) — so no new backend route is needed and the audio
 * is processed enclave-private. Only the *transport* is Tinfoil-specific; the
 * request/response orchestration is shared via `createAudioEngine`.
 */
import { evictSystemTinfoilClient, getSystemTinfoilClient, isTinfoilTransportWedgedError } from '@/ai/tinfoil-client'
import { appVersionHeader } from '@/lib/app-version'
import { handleAppVersionUnsupported } from '@/lib/app-version-unsupported'
import { isSsoMode } from '@/lib/auth-mode'
import { getAuthToken } from '@/lib/auth-token'
import type { SecureClient } from 'tinfoil'
import { type AudioTransport, createAudioEngine } from './audio-engine'
import type { VoiceEngine } from './types'

const sttModel = 'whisper-large-v3-turbo' // batch transcription; voxtral-realtime (streaming) is a follow-up

type TtsProfile = { model: string; voice: string }
// TTS model + its preset voice. voxtral-tts + casual_male is the verified-working
// combo; qwen3-tts is steadier/less improvisational. qwen3 voices on this enclave
// (from /audio/speech error bodies): aiden, dylan, eric, ono_anna, ryan, serena,
// sohee, uncle_fu, vivian. Flip ttsProfile to A/B; user-selectable engines land in
// the voice settings (THU-718) via createOpenAiCompatibleEngine.
const ttsProfiles = {
  voxtral: { model: 'voxtral-tts', voice: 'casual_male' },
  // `ryan` chosen after an A/B listen across the qwen3 voices above (THU-683).
  qwen3: { model: 'qwen3-tts', voice: 'ryan' },
} satisfies Record<string, TtsProfile>
const ttsProfile: TtsProfile = ttsProfiles.qwen3
// Expressive models improvise emphasis/pacing/laughter; steer delivery via the
// `instructions` style control (honored by qwen3-tts / voxtral-tts).
const ttsInstructions =
  'Speak naturally and conversationally, like a warm, helpful friend. Relaxed and ' +
  'clear, with an even, moderate pace. Sound genuinely engaged but never theatrical ' +
  '— no shouting, exaggerated emphasis, or laughter.'

/** The slice of the attested `SecureClient` the transport drives — injectable for tests. */
type TinfoilTransportDeps = {
  getClient: () => Promise<Pick<SecureClient, 'getBaseURL' | 'fetch'>>
  evictClient: () => void
  isSsoMode: () => boolean
  getAuthToken: () => string | null
}

/**
 * POST to a Tinfoil `/v1/audio/*` endpoint via the attested `SecureClient`,
 * attaching the app's session auth (the `/tinfoil` route's guard needs the real
 * token/SSO cookies, not the SDK placeholder). On a wedged transport failure
 * that survives the SDK's own reset/retry, evict the cached client and retry
 * once with a fresh attestation context (mirrors the chat path).
 *
 * The `/tinfoil` route sits behind the backend's app-version gate, so this hop
 * sends `X-App-Version` and raises the 426 (latching the upgrade blocker)
 * instead of surfacing it as a generic STT/TTS failure. A bare status check is
 * safe because the target is always our backend — same contract as the chat
 * path in `src/acp/built-in-adapter.ts`.
 */
export const createTinfoilTransport =
  (deps: TinfoilTransportDeps): AudioTransport =>
  async (path, body, headers, signal) => {
    const sso = deps.isSsoMode()
    const token = deps.getAuthToken()
    const attempt = async (): Promise<Response> => {
      const client = await deps.getClient() // awaits attestation (`ready()`)
      const baseUrl = client.getBaseURL()
      if (!baseUrl) {
        throw new Error('Tinfoil client has no base URL')
      }
      const reqHeaders = new Headers(headers)
      for (const [key, value] of Object.entries(appVersionHeader())) {
        reqHeaders.set(key, value)
      }
      const init: RequestInit = { method: 'POST', body, headers: reqHeaders, signal }
      if (sso && !token) {
        init.credentials = 'include'
        reqHeaders.delete('authorization')
      } else if (token) {
        reqHeaders.set('Authorization', `Bearer ${token}`)
      }
      return client.fetch(`${baseUrl}${path}`, init)
    }
    // Retry once on a wedged transport or a 422 key-mismatch response.
    const run = async (): Promise<Response> => {
      try {
        const res = await attempt()
        if (res.status === 422) {
          deps.evictClient()
          return await attempt()
        }
        return res
      } catch (err) {
        if (!isTinfoilTransportWedgedError(err)) {
          throw err
        }
        deps.evictClient()
        return attempt()
      }
    }
    const res = await run()
    handleAppVersionUnsupported(res.status)
    return res
  }

const tinfoilTransport = createTinfoilTransport({
  getClient: getSystemTinfoilClient,
  evictClient: evictSystemTinfoilClient,
  isSsoMode,
  getAuthToken,
})

export const createThunderboltEngine = (): VoiceEngine =>
  createAudioEngine({
    id: 'thunderbolt',
    transport: tinfoilTransport,
    warm: async () => {
      await getSystemTinfoilClient() // prime attestation
    },
    sttModel,
    ttsModel: ttsProfile.model,
    ttsVoice: ttsProfile.voice,
    ttsInstructions,
    ttsSpeed: 1,
  })
