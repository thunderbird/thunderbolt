import { getFlowerApiKey } from '@/auth/flower'
import { getSettings } from '@/config/settings'
import { buildUserIdHash } from '@/utils/request'
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
      async ({ query, set }): Promise<LocationResult[]> => {
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

    .post('/flower/api-key', async ({ headers }): Promise<{ api_key: string }> => {
      const settings = getSettings()

      if (!settings.flowerMgmtKey || !settings.flowerProjId) {
        throw new Error('Flower AI not configured')
      }

      // Derive a stable, non-PII user identifier for per-user API keys
      const ctx = { headers } as any // Simplified context for buildUserIdHash
      const userIdHash = buildUserIdHash(ctx, 'unknown')

      try {
        const apiKey = await getFlowerApiKey(userIdHash, undefined, settings)
        return { api_key: apiKey }
      } catch (error) {
        throw new Error(`Failed to get Flower API key: ${String(error)}`)
      }
    })

    .get('/analytics/config', async () => {
      const settings = getSettings()
      return {
        posthog_api_key: settings.posthogApiKey,
      }
    })
}
