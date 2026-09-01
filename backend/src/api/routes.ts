/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia, t } from 'elysia'

export type LocationResult = {
  name: string
  region: string
  country: string
  /**
   * ISO 3166-1 alpha-2, or empty when the provider has none for this result.
   * Returned independently of the `language` parameter, so clients can key off
   * it instead of reverse-matching `country`, which is a display name and will
   * localize.
   */
  countryCode: string
  lat: number
  lon: number
}

/**
 * Create main API routes
 */
export const createMainRoutes = (auth: Auth, fetchFn: typeof fetch = globalThis.fetch) => {
  return new Elysia()
    .onError(safeErrorHandler)
    .use(createAuthMacro(auth))
    .get('/health', () => ({
      status: 'ok',
    }))

    .get(
      '/locations',
      async (ctx): Promise<LocationResult[]> => {
        const { query, set } = ctx
        const queryParam = query.query

        if (!queryParam) {
          set.status = 400
          throw new Error('Query parameter is required')
        }

        try {
          const url = new URL('https://geocoding-api.open-meteo.com/v1/search')
          url.searchParams.set('name', queryParam)
          url.searchParams.set('count', '10')
          url.searchParams.set('language', 'en')
          url.searchParams.set('format', 'json')

          const response = await fetchFn(url.toString())

          if (!response.ok) {
            if (response.status === 400) {
              set.status = 400
              throw new Error('Invalid search query')
            } else {
              set.status = 503
              throw new Error('Geocoding service unavailable')
            }
          }

          const data = (await response.json()) as {
            results?: Array<{
              name?: string
              admin1?: string
              country?: string
              country_code?: string
              latitude?: number
              longitude?: number
            }>
          }

          // Filter out country-level results (no admin1) - we only support cities
          return (data.results || [])
            .filter((location) => location.admin1)
            .map((location) => ({
              name: location.name || '',
              region: location.admin1!,
              country: location.country || '',
              countryCode: location.country_code || '',
              lat: location.latitude || 0,
              lon: location.longitude || 0,
            }))
        } catch (error) {
          if (error instanceof Error) {
            throw error // Re-throw with original message and status
          }
          set.status = 503
          throw new Error('Geocoding service unavailable', { cause: error })
        }
      },
      {
        auth: true,
        query: t.Object({
          query: t.String(),
        }),
      },
    )
}
