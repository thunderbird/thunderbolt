import { Elysia, t } from 'elysia'
import { SimpleContext } from './context'
import { exaPlugin } from './exa'
import { createProxyRoutes } from './proxy'
import type {
  LocationSearchRequest,
  LocationSearchResponse,
  WeatherCurrentResponse,
  WeatherForecastResponse,
  WeatherRequest,
} from './types'
import { OpenMeteoWeather } from './weather'

// Initialize the tool clients
const weatherClient = new OpenMeteoWeather()

/**
 * Create pro tools routes
 */
export const createProToolsRoutes = () => {
  return new Elysia({ prefix: '/pro' })
    .onError(({ code, error, set }) => {
      set.status = code === 'VALIDATION' ? 400 : 500
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : String(error),
      }
    })
    .use(exaPlugin)
    .use(createProxyRoutes())

    .post(
      '/weather/current',
      async ({ body }): Promise<WeatherCurrentResponse> => {
        try {
          const ctx = new SimpleContext()
          const weatherData = await weatherClient.getCurrentWeather(body.location, body.region, body.country, ctx)

          return {
            data: weatherData,
            success: true,
          }
        } catch (error) {
          return {
            data: null,
            success: false,
            error: String(error),
          }
        }
      },
      {
        body: t.Object({
          location: t.String(),
          region: t.String(),
          country: t.String(),
          days: t.Optional(t.Number({ default: 3 })),
        }),
      },
    )

    .post(
      '/weather/forecast',
      async ({ body }): Promise<WeatherForecastResponse> => {
        const request = body as WeatherRequest

        try {
          const ctx = new SimpleContext()
          const weatherData = await weatherClient.getWeatherForecast(
            request.location,
            request.region,
            request.country,
            request.days,
            ctx,
          )

          return {
            data: weatherData,
            success: true,
          }
        } catch (error) {
          return {
            data: null,
            success: false,
            error: String(error),
          }
        }
      },
      {
        body: t.Object({
          location: t.String(),
          region: t.String(),
          country: t.String(),
          days: t.Optional(t.Number({ default: 3 })),
        }),
      },
    )

    .post(
      '/locations/search',
      async ({ body }): Promise<LocationSearchResponse> => {
        const request = body as LocationSearchRequest

        try {
          const ctx = new SimpleContext()
          const locations = await weatherClient.searchLocations(request.query, request.region, request.country, ctx)

          if (!locations || locations.length === 0) {
            return {
              data: `No locations found matching: ${request.query}`,
              success: true,
            }
          }

          // Format the results as a string (same as MCP tool)
          const result = []
          result.push(`Found ${locations.length} locations matching '${request.query}':`)
          result.push('')

          for (let i = 0; i < locations.length; i++) {
            const location = locations[i]
            // Build location string
            const locationParts = [location.name]
            if (location.admin1) {
              locationParts.push(location.admin1)
            }
            if (location.country) {
              locationParts.push(location.country)
            }

            const locationStr = locationParts.join(', ')

            result.push(`${i + 1}. ${locationStr}`)
            result.push(`   Coordinates: ${location.latitude}, ${location.longitude}`)
            if (location.elevation !== undefined && location.elevation !== null) {
              result.push(`   Elevation: ${location.elevation}m`)
            }
            result.push('')
          }

          return {
            data: result.join('\n').trim(),
            success: true,
          }
        } catch (error) {
          return {
            data: null,
            success: false,
            error: String(error),
          }
        }
      },
      {
        body: t.Object({
          query: t.String(),
          region: t.String(),
          country: t.String(),
        }),
      },
    )
}
