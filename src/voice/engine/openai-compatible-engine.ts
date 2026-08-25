/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Configurable OpenAI-compatible VoiceEngine (THU-718) — the "standalone" story.
 *
 * Points at any server exposing OpenAI-shaped `/v1/audio/{transcriptions,speech}`:
 * another provider or a self-hosted local model (Kokoro-FastAPI, speaches,
 * LocalAI, vLLM, …). Unlike the Thunderbolt engine there's no HPKE proxy — just a
 * plain authenticated fetch (app `http` client + optional Bearer key). Because
 * the base URL is user-supplied and external, its own CORS must allow the app
 * origin (and it must be reachable — http localhost is mixed-content-blocked from
 * an https page).
 */
import { i18n } from '@/i18n'
import { msg } from '@lingui/core/macro'
import { HttpError, http } from '@/lib/http'
import type { VoiceProviderConfig } from '@/stores/local-settings-store'
import { type AudioTransport, createAudioEngine } from './audio-engine'
import type { VoiceEngine } from './types'

const stripTrailingSlash = (url: string): string => url.replace(/\/+$/, '')

const withAuth = (apiKey: string, headers?: Record<string, string>): Record<string, string> => {
  const merged: Record<string, string> = { ...headers }
  if (apiKey) {
    merged.Authorization = `Bearer ${apiKey}`
  }
  return merged
}

export const createOpenAiCompatibleEngine = (config: VoiceProviderConfig): VoiceEngine => {
  const baseUrl = stripTrailingSlash(config.baseUrl)
  const transport: AudioTransport = async (path, body, headers, signal) => {
    try {
      return await http.post(`${baseUrl}${path}`, {
        body,
        headers: withAuth(config.apiKey, headers),
        timeout: 30_000,
        signal,
      })
    } catch (err) {
      // The http client throws on non-2xx; hand the Response back so the engine
      // can surface the server's error body (bad voice/model, etc.).
      if (err instanceof HttpError) {
        return err.response
      }
      throw err
    }
  }
  return createAudioEngine({
    id: 'openai-compatible',
    transport,
    sttModel: config.sttModel,
    ttsModel: config.ttsModel,
    ttsVoice: config.ttsVoice,
    ttsSpeed: 1,
    // No `instructions`: it's a vLLM-Omni extension; stricter servers 400 on it.
  })
}

/**
 * Validate a config end-to-end by asking the server to synthesize a short line —
 * exercises the base URL, auth, TTS model and voice in one shot. Returns the
 * server's error body on failure (bad voice/model, unreachable, CORS, …).
 */
export const testOpenAiConnection = async (config: VoiceProviderConfig): Promise<{ ok: boolean; detail: string }> => {
  try {
    await http.post(`${stripTrailingSlash(config.baseUrl)}/audio/speech`, {
      json: {
        model: config.ttsModel,
        input: 'Connection test.',
        voice: config.ttsVoice,
        response_format: 'wav',
      },
      headers: withAuth(config.apiKey),
      timeout: 20_000,
    })
    return { ok: true, detail: i18n._(msg`Connected — synthesis succeeded.`) }
  } catch (err) {
    if (err instanceof HttpError) {
      return { ok: false, detail: `${err.response.status} ${await err.response.text().catch(() => '')}`.trim() }
    }
    return { ok: false, detail: String(err) }
  }
}

/** A model as returned by the OpenAI-standard `GET /v1/models`. speaches adds
 * `task` (to distinguish STT from TTS) and, on TTS models, an embedded `voices`
 * array — both are extensions, absent on plainer servers. */
type RawModel = {
  id: string
  task?: string
  voices?: Array<{ id: string }>
}

/** Discovered models split for the two settings dropdowns. Each TTS model
 * carries its own preset voices (empty when the server doesn't advertise any). */
export type DiscoveredModels = {
  stt: string[]
  tts: Array<{ id: string; voices: string[] }>
}

const taskStt = 'automatic-speech-recognition'
const taskTts = 'text-to-speech'

/**
 * Partition raw `/v1/models` entries into STT and TTS lists using each model's
 * `task` tag. A model with no `task` (generic OpenAI-compatible servers only
 * return `{id}`) can't be classified, so it's offered under both — the user
 * picks the right one. Pure and synchronous so it's unit-testable without HTTP.
 */
export const classifyModels = (models: RawModel[]): DiscoveredModels => {
  const stt: string[] = []
  const tts: DiscoveredModels['tts'] = []
  for (const model of models) {
    const voices = (model.voices ?? []).map((voice) => voice.id)
    if (model.task === taskTts) {
      tts.push({ id: model.id, voices })
    } else if (model.task === taskStt) {
      stt.push(model.id)
    } else {
      stt.push(model.id)
      tts.push({ id: model.id, voices })
    }
  }
  return { stt, tts }
}

/**
 * Discover the server's models for the settings dropdowns via the OpenAI-standard
 * `GET /v1/models`. Returns empty lists on any failure (unreachable, CORS, older
 * server) so the UI falls back to free-text model/voice fields.
 */
export const fetchOpenAiModels = async (baseUrl: string, apiKey: string): Promise<DiscoveredModels> => {
  try {
    const data = await http
      .get(`${stripTrailingSlash(baseUrl)}/models`, { headers: withAuth(apiKey), timeout: 10_000 })
      .json<{ data?: RawModel[] }>()
    return classifyModels(data.data ?? [])
  } catch {
    return { stt: [], tts: [] }
  }
}
