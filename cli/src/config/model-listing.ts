/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Live provider model discovery with Pi catalog fallback. */

import { builtinModels, builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { ModelProvider } from '../agent/types.ts'

const DEFAULT_TIMEOUT_MS = 3_000
const MAX_LIVE_MODELS = 8
const NON_CHAT_MODEL_PATTERN =
  /embed(?:ding)?|whisper|tts|speech|transcri|dall-?e|gpt-image|imagen|(?:^|[-_/])sora(?:[-_/]|$)|moderation|rerank/i

export type ModelListingResult = {
  readonly source: 'live' | 'catalog'
  readonly ids: readonly string[]
  readonly authRejected?: true
  readonly status?: 401 | 403
}

export type ModelListingFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type ListModelsOptions = {
  readonly provider: ModelProvider
  readonly apiKey: string
  readonly baseUrl?: string
  readonly fetchFn?: ModelListingFetch
  readonly timeoutMs?: number
}

type ListedModel = {
  readonly id: string
  readonly created?: number
}

/** Reads numeric OpenAI or ISO Anthropic creation metadata. */
const createdTimestamp = (candidate: Readonly<Record<string, unknown>>): number | undefined => {
  if (typeof candidate.created === 'number') return candidate.created
  if (typeof candidate.created_at !== 'string') return undefined
  const timestamp = Date.parse(candidate.created_at)
  return Number.isNaN(timestamp) ? undefined : timestamp
}

/** Narrows parsed JSON objects without weakening unknown input types. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Reads OpenAI-compatible `{ data: [{ id, created? }] }` responses. */
const parseOpenAiModels = (value: unknown): readonly ListedModel[] => {
  if (!isRecord(value) || !Array.isArray(value.data)) throw new Error('Invalid model list response.')
  return value.data.map((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== 'string') throw new Error('Invalid model entry.')
    const created = createdTimestamp(candidate)
    return {
      id: candidate.id,
      ...(created === undefined ? {} : { created }),
    }
  })
}

/** Reads Gemini model entries capable of `generateContent`. */
const parseGeminiModels = (value: unknown): readonly ListedModel[] => {
  if (!isRecord(value) || !Array.isArray(value.models)) throw new Error('Invalid Gemini model list response.')
  return value.models.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.name !== 'string') throw new Error('Invalid Gemini model entry.')
    if (!Array.isArray(candidate.supportedGenerationMethods)) throw new Error('Invalid Gemini methods.')
    if (!candidate.supportedGenerationMethods.includes('generateContent')) return []
    return [{ id: candidate.name.replace(/^models\//, '') }]
  })
}

/** Keeps model ids intended for chat rather than specialized media or ranking APIs. */
const chatModels = (models: readonly ListedModel[]): readonly ListedModel[] =>
  models.filter(({ id }) => !NON_CHAT_MODEL_PATTERN.test(id))

/** Sorts newest-first when creation metadata exists, preserving order otherwise. */
const newestModelsFirst = (models: readonly ListedModel[]): readonly ListedModel[] => {
  if (!models.some(({ created }) => created !== undefined)) return models
  return [...models].sort(
    (left, right) =>
      (right.created ?? Number.NEGATIVE_INFINITY) - (left.created ?? Number.NEGATIVE_INFINITY),
  )
}

/** Returns current Pi catalog ids using setup wizard's existing three-item limit. */
const catalogIds = (provider: ModelProvider): readonly string[] => {
  if (provider === 'openai-compat') return []
  try {
    return builtinModels()
      .getModels(provider)
      .slice(0, 3)
      .map(({ id }) => id)
  } catch {
    return []
  }
}

/** Resolves provider base URL from Pi descriptors, except caller-owned custom targets. */
const providerBaseUrl = (provider: ModelProvider, customBaseUrl?: string): string => {
  if (provider === 'openai-compat') {
    if (!customBaseUrl) throw new Error('Missing OpenAI-compatible base URL.')
    return customBaseUrl
  }
  const descriptor = builtinProviders().find(({ id }) => id === provider)
  if (!descriptor?.baseUrl) throw new Error(`Missing Pi base URL for ${provider}.`)
  return descriptor.baseUrl
}

/** Joins one endpoint path without duplicating a trailing slash. */
const endpoint = (baseUrl: string, path: string): string => `${baseUrl.replace(/\/$/, '')}/${path}`

/** Adapts Pi inference bases to providers' OpenAI-compatible model-listing bases. */
const compatibleBaseUrl = (provider: ModelProvider, baseUrl?: string): string => {
  const resolvedBaseUrl = providerBaseUrl(provider, baseUrl)
  if (provider === 'mistral') return endpoint(resolvedBaseUrl, 'v1')
  if (provider === 'minimax') return new URL('/v1', resolvedBaseUrl).toString()
  if (provider !== 'fireworks') return resolvedBaseUrl

  const openAiModel = builtinModels()
    .getModels(provider)
    .find(({ api }) => api === 'openai-completions')
  return openAiModel?.baseUrl ?? resolvedBaseUrl
}

/** Builds provider-specific listing URL and authentication headers. */
const listingRequest = (
  provider: ModelProvider,
  apiKey: string,
  baseUrl?: string,
): { readonly url: string; readonly headers: Readonly<Record<string, string>> } => {
  if (provider === 'anthropic') {
    return {
      url: endpoint(providerBaseUrl(provider), 'v1/models'),
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    }
  }
  if (provider === 'google') {
    const url = new URL(endpoint(providerBaseUrl(provider), 'models'))
    url.searchParams.set('key', apiKey)
    return { url: url.toString(), headers: {} }
  }
  return {
    url: endpoint(compatibleBaseUrl(provider, baseUrl), 'models'),
    headers: { Authorization: `Bearer ${apiKey}` },
  }
}

/** Lists live provider models, returning Pi catalog ids for every failure mode. */
export const listModels = async (options: ListModelsOptions): Promise<ModelListingResult> => {
  const fallback = (): ModelListingResult => ({ source: 'catalog', ids: catalogIds(options.provider) })
  const controller = new AbortController()
  const timeout = Promise.withResolvers<never>()
  const timeoutId = setTimeout(() => {
    controller.abort()
    timeout.reject(new DOMException('Model listing timed out.', 'TimeoutError'))
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  try {
    const request = listingRequest(options.provider, options.apiKey, options.baseUrl)
    const response = await Promise.race([
      (options.fetchFn ?? globalThis.fetch)(request.url, {
        headers: request.headers,
        signal: controller.signal,
      }),
      timeout.promise,
    ])
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { ...fallback(), authRejected: true, status: response.status }
      }
      return fallback()
    }
    const parsed = (await response.json()) as unknown
    const models = newestModelsFirst(
      chatModels(options.provider === 'google' ? parseGeminiModels(parsed) : parseOpenAiModels(parsed)),
    )
    if (models.length === 0) return fallback()
    return { source: 'live', ids: models.slice(0, MAX_LIVE_MODELS).map(({ id }) => id) }
  } catch {
    return fallback()
  } finally {
    clearTimeout(timeoutId)
  }
}
