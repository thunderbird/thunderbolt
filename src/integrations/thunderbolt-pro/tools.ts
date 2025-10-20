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
export type { FetchContentParams, SearchLocationParams, SearchParams, WeatherParams }

/**
 * Tool configurations for Thunderbolt Pro
 */
export const configs: ToolConfig[] = [
  {
    name: 'search',
    description: `Search the web and return relevant results.

After calling this tool and presenting results to the user, use <link-preview url="..." /> tags to show previews of the most relevant URLs (typically 1-3).`,
    verb: 'searching for {query}',
    parameters: searchSchema,
    execute: search,
  },
  {
    name: 'fetch_content',
    description: `Fetch and parse content from a webpage URL.

After calling this tool to fetch a URL, include a <link-preview url="..." /> tag in your response to show a preview card of that content.`,
    verb: 'fetching {url}',
    parameters: fetchContentSchema,
    execute: fetchContent,
  },
]
