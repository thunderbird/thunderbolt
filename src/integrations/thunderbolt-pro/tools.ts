import { getCloudUrl } from '@/lib/config'
import { WeatherForecastDataSchema, type WeatherForecastData } from '@/lib/weather-forecast'
import type { ToolConfig } from '@/types'
import ky from 'ky'
import { z } from 'zod'

/**
 * Schemas for the pro tools
 */
export const searchSchema = z
  .object({
    query: z.string().describe('The search query string'),
    max_results: z.number().describe('Maximum number of results to return'),
  })
  .strict()

export const fetchContentSchema = z
  .object({
    url: z.string().describe('Webpage URL to fetch content from'),
  })
  .strict()

export const searchLocationSchema = z
  .object({
    query: z.string().describe('The location name to search for'),
    region: z.string().describe("The location's state or region."),
    country: z.string().describe("The location's country."),
  })
  .strict()

export const weatherSchema = z
  .object({
    location: z
      .string()
      .describe('The location name to get weather for. Only include the city name, not the state or country.'),
    region: z.string().describe("The location's state or region."),
    country: z.string().describe("The location's country."),
    days: z.number().describe('Number of days to forecast (1-16)'),
  })
  .strict()

export type SearchParams = z.infer<typeof searchSchema>
export type FetchContentParams = z.infer<typeof fetchContentSchema>
export type WeatherParams = z.infer<typeof weatherSchema>
export type SearchLocationParams = z.infer<typeof searchLocationSchema>

type FetchContentData = {
  url: string
  title: string | null
  text: string
  favicon: string | null
  image: string | null
  author: string | null
  published_date: string | null
} | null

/**
 * Search the web and return formatted results
 */
export const search = async (params: SearchParams): Promise<string> => {
  try {
    const cloudUrl = await getCloudUrl()
    const response = await ky
      .post(`${cloudUrl}/pro/search`, {
        json: {
          query: params.query,
          max_results: params.max_results || 10,
        },
      })
      .json<{ data: string; success: boolean; error?: string }>()
    if (!response.success) {
      throw new Error(response.error || 'Search failed')
    }

    return response.data
  } catch (error) {
    console.error('Search error:', error)
    throw new Error(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

/**
 * Fetch and parse content from a webpage URL
 */
export const fetchContent = async (params: FetchContentParams): Promise<FetchContentData> => {
  try {
    const cloudUrl = await getCloudUrl()
    const response = await ky
      .post(`${cloudUrl}/pro/fetch-content`, {
        json: {
          url: params.url,
        },
      })
      .json<{ data: FetchContentData; success: boolean; error?: string }>()

    if (!response.success) {
      throw new Error(response.error || 'Fetch content failed')
    }
    return response.data
  } catch (error) {
    console.error('Fetch content error:', error)
    throw new Error(`Fetch content failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

/**
 * Get current weather for specified coordinates
 */
export const getCurrentWeather = async (params: WeatherParams): Promise<string> => {
  try {
    const cloudUrl = await getCloudUrl()
    const response = await ky
      .post(`${cloudUrl}/pro/weather/current`, {
        json: {
          location: params.location,
          region: params.region,
          country: params.country,
        },
      })
      .json<{ data: string; success: boolean; error?: string }>()

    if (!response.success) {
      throw new Error(response.error || 'Weather request failed')
    }

    return response.data
  } catch (error) {
    console.error('Weather error:', error)
    throw new Error(`Weather request failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

/**
 * Get weather forecast for specified coordinates
 */
export const getWeatherForecast = async (params: WeatherParams): Promise<WeatherForecastData> => {
  try {
    const cloudUrl = await getCloudUrl()
    const response = await ky
      .post(`${cloudUrl}/pro/weather/forecast`, {
        json: {
          location: params.location,
          region: params.region,
          country: params.country,
          days: params.days || 3,
        },
      })
      .json<{ data: unknown; success: boolean; error?: string }>()

    if (!response.success || !response.data) {
      throw new Error(response.error || 'Weather forecast request failed')
    }

    const validatedData = WeatherForecastDataSchema.parse(response.data)
    return validatedData
  } catch (error) {
    console.error('Weather forecast error:', error)
    throw new Error(`Weather forecast request failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

/**
 * Search for locations by name
 */
export const searchLocations = async (params: SearchLocationParams): Promise<string> => {
  try {
    const cloudUrl = await getCloudUrl()
    const response = await ky
      .post(`${cloudUrl}/pro/locations/search`, {
        json: {
          query: params.query,
          region: params.region,
          country: params.country,
        },
      })
      .json<{ data: string; success: boolean; error?: string }>()

    if (!response.success) {
      throw new Error(response.error || 'Location search failed')
    }

    return response.data
  } catch (error) {
    console.error('Location search error:', error)
    throw new Error(`Location search failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

/**
 * Tool configurations for Thunderbolt Pro
 */
export const configs: ToolConfig[] = [
  {
    name: 'search',
    description: 'Search the web and return relevant results.',
    verb: 'searching for {query}',
    parameters: searchSchema,
    execute: search,
  },
  {
    name: 'fetch_content',
    description: 'Fetch and parse content from a webpage URL.',
    verb: 'fetching {url}',
    parameters: fetchContentSchema,
    execute: fetchContent,
  },
  {
    name: 'get_current_weather',
    description: `Return the current weather (today only) as text.
- Use this tool when the user asks about the weather "now" or "today".
- Provide the structured parameters (location, region, country).
- - if you are not sure about the state/region and/or country ask the user to confirm this information.
- Provide a concise one-day summary (temperature, condition, highs/lows).
- Do not render a component.`,
    verb: 'Write current weather for {location}',
    parameters: weatherSchema,
    execute: getCurrentWeather,
  },
  {
    name: 'get_weather_forecast',
    description: `Return a 7-day forecast as plain text only (no component).

This tool is a **fallback** when, for some reason, rendering a component is not possible
(e.g. the user explicitly asks for a text forecast).

- Output a clear day-by-day breakdown (one line per day with condition + high/low).
- Provide the structured parameters (location, region, country).
- - if you are not sure about the state/region and/or country ask the user to confirm this information.
- Optionally add a brief overall summary and friendly suggestions after the breakdown.
- If the user did not explicitly request a text-only format, prefer 'display-weather_forecast' instead.`,
    verb: 'Write 7-day text forecast for {location}',
    parameters: weatherSchema,
    execute: async (params: WeatherParams) => {
      const forecastData = await getWeatherForecast(params)
      return forecastData
    },
  },
  {
    name: 'display-weather_forecast',
    description: `Render the custom 7-day weather forecast component in the UI.

Use this tool whenever the user asks for a forecast that spans more than one day.
- This is the **preferred tool** for multi-day forecasts (2–7 days).
- Provide the structured parameters (location, region, country, days, forecast details).
- - if you are not sure about the state/region and/or country ask the user to confirm this information.
- Do NOT include a day-by-day breakdown in text when this tool is used.
- You may still write a short overview (2–4 sentences) and friendly suggestions (bulleted).`,
    verb: 'Display 7-day forecast for {location}',
    parameters: weatherSchema,
    execute: async (params: WeatherParams) => {
      const forecastData = await getWeatherForecast(params)
      return forecastData
    },
  },
]
