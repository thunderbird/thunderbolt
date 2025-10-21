import { getSettings } from '@/dal'
import { getCloudUrl } from '@/lib/config'
import { WeatherForecastDataSchema, type WeatherForecastData } from '@/lib/weather-forecast'
import ky from 'ky'
import { z } from 'zod'

const requestTimeout = 10000

/**
 * Schemas for the pro API
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

export const linkPreviewSchema = z
  .object({
    url: z.string().describe('URL to fetch preview metadata from'),
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
export type LinkPreviewParams = z.infer<typeof linkPreviewSchema>
export type WeatherParams = z.infer<typeof weatherSchema>
export type SearchLocationParams = z.infer<typeof searchLocationSchema>

export type SearchResultData = {
  url: string
  title: string | null
  summary?: string
  highlights?: string[]
  highlightScores?: number[]
  favicon: string | null
  image: string | null
  author: string | null
  publishedDate: string | null
  score?: number
  id: string
}

export type FetchContentData = {
  url: string
  title: string | null
  text: string
  summary: string
  highlights?: string[]
  highlightScores?: number[]
  favicon: string | null
  image: string | null
  author: string | null
  published_date: string | null
} | null

export type LinkPreviewData = {
  title: string | null
  description: string | null
  image: string | null
}

/**
 * Search the web and return structured results with summaries and highlights
 */
export const search = async (params: SearchParams): Promise<SearchResultData[]> => {
  try {
    const cloudUrl = await getCloudUrl()
    const response = await ky
      .post(`${cloudUrl}/pro/search`, {
        timeout: requestTimeout,
        json: {
          query: params.query,
          max_results: params.max_results || 10,
        },
      })
      .json<{ data: SearchResultData[]; success: boolean; error?: string }>()
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
        timeout: requestTimeout,
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
 * Fetch link preview metadata (title, description, image) from a URL
 */
export const fetchLinkPreview = async (params: LinkPreviewParams): Promise<LinkPreviewData> => {
  try {
    const cloudUrl = await getCloudUrl()
    const response = await ky
      .get(`${cloudUrl}/pro/link-preview/${encodeURIComponent(params.url)}`, {
        timeout: requestTimeout,
      })
      .json<{ data: LinkPreviewData | null; success: boolean; error?: string }>()

    if (!response.success || !response.data) {
      throw new Error(response.error || 'Link preview failed')
    }
    return response.data
  } catch (error) {
    console.error('Link preview error:', error)
    throw new Error(`Link preview failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

/**
 * Get current weather for specified coordinates
 */
export const getCurrentWeather = async (params: WeatherParams): Promise<string> => {
  try {
    const cloudUrl = await getCloudUrl()
    const { temperatureUnit, distanceUnit } = await getSettings({
      temperature_unit: 'f',
      distance_unit: 'imperial',
    })

    const response = await ky
      .post(`${cloudUrl}/pro/weather/current`, {
        timeout: requestTimeout,
        json: {
          location: params.location,
          region: params.region,
          country: params.country,
          distanceUnit,
          temperatureUnit,
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
    const { temperatureUnit, distanceUnit } = await getSettings({
      temperature_unit: 'f',
      distance_unit: 'imperial',
    })

    const response = await ky
      .post(`${cloudUrl}/pro/weather/forecast`, {
        timeout: requestTimeout,
        json: {
          location: params.location,
          region: params.region,
          country: params.country,
          days: params.days || 3,
          distanceUnit,
          temperatureUnit,
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
    const { temperatureUnit, distanceUnit } = await getSettings({
      temperature_unit: 'f',
      distance_unit: 'imperial',
    })

    const response = await ky
      .post(`${cloudUrl}/pro/locations/search`, {
        timeout: requestTimeout,
        json: {
          query: params.query,
          region: params.region,
          country: params.country,
          distanceUnit,
          temperatureUnit,
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
