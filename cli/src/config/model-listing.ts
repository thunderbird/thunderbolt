/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Live provider model discovery with Pi catalog fallback. */

import { builtinModels, builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { ModelProvider } from '../agent/types.ts'
import { isRecord } from '../lib/json.ts'

const defaultTimeoutMs = 3_000
const maxLiveModels = 8
const nonChatModelPattern =
  /embed(?:ding)?|whisper|tts|speech|transcri|dall-?e|gpt-image|imagen|(?:^|[-_/])sora(?:[-_/]|$)|moderation|rerank/i

export type ModelListingResult = {
  readonly source: 'live' | 'catalog'
  readonly ids: readonly string[]
  readonly wasAuthRejected?: true
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

/** Providers served only from the Pi catalog because no usable live list route
 *  exists: Z.AI's API reference has no model-list operation
 *  (https://docs.z.ai/llms.txt), and Fireworks listing needs an account ID
 *  (https://docs.fireworks.ai/api-reference/list-models). */
const fallbackOnlyProviders: ReadonlySet<ModelProvider> = new Set(['zai', 'fireworks'])

/** Reads numeric OpenAI or ISO Anthropic creation metadata. */
const createdTimestamp = (candidate: Readonly<Record<string, unknown>>): number | undefined => {
  if (typeof candidate.created === 'number') return candidate.created
  if (typeof candidate.created_at !== 'string') return undefined
  const timestamp = Date.parse(candidate.created_at)
  return Number.isNaN(timestamp) ? undefined : timestamp
}

/** Reads OpenAI-compatible `{ data: [{ id, created? }] }` responses. */
const parseOpenAiModels = (value: unknown): readonly ListedModel[] => {
  if (!isRecord(value) || !Array.isArray(value.data)) return []
  return value.data.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== 'string') return []
    return [{ id: candidate.id, created: createdTimestamp(candidate) }]
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
    return [{ id: candidate.id, created: createdTimestamp(candidate) }]
  })
}

/** Together listing schema: https://docs.together.ai/reference/models */
const parseTogetherModels = (value: unknown): readonly ListedModel[] => {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || typeof candidate.type !== 'string') return []
    if (!['chat', 'language', 'code'].includes(candidate.type)) return []
    return [{ id: candidate.id, created: createdTimestamp(candidate) }]
  })
}

/** Selects the documented response schema for the requested provider. */
const parseListedModels = (provider: ModelProvider, value: unknown): readonly ListedModel[] => {
  if (provider === 'google') return parseGeminiModels(value)
  if (provider === 'xai') return parseXaiModels(value)
  if (provider === 'together') return parseTogetherModels(value)
  return parseOpenAiModels(value)
}

/** Identifies fetch failures that should use catalog models. Per the fetch
 *  spec, a network failure rejects with `TypeError` and an abort/timeout with
 *  a `DOMException` — this is only ever applied around the fetch call and the
 *  body read (never our own parsing), so a programming `TypeError` elsewhere
 *  still surfaces loudly. */
const isExpectedFetchError = (error: unknown): boolean => error instanceof DOMException || error instanceof TypeError

/** Keeps model ids intended for chat rather than specialized media or ranking APIs. */
const chatModels = (models: readonly ListedModel[]): readonly ListedModel[] =>
  models.filter(({ id }) => !nonChatModelPattern.test(id))

/** Sorts newest-first when creation metadata exists, preserving order otherwise. */
const newestModelsFirst = (models: readonly ListedModel[]): readonly ListedModel[] => {
  if (!models.some(({ created }) => created !== undefined)) return models
  const rank = ({ created }: ListedModel): number => created ?? Number.NEGATIVE_INFINITY
  // Explicit equal branch: two missing timestamps must compare 0, not NaN.
  return [...models].sort((left, right) => (rank(left) === rank(right) ? 0 : rank(right) - rank(left)))
}

/** Returns current Pi catalog ids using setup wizard's existing three-item
 *  limit. Reading the static Pi catalog for a built-in provider is trusted —
 *  a failure here is a real catalog regression and should surface loudly. */
