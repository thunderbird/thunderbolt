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

type ListingRequest = {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}

/** Z.AI API reference has no model-list operation: https://docs.z.ai/llms.txt */
const ZAI_FALLBACK_ONLY: ModelProvider = 'zai'

/** Fireworks listing needs an account ID: https://docs.fireworks.ai/api-reference/list-models */
const FIREWORKS_FALLBACK_ONLY: ModelProvider = 'fireworks'

const FALLBACK_ONLY_PROVIDERS: ReadonlySet<ModelProvider> = new Set([ZAI_FALLBACK_ONLY, FIREWORKS_FALLBACK_ONLY])

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
  if (!isRecord(value) || !Array.isArray(value.data)) return []
  return value.data.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== 'string') return []
    const created = createdTimestamp(candidate)
    return [
      {
        id: candidate.id,
        ...(created === undefined ? {} : { created }),
      },
    ]
  })
}

/** Gemini listing schema: https://ai.google.dev/api/models#method:-models.list */
const parseGeminiModels = (value: unknown): readonly ListedModel[] => {
  if (!isRecord(value) || !Array.isArray(value.models)) return []
  return value.models.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.name !== 'string') return []
    if (!Array.isArray(candidate.supportedGenerationMethods)) return []
    if (!candidate.supportedGenerationMethods.includes('generateContent')) return []
    return [{ id: candidate.name.replace(/^models\//, '') }]
  })
}

/** xAI language-model schema: https://docs.x.ai/developers/rest-api-reference/inference/models#list-language-models */
const parseXaiModels = (value: unknown): readonly ListedModel[] => {
  if (!isRecord(value) || !Array.isArray(value.models)) return []
  return value.models.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== 'string') return []
    const created = createdTimestamp(candidate)
    return [{ id: candidate.id, ...(created === undefined ? {} : { created }) }]
  })
}

/** Together listing schema: https://docs.together.ai/reference/models */
const parseTogetherModels = (value: unknown): readonly ListedModel[] => {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || typeof candidate.type !== 'string') return []
    if (!['chat', 'language', 'code'].includes(candidate.type)) return []
    const created = createdTimestamp(candidate)
    return [{ id: candidate.id, ...(created === undefined ? {} : { created }) }]
  })
}

/** Selects the documented response schema for the requested provider. */
const parseListedModels = (provider: ModelProvider, value: unknown): readonly ListedModel[] => {
  if (provider === 'google') return parseGeminiModels(value)
  if (provider === 'xai') return parseXaiModels(value)
  if (provider === 'together') return parseTogetherModels(value)
  return parseOpenAiModels(value)
}

/** Identifies fetch failures that should use catalog models. */
const isExpectedFetchError = (error: unknown): boolean => error instanceof DOMException || error instanceof TypeError

/** Keeps model ids intended for chat rather than specialized media or ranking APIs. */
const chatModels = (models: readonly ListedModel[]): readonly ListedModel[] =>
  models.filter(({ id }) => !NON_CHAT_MODEL_PATTERN.test(id))

/** Sorts newest-first when creation metadata exists, preserving order otherwise. */
const newestModelsFirst = (models: readonly ListedModel[]): readonly ListedModel[] => {
  if (!models.some(({ created }) => created !== undefined)) return models
  return [...models].sort(
    (left, right) => (right.created ?? Number.NEGATIVE_INFINITY) - (left.created ?? Number.NEGATIVE_INFINITY),
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

/** Mistral listing route: https://docs.mistral.ai/api/endpoint/models */
const mistralListingBaseUrl = (baseUrl: string): string => endpoint(baseUrl, 'v1')

/** MiniMax listing route: https://platform.minimax.io/docs/api-reference/models/openai/list-models */
const minimaxListingBaseUrl = (baseUrl: string): string => new URL('/v1', baseUrl).toString()

/** Adapts Pi inference bases to providers' OpenAI-compatible model-listing bases. */
const compatibleBaseUrl = (provider: ModelProvider, baseUrl?: string): string => {
  const resolvedBaseUrl = providerBaseUrl(provider, baseUrl)
  if (provider === 'mistral') return mistralListingBaseUrl(resolvedBaseUrl)
  if (provider === 'minimax') return minimaxListingBaseUrl(resolvedBaseUrl)
  return resolvedBaseUrl
}

/** Anthropic listing request: https://platform.claude.com/docs/en/api/models/list */
const anthropicListingRequest = (apiKey: string): ListingRequest => ({
  url: endpoint(providerBaseUrl('anthropic'), 'v1/models'),
  headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
})

/** Gemini listing request: https://ai.google.dev/api/models#method:-models.list */
const googleListingRequest = (apiKey: string): ListingRequest => {
  const url = new URL(endpoint(providerBaseUrl('google'), 'models'))
  url.searchParams.set('key', apiKey)
  return { url: url.toString(), headers: {} }
}

/** xAI chat-model route: https://docs.x.ai/developers/rest-api-reference/inference/models#list-language-models */
const xaiListingRequest = (apiKey: string): ListingRequest => ({
  url: endpoint(providerBaseUrl('xai'), 'language-models'),
  headers: { Authorization: `Bearer ${apiKey}` },
})

/** Builds provider-specific listing URL and authentication headers. */
const listingRequest = (provider: ModelProvider, apiKey: string, baseUrl?: string): ListingRequest => {
  if (provider === 'anthropic') return anthropicListingRequest(apiKey)
  if (provider === 'google') return googleListingRequest(apiKey)
  if (provider === 'xai') return xaiListingRequest(apiKey)
  return {
    url: endpoint(compatibleBaseUrl(provider, baseUrl), 'models'),
    headers: { Authorization: `Bearer ${apiKey}` },
  }
}

/** Lists live provider models, returning Pi catalog ids for expected provider failures. */
export const listModels = async (options: ListModelsOptions): Promise<ModelListingResult> => {
  const fallback = (): ModelListingResult => ({ source: 'catalog', ids: catalogIds(options.provider) })
  if (FALLBACK_ONLY_PROVIDERS.has(options.provider)) return fallback()
  const request = listingRequest(options.provider, options.apiKey, options.baseUrl)
  const controller = new AbortController()
  const timeout = Promise.withResolvers<never>()
  const timeoutId = setTimeout(() => {
    controller.abort()
    timeout.reject(new DOMException('Model listing timed out.', 'TimeoutError'))
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  const response = await (async (): Promise<Response | undefined> => {
    try {
      return await Promise.race([
        (options.fetchFn ?? globalThis.fetch)(request.url, {
          headers: request.headers,
          signal: controller.signal,
        }),
        timeout.promise,
      ])
    } catch (error) {
      if (isExpectedFetchError(error)) return undefined
      throw error
    } finally {
      clearTimeout(timeoutId)
    }
  })()
  if (!response) return fallback()
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return { ...fallback(), authRejected: true, status: response.status }
    }
    return fallback()
  }

  const parsed = await (async (): Promise<unknown> => {
    try {
      return (await response.json()) as unknown
    } catch (error) {
      if (error instanceof SyntaxError) return undefined
      throw error
    }
  })()
  if (parsed === undefined) return fallback()

  const listedModels = parseListedModels(options.provider, parsed)
  const models = newestModelsFirst(chatModels(listedModels))
  if (models.length === 0) return fallback()
  return { source: 'live', ids: models.slice(0, MAX_LIVE_MODELS).map(({ id }) => id) }
}
