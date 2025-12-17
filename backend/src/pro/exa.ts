import { getSettings } from '@/config/settings'
import { memoize } from '@/lib/memoize'
import { Elysia, t } from 'elysia'
import { Exa } from 'exa-js'
import type { FetchContentResponse, SearchResponse } from './types'

const getExaClient = memoize(() => {
  const settings = getSettings()
  const apiKey = settings.exaApiKey

  if (!apiKey) {
    return null
  }

  return new Exa(apiKey)
})

/**
 * Elysia plugin that provides Exa client in state
 */
export const exaPlugin = new Elysia({ name: 'exa' })
  .state('exaClient', getExaClient())
  .post(
    '/search',
    async ({ body, store }): Promise<SearchResponse> => {
      if (!store.exaClient) {
        throw new Error('Search service is not configured.')
      }

      const response = await store.exaClient.search(body.query, {
        numResults: body.max_results,
        useAutoprompt: true,
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

      const maxCharacters = 16000

      const response = await store.exaClient.getContents([body.url], {
        livecrawlTimeout: 5000,
        extras: { imageLinks: 1 },
        text: { maxCharacters },
        summary: { query: 'Main content and key information' },
      })

      const result = response.results[0]
      if (!result) {
        return { data: null, success: true }
      }

      return {
        data: {
          ...result,
          // Flag when content was truncated so the model knows full content wasn't returned
          wasTruncated: (result.text?.length ?? 0) >= maxCharacters,
        },
        success: true,
      }
    },
    {
      body: t.Object({
        url: t.String(),
      }),
    },
  )
