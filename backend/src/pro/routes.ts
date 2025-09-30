import { Elysia, t } from 'elysia'
import { SimpleContext } from './context'
import { createExaClient, fetchContentExa, searchExa } from './exa'
import { createProxyRoutes } from './proxy'
import type {
  FetchContentRequest,
  FetchContentResponse,
  LocationSearchRequest,
  LocationSearchResponse,
  SearchRequest,
  SearchResponse,
  WeatherCurrentResponse,
  WeatherForecastResponse,
  WeatherRequest,
} from './types'
import { OpenMeteoWeather } from './weather'

// Initialize the tool clients
const exaClient = createExaClient()
const weatherClient = new OpenMeteoWeather()

/**
 * Create pro tools routes
 */
export const createProToolsRoutes = () => {
  return new Elysia({ prefix: '/pro' })
    .use(createProxyRoutes())
    .post(
      '/search',
      async ({ body }): Promise<SearchResponse> => {
        const request = body as SearchRequest

        if (!exaClient) {
          return {
            data: null,
            success: false,
            error: 'Search service is not configured. Please set the EXA_API_KEY environment variable.',
          }
        }

        try {
          const ctx = new SimpleContext()
          const results = await searchExa(request.query, ctx, request.max_results)

          // Format results for LLM - Exa SDK already provides LLM-optimized format
          if (!results || results.length === 0) {
            return {
              data: 'No results found.',
              success: true,
            }
          }

          const formattedResults = []
          for (const r of results) {
            formattedResults.push(`${r.position}. ${r.title}`)
            formattedResults.push(`   URL: ${r.url}`)
            if (r.snippet) {
              formattedResults.push(`   ${r.snippet}`)
            }
          }

          return {
            data: formattedResults.join('\n'),
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
          max_results: t.Optional(t.Number({ default: 10 })),
        }),
      },
    )

    .post(
      '/fetch-content',
      async ({ body }): Promise<FetchContentResponse> => {
        const request = body as FetchContentRequest
        const ctx = new SimpleContext()

        // Require Exa to be configured
        if (!exaClient) {
          return {
            data: null,
            success: false,
            error: 'Content fetching service is not configured. Please set the EXA_API_KEY environment variable.',
          }
        }

        // Use Exa for privacy-protected fetching
        const content = await fetchContentExa(request.url, ctx)

        // Check if Exa returned an error message
        if (content.error) {
          return {
            data: null,
            success: false,
            error: content.error,
          }
        }

        return {
          data: content,
          success: true,
        }
      },
      {
        body: t.Object({
          url: t.String(),
        }),
      },
    )

    .post(
      '/weather/current',
      async ({ body }): Promise<WeatherCurrentResponse> => {
        const request = body as WeatherRequest

        try {
          const ctx = new SimpleContext()
          const weatherData = await weatherClient.getCurrentWeather(request.location, ctx)

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
          const weatherData = await weatherClient.getWeatherForecast(request.location, request.days, ctx)

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
          const locations = await weatherClient.searchLocations(request.query, ctx)

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
        }),
      },
    )
}
