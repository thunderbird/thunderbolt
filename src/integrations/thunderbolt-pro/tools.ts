import type { HttpClient } from '@/contexts'
import type { ToolConfig } from '@/types'
import ky from 'ky'
import { fetchContent, getCurrentWeather, getWeatherForecast, search, searchLocations } from './api'
import {
  fetchContentSchema,
  searchLocationSchema,
  searchSchema,
  weatherSchema,
  type FetchContentParams,
  type SearchLocationParams,
  type SearchParams,
  type SearchResultData,
  type WeatherParams,
} from './schemas'

// Re-export everything from api for backward compatibility
export {
  fetchContent,
  fetchContentSchema,
  getCurrentWeather,
  getWeatherForecast,
  search,
  searchLocations,
  searchLocationSchema,
  searchSchema,
  weatherSchema,
}
export type { FetchContentParams, SearchLocationParams, SearchParams, SearchResultData, WeatherParams }

/**
 * Thunderbolt Pro Tools Configuration Factory
 * @param httpClient - HTTP client for making requests (injected for dependency injection)
 */
export const createConfigs = (httpClient: HttpClient): ToolConfig[] => [
  {
    name: 'search',
    description: `Search the web and return relevant links.`,
    verb: 'searching for {query}',
    parameters: searchSchema,
    execute: (params: SearchParams) => search(params, httpClient),
  },
  {
    name: 'fetch_content',
    description: `Fetch and parse content from a webpage URL.`,
    verb: 'fetching {url}',
    parameters: fetchContentSchema,
    execute: (params: FetchContentParams) => fetchContent(params, httpClient),
  },
]

/**
 * Default configs using the global ky instance
 * @deprecated Use createConfigs() with an injected httpClient instead
 */
export const configs: ToolConfig[] = createConfigs(ky)
