import { getCloudUrl } from '@/lib/config'
import { WeatherForecastDataSchema } from '@/lib/weather-forecast'
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
    url: z.string().describe('The webpage URL to fetch content from'),
  })
  .strict()

export const searchLocationSchema = z
  .object({
    query: z.string().describe('The location name to search for'),
  })
  .strict()

export const weatherSchema = z
  .object({
    location: z
      .string()
      .describe('The location name to get weather for. Only include the city name, not the state or country.'),
    days: z.number().describe('Number of days to forecast (1-16)'),
  })
  .strict()

export type SearchParams = z.infer<typeof searchSchema>
export type FetchContentParams = z.infer<typeof fetchContentSchema>
export type WeatherParams = z.infer<typeof weatherSchema>
export type SearchLocationParams = z.infer<typeof searchLocationSchema>

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
      .json<{ results: string; success: boolean; error?: string }>()
    if (!response.success) {
      throw new Error(response.error || 'Search failed')
    }

    return response.results
  } catch (error) {
    console.error('Search error:', error)
    throw new Error(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

/**
 * Fetch and parse content from a webpage URL
 */
export const fetchContent = async (params: FetchContentParams): Promise<string> => {
  try {
    const cloudUrl = await getCloudUrl()
    const response = await ky
      .post(`${cloudUrl}/pro/fetch-content`, {
        json: {
          url: params.url,
        },
      })
      .json<{ content: string; success: boolean; error?: string }>()

    if (!response.success) {
      throw new Error(response.error || 'Fetch content failed')
    }

    return response.content
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
        },
      })
      .json<{ weather_data: string; success: boolean; error?: string }>()

    if (!response.success) {
      throw new Error(response.error || 'Weather request failed')
    }

    return response.weather_data
  } catch (error) {
    console.error('Weather error:', error)
    throw new Error(`Weather request failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

/**
 * Get weather forecast for specified coordinates
 */
export const getWeatherForecast = async (params: WeatherParams): Promise<string> => {
  try {
    const cloudUrl = await getCloudUrl()
    const response = await ky
      .post(`${cloudUrl}/pro/weather/forecast`, {
        json: {
          location: params.location,
          days: params.days || 3,
        },
      })
      .json<{ weather_data: string; success: boolean; error?: string }>()

    if (!response.success) {
      throw new Error(response.error || 'Weather forecast request failed')
    }

    return response.weather_data
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
        },
      })
      .json<{ locations: string; success: boolean; error?: string }>()

    if (!response.success) {
      throw new Error(response.error || 'Location search failed')
    }

    return response.locations
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
    description: 'Get the current weather for a given location.',
    verb: 'getting weather for {location}',
    parameters: weatherSchema,
    execute: getCurrentWeather,
  },
  {
    name: 'get_weather_forecast',
    description: `
You are a weather assistant.

Steps:
1. Get the weather forecast for the given location.
2. IMPORTANT: Before stream any response or text to the user you SHOULD call the tool display_weather_forecast with its full schema. 
   - Fill every property with the correct data from the forecast response:
     • location → full description of the location (city + state + country if available).
     • days → array of forecasts (one object per day).
       - Each object must contain:
         - date
         - weather_code
         - temperature_max
         - temperature_min
3. ONLY after calling the tool, stream the forecast text **with the day-to-day breakdown removed**. Keep only the general summary, helper texts, and suggestions. THIS IS IMPORTANT, you SHOULD remove the day-to-day breakdown from the text.

Important rules:
- Always call the tool before streaming any text.
- The tool payload must be complete and accurate.
- IMPORTANT: the streamed text must exclude the day-to-day breakdown.`,
    verb: 'getting forecast for {location}',
    parameters: weatherSchema,
    execute: getWeatherForecast,
  },
  {
    name: 'display-weather_forecast',
    description: 'Use the parameters to display the weather forecast component.',
    verb: 'Display the weather forecast component',
    parameters: WeatherForecastDataSchema,
    execute: (params) => params,
  },
]
