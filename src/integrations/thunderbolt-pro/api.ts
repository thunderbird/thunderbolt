/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getSettings } from '@/dal'
import { getDb } from '@/db/database'
import type { HttpClient } from '@/lib/http'
import { WeatherForecastDataSchema, type WeatherForecastData } from '@/widgets/weather-forecast'
import type {
  FetchContentData,
  FetchContentParams,
  LinkPreviewData,
  LinkPreviewParams,
  SearchLocationParams,
  SearchParams,
  SearchResultData,
  WeatherParams,
} from './schemas'

const requestTimeout = 10000

/**
 * Search the web and return structured results with summaries and highlights
 */
export const search = async (params: SearchParams, httpClient: HttpClient): Promise<SearchResultData[]> => {
  try {
    const response = await httpClient
      .post('pro/search', {
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
export const fetchContent = async (params: FetchContentParams, httpClient: HttpClient): Promise<FetchContentData> => {
  try {
    const response = await httpClient
      .post('pro/fetch-content', {
        timeout: requestTimeout,
        json: {
          url: params.url,
          ...(params.max_length !== undefined && { max_length: params.max_length }),
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
export const fetchLinkPreview = async (params: LinkPreviewParams, httpClient: HttpClient): Promise<LinkPreviewData> => {
  try {
    const response = await httpClient
      .get(`pro/link-preview/${encodeURIComponent(params.url)}`, {
        timeout: requestTimeout,
      })
      .json<{ data: LinkPreviewData | null; success: boolean; error?: string }>()

    if (!response.success || !response.data) {
      throw new Error(response.error || 'Link preview failed')
    }
    return response.data
  } catch (error) {
    console.error('Link preview error:', error)
    throw new Error(error instanceof Error ? error.message : 'Unknown error')
  }
}

/**
 * Get current weather for specified coordinates
 */
export const getCurrentWeather = async (params: WeatherParams, httpClient: HttpClient): Promise<string> => {
  try {
    const db = getDb()
    const { temperatureUnit, distanceUnit } = await getSettings(db, {
      temperature_unit: 'f',
      distance_unit: 'imperial',
    })

    const response = await httpClient
      .post('pro/weather/current', {
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
export const getWeatherForecast = async (
  params: WeatherParams,
  httpClient: HttpClient,
): Promise<WeatherForecastData> => {
  try {
    const db = getDb()
    const { temperatureUnit, distanceUnit } = await getSettings(db, {
      temperature_unit: 'f',
      distance_unit: 'imperial',
    })

    const response = await httpClient
      .post('pro/weather/forecast', {
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
export const searchLocations = async (params: SearchLocationParams, httpClient: HttpClient): Promise<string> => {
  try {
    const db = getDb()
    const { temperatureUnit, distanceUnit } = await getSettings(db, {
      temperature_unit: 'f',
      distance_unit: 'imperial',
    })

    const response = await httpClient
      .post('pro/locations/search', {
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
