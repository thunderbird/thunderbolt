import type { ToolConfig } from '@/types'
import {
  fetchContent,
  fetchContentSchema,
  getCurrentWeather,
  getWeatherForecast,
  search,
  searchLocations,
  searchLocationSchema,
  searchSchema,
  weatherSchema,
  type FetchContentParams,
  type SearchLocationParams,
  type SearchParams,
  type SearchResultData,
  type WeatherParams,
} from './api'

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
 * Tool configurations for Thunderbolt Pro
 */
export const configs: ToolConfig[] = [
  {
    name: 'search',
    description: `Search the web and return relevant links.`,
    verb: 'searching for {query}',
    parameters: searchSchema,
    execute: search,
  },
  {
    name: 'fetch_content',
    description: `Fetch and parse content from a webpage URL.`,
    verb: 'fetching {url}',
    parameters: fetchContentSchema,
    execute: fetchContent,
  },
]