const catalogIds = (provider: ModelProvider): readonly string[] => {
  if (provider === 'openai-compat') return []
  return builtinModels()
    .getModels(provider)
    .slice(0, 3)
    .map(({ id }) => id)
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

/** Mistral listing route: https://docs.mistral.ai/api/endpoint/models
 *  Pi's inference base is the bare host (`https://api.mistral.ai`), so the
 *  `/v1` listing prefix is appended. */
const mistralListingBaseUrl = (baseUrl: string): string => endpoint(baseUrl, 'v1')

/** MiniMax listing route: https://platform.minimax.io/docs/api-reference/models/openai/list-models
 *  Pi's inference base carries the Anthropic-compat path
 *  (`https://api.minimaxi.com/anthropic`), which `new URL('/v1', …)`
 *  deliberately *replaces* — unlike mistral's append above. */
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

/** Gemini listing request: https://ai.google.dev/api/models#method:-models.list
 *  The key rides in the `x-goog-api-key` header, never the query string, so it
 *  cannot land in proxy or access logs. */
const googleListingRequest = (apiKey: string): ListingRequest => ({
  url: endpoint(providerBaseUrl('google'), 'models'),
  headers: { 'x-goog-api-key': apiKey },
})

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

/** One abort signal and deadline shared by the listing fetch and its body read. */
type RequestTimeout = {
  readonly signal: AbortSignal
  readonly expired: Promise<never>
  readonly clear: () => void
}

/** Starts the request deadline: past `timeoutMs` the signal aborts and `expired`
 *  rejects, covering fetches (or injected fetches) that ignore the signal. */
const createRequestTimeout = (timeoutMs: number): RequestTimeout => {
  const controller = new AbortController()
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => {
    controller.abort()
    timeout.reject(new DOMException('Model listing timed out.', 'TimeoutError'))
  }, timeoutMs)
  return { signal: controller.signal, expired: timeout.promise, clear: () => clearTimeout(timer) }
}

/** Runs the listing fetch under the shared deadline, mapping expected network
 *  failures (abort, timeout, connection errors) to `undefined`. */
const fetchWithTimeout = async (
  fetchFn: ModelListingFetch,
  request: ListingRequest,
  timeout: RequestTimeout,
): Promise<Response | undefined> => {
  try {
    return await Promise.race([
      fetchFn(request.url, { headers: request.headers, signal: timeout.signal }),
      timeout.expired,
    ])
  } catch (error) {
    if (isExpectedFetchError(error)) return undefined
    throw error
  }
}

/** Reads the JSON body under the same deadline as the fetch, mapping malformed
 *  JSON and a stalled/aborted body read to `undefined`. */
const parseJsonBody = async (response: Response, timeout: RequestTimeout): Promise<unknown> => {
  try {
    return await Promise.race([response.json() as Promise<unknown>, timeout.expired])
  } catch (error) {
    if (error instanceof SyntaxError || isExpectedFetchError(error)) return undefined
    throw error
  }
}

/** Lists live provider models, returning Pi catalog ids for expected provider failures. */
export const listModels = async (options: ListModelsOptions): Promise<ModelListingResult> => {
  const fallback = (): ModelListingResult => ({ source: 'catalog', ids: catalogIds(options.provider) })
  if (fallbackOnlyProviders.has(options.provider)) return fallback()

  const request = listingRequest(options.provider, options.apiKey, options.baseUrl)
  const timeout = createRequestTimeout(options.timeoutMs ?? defaultTimeoutMs)
  try {
    const response = await fetchWithTimeout(options.fetchFn ?? globalThis.fetch, request, timeout)
    if (!response) return fallback()
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { ...fallback(), wasAuthRejected: true, status: response.status }
      }
      return fallback()
    }

    const parsed = await parseJsonBody(response, timeout)
    if (parsed === undefined) return fallback()

    const listedModels = parseListedModels(options.provider, parsed)
    const models = newestModelsFirst(chatModels(listedModels))
    if (models.length === 0) return fallback()
    return { source: 'live', ids: models.slice(0, maxLiveModels).map(({ id }) => id) }
  } finally {
    // Cleared only after the body settles, so the deadline covers fetch + read.
    timeout.clear()
  }
}
