/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { safeErrorHandler } from '@/middleware/error-handling'
import { baseLanguage } from '@shared/i18n/base-language'
import { Elysia, t } from 'elysia'

export type LocationResult = {
  /**
   * Open-Meteo's (GeoNames') id — the only language-independent handle on a
   * place. `name`/`region`/`country` all localize, so this is what callers
   * persist and re-resolve against when they need the same place in another
   * language.
   */
  id: number
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

type GeocodingPlace = {
  id?: number
  name?: string
  admin1?: string
  country?: string
  country_code?: string
  latitude?: number
  longitude?: number
}

const geocodingBaseUrl = 'https://geocoding-api.open-meteo.com/v1'

/**
 * BCP-47 tag; normalized to its base subtag before it reaches Open-Meteo.
 * Optional, defaulting to English so an older client keeps its behaviour.
 *
 * Well-formedness is checked here rather than in the handler because
 * `baseLanguage` builds an `Intl.Locale`, which throws a `RangeError` on a
 * malformed tag — and an empty value (`?language=`) reaches the handler as `''`,
 * past the `?? 'en'` default. Validating at the boundary turns that into a 422
 * instead of an opaque 500. The pattern admits only tags `Intl.Locale` accepts;
 * it rejects `-u-`/`-t-` extension singletons, which carry nothing the base
 * subtag needs.
 */
const languageQuery = t.Optional(t.String({ pattern: '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }))

const toLocationResult = (place: GeocodingPlace): LocationResult => ({
  id: place.id ?? 0,
  name: place.name || '',
  region: place.admin1 || '',
  country: place.country || '',
  countryCode: place.country_code || '',
  lat: place.latitude || 0,
  lon: place.longitude || 0,
})

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
          // `language` narrows what Open-Meteo *matches*, not just what it
          // renders: `Munique` finds Munich under `pt` and only Muñique, Spain
          // under `en`. Searching in the caller's language is what lets someone
          // find a city by the name they know it as.
          const url = new URL(`${geocodingBaseUrl}/search`)
          url.searchParams.set('name', queryParam)
          url.searchParams.set('count', '10')
          url.searchParams.set('language', baseLanguage(query.language ?? 'en'))
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

          const data = (await response.json()) as { results?: GeocodingPlace[] }

          // Filter out country-level results (no admin1) - we only support cities
          return (data.results || []).filter((location) => location.admin1).map(toLocationResult)
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
          language: languageQuery,
        }),
      },
    )

    .get(
      '/locations/:id',
      async (ctx): Promise<LocationResult> => {
        const { params, query, set } = ctx

        try {
          const url = new URL(`${geocodingBaseUrl}/get`)
          url.searchParams.set('id', String(params.id))
          url.searchParams.set('language', baseLanguage(query.language ?? 'en'))

          const response = await fetchFn(url.toString())

          if (!response.ok) {
            if (response.status === 400 || response.status === 404) {
              set.status = 404
              throw new Error('Location not found')
            }
            set.status = 503
            throw new Error('Geocoding service unavailable')
          }

          return toLocationResult((await response.json()) as GeocodingPlace)
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
        params: t.Object({
          id: t.Number(),
        }),
        query: t.Object({
          language: languageQuery,
        }),
      },
    )
}
