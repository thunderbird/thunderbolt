import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia, type AnyElysia, t } from 'elysia'
import { exaPlugin } from './exa'
import { createLinkPreviewRoutes } from './link-preview'
import { createProxyRoutes } from './proxy'
import type {
  LocationSearchRequest,
  LocationSearchResponse,
  WeatherCurrentResponse,
  WeatherForecastResponse,
  WeatherRequest,
} from './types'
import { OpenMeteoWeather } from './weather'

/**
 * Weather-specific user preferences for Open-Meteo API localization
 * Only includes the properties that are actually used by the weather client.
 * This is a subset of the full PreferencesSettings type from the frontend.
 */
type WeatherPreferences = {
  distanceUnit?: 'metric' | 'imperial'
  temperatureUnit?: 'c' | 'f'
}

/**
 * Create pro tools routes
 */
export const createProToolsRoutes = (auth: Auth, fetchFn: typeof fetch = globalThis.fetch, rateLimit?: AnyElysia) => {
  // Initialize the tool clients with injected fetch
  const weatherClient = new OpenMeteoWeather(fetchFn)

  const app = new Elysia({ prefix: '/pro' }).onError(safeErrorHandler).use(createAuthMacro(auth))

  if (rateLimit) app.use(rateLimit)

  return app.guard({ auth: true }, (guardedApp) =>
    guardedApp
      .use(exaPlugin)
      .use(createProxyRoutes(fetchFn))
      .use(createLinkPreviewRoutes(fetchFn))

      .post(
        '/weather/current',
        async ({ body }): Promise<WeatherCurrentResponse> => {
          try {
            const userPreferences: WeatherPreferences = {
              distanceUnit: body.distanceUnit || 'imperial',
              temperatureUnit: body.temperatureUnit || 'f',
            }
            const weatherData = await weatherClient.getCurrentWeather(
              body.location,
              body.region,
              body.country,
              userPreferences,
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
            distanceUnit: t.Optional(t.Union([t.Literal('metric'), t.Literal('imperial')])),
            temperatureUnit: t.Optional(t.Union([t.Literal('c'), t.Literal('f')])),
          }),
        },
      )

      .post(
        '/weather/forecast',
        async ({ body }): Promise<WeatherForecastResponse> => {
          const request = body as WeatherRequest

          try {
            const userPreferences: WeatherPreferences = {
              distanceUnit: body.distanceUnit || 'imperial',
              temperatureUnit: body.temperatureUnit || 'f',
            }
            const weatherData = await weatherClient.getWeatherForecast(
              request.location,
              request.region,
              request.country,
              request.days,
              userPreferences,
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
            distanceUnit: t.Optional(t.Union([t.Literal('metric'), t.Literal('imperial')])),
            temperatureUnit: t.Optional(t.Union([t.Literal('c'), t.Literal('f')])),
          }),
        },
      )

      .post(
        '/locations/search',
        async ({ body }): Promise<LocationSearchResponse> => {
          const request = body as LocationSearchRequest

          try {
            const locations = await weatherClient.searchLocations(request.query, request.region, request.country)

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
            distanceUnit: t.Optional(t.Union([t.Literal('metric'), t.Literal('imperial')])),
            temperatureUnit: t.Optional(t.Union([t.Literal('c'), t.Literal('f')])),
          }),
        },
      ),
  )
}
