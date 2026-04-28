import { getSettings } from '@/config/settings'
import { memoize } from '@/lib/memoize'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia, t } from 'elysia'
import { Exa, type ContentsOptions } from 'exa-js'
import type { FetchContentResponse, SearchResponse } from './types'

/**
 * exa-js v1.10.2 does not yet type `maxAgeHours`, but the `/contents` API accepts it
 * as the successor to the deprecated `livecrawl` enum. The SDK spreads unknown options
 * into the request body, so this field reaches the API unchanged.
 */
type ContentsOptionsWithMaxAge = ContentsOptions & { maxAgeHours?: number }

/**
 * Default freshness window for fetched content. Pages cached within the last 24 hours
 * are served as-is; older pages trigger a live crawl bounded by `livecrawlTimeout`.
 */
const DEFAULT_MAX_AGE_HOURS = 24

/**
 * Builds an Exa client with the `x-exa-integration` header set so the Exa team can
 * attribute API usage to the thunderbolt repo. `headers` is private in the SDK but
 * is a runtime `Headers` instance, so the cast is safe.
 */
export const createExaClient = (apiKey: string): Exa => {
  const client = new Exa(apiKey)
  ;(client as unknown as { headers: Headers }).headers.set('x-exa-integration', 'thunderbolt')
  return client
}

const getExaClient = memoize(() => {
  const settings = getSettings()
  const apiKey = settings.exaApiKey

  if (!apiKey) {
    return null
  }

  return createExaClient(apiKey)
})

/**
 * Elysia plugin that provides Exa client in state
 */
export const exaPlugin = new Elysia({ name: 'exa' })
  .onError(safeErrorHandler)
  .state('exaClient', getExaClient())
  .post(
    '/search',
    async ({ body, store }): Promise<SearchResponse> => {
      if (!store.exaClient) {
        throw new Error('Search service is not configured.')
      }

      const response = await store.exaClient.search(body.query, {
        numResults: body.max_results,
        type: 'fast',
      })

      return {
        data: response.results,
        success: true,
      }
    },
    {
      body: t.Object({
        query: t.String(),
        max_results: t.Optional(t.Number({ default: 10 })),
      }),
    },
  )

  .post(
    '/fetch-content',
    async ({ body, store }): Promise<FetchContentResponse> => {
      if (!store.exaClient) {
        throw new Error('Fetch content service is not configured.')
      }

      const defaultMaxChars = 16_000
      const hardCap = 64_000
      const minChars = 1_000
      const requestedMax = body.max_length ?? defaultMaxChars
      const maxCharacters = Math.min(Math.max(requestedMax, minChars), hardCap)

      const contentsOptions: ContentsOptionsWithMaxAge = {
        livecrawlTimeout: 5_000,
        maxAgeHours: DEFAULT_MAX_AGE_HOURS,
        extras: { imageLinks: 1 },
        text: { maxCharacters },
      }
      const response = await store.exaClient.getContents([body.url], contentsOptions)

      const result = response.results[0]
      if (!result) {
        return { data: null, success: true }
      }

      // Use >= as a conservative check: if Exa returns exactly maxCharacters,
      // the original content was likely longer and got truncated by Exa's API
      const isTruncated = (result.text?.length ?? 0) >= maxCharacters

      // If truncated and not at hard cap, suggest fetching more
      const truncationHint =
        isTruncated && maxCharacters < hardCap
          ? `\n\n[Content truncated. Call fetch_content with max_length=${Math.min(maxCharacters * 2, hardCap)} for more.]`
          : ''

      return {
        data: {
          ...result,
          text: (result.text ?? '') + truncationHint,
          isTruncated,
        },
        success: true,
      }
    },
    {
      body: t.Object({
        url: t.String(),
        max_length: t.Optional(t.Number()),
      }),
    },
  )
