import { Elysia, t } from 'elysia'
import unitsByCountryData from '../data/localization/units-by-country.json'
import unitsOptionsData from '../data/localization/units-options.json'
import { resolveCountryCode } from '../utils/country'

export interface LocationResult {
  name: string
  region: string
  country: string
  lat: number
  lon: number
}

/**
 * Create main API routes
 */
export const createMainRoutes = (fetchFn: typeof fetch = globalThis.fetch) => {
  return new Elysia()
    .get('/health', () => ({
      status: 'ok',
    }))

    .get(
      '/units',
      (ctx) => {
        const { query, set } = ctx
        const country = query.country

        if (!country) {
          set.status = 400
          throw new Error('Country parameter is required')
        }

        const countryCode = resolveCountryCode(country)

        if (!countryCode) {
          return unitsByCountryData.US
        }

        const countryData = unitsByCountryData[countryCode as keyof typeof unitsByCountryData]

        if (!countryData) {
          return unitsByCountryData.US
        }

        return countryData
      },
      {
        query: t.Object({
          country: t.String(),
        }),
      },
    )

    .get('/units-options', () => {
      return unitsOptionsData
    })

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
              lat: location.latitude || 0,
              lon: location.longitude || 0,
            }))
        } catch (error) {
          if (error instanceof Error) {
            throw error // Re-throw with original message and status
          }
          set.status = 503
          throw new Error('Geocoding service unavailable')
        }
      },
      {
        query: t.Object({
          query: t.String(),
        }),
      },
    )
}
