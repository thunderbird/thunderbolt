import { Elysia, t } from 'elysia'

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
export const createMainRoutes = () => {
  return new Elysia()
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

          const response = await fetch(url.toString())

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

          // Transform to match the frontend's expected format
          const results: LocationResult[] = []
          for (const location of data.results || []) {
            results.push({
              name: location.name || '',
              region: location.admin1 || '', // State/Province
              country: location.country || '',
              lat: location.latitude || 0,
              lon: location.longitude || 0, // Frontend expects 'lon' not 'lng'
            })
          }

          return results
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

