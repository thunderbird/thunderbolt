import type { HttpClient } from '@/contexts'
import { deriveSiteName } from '@/lib/source-utils'
import type { ToolConfig } from '@/types'
import type { SourceMetadata } from '@/types/source'
import ky from 'ky'
import { fetchContent, fetchLinkPreview, getCurrentWeather, getWeatherForecast, search, searchLocations } from './api'
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

const sourceRegistryCap = 200

/**
 * Thunderbolt Pro Tools Configuration Factory
 * @param httpClient - HTTP client for making requests (injected for dependency injection)
 * @param sourceCollector - Optional shared array to accumulate source metadata during tool execution
 */
export const createConfigs = (httpClient: HttpClient, sourceCollector?: SourceMetadata[]): ToolConfig[] => {
  let nextIndex = (sourceCollector?.length ?? 0) + 1

  return [
    {
      name: 'search',
      description: 'Search the web. Each result has a [Source N] label. Cite with [N] at end of sentence.',
      verb: 'searching for {query}',
      parameters: searchSchema,
      execute: async (params: SearchParams) => {
        const results = await search(params, httpClient)

        return results.map((result) => {
          const existingSource = sourceCollector?.find((s) => s.url === result.url)
          const sourceIndex = existingSource ? existingSource.index : nextIndex

          if (!existingSource && sourceCollector && sourceCollector.length < sourceRegistryCap) {
            sourceCollector.push({
              index: sourceIndex,
              url: result.url,
              title: result.title ?? result.url,
              description: result.summary,
              image: result.image,
              favicon: result.favicon,
              siteName: deriveSiteName(result.url),
              author: result.author,
              publishedDate: result.publishedDate,
              toolName: 'search',
            })
            nextIndex++
          } else if (!existingSource) {
            if (sourceCollector && sourceCollector.length >= sourceRegistryCap) {
              console.warn(
                `Source registry cap (${sourceRegistryCap}) reached — dropping source [${sourceIndex}]: ${result.url}`,
              )
            }
            nextIndex++
          }

          return { sourceLabel: `[Source ${sourceIndex}] (cite as [${sourceIndex}])`, sourceIndex, ...result }
        })
      },
    },
    {
      name: 'fetch_content',
      description:
        'Fetch and parse content from a PUBLIC webpage URL. Result has a [Source N] label. Cite with [N] at end of sentence. Do NOT use for Google Drive, Docs, Sheets, or Slides links (use google_get_drive_file_content instead). Do NOT use for OneDrive or SharePoint links (use microsoft_get_onedrive_file_content instead).',
      verb: 'fetching {url}',
      parameters: fetchContentSchema,
      execute: async (params: FetchContentParams) => {
        // Fetch content and link preview in parallel — link preview gives us og:site_name
        const [result, preview] = await Promise.all([
          fetchContent(params, httpClient),
          fetchLinkPreview({ url: params.url }, httpClient).catch(() => null),
        ])

        if (!result) return result

        const ogSiteName = preview?.siteName
        const existingSource = sourceCollector?.find((s) => s.url === result.url)
        const sourceIndex = existingSource ? existingSource.index : nextIndex

        if (!existingSource && sourceCollector && sourceCollector.length < sourceRegistryCap) {
          sourceCollector.push({
            index: sourceIndex,
            url: result.url,
            title: result.title ?? result.url,
            description: result.text?.slice(0, 200),
            image: preview?.image ?? result.image,
            favicon: result.favicon,
            siteName: ogSiteName || deriveSiteName(result.url),
            author: result.author,
            publishedDate: result.published_date,
            toolName: 'fetch_content',
          })
          nextIndex++
        } else if (existingSource) {
          // fetch_content has the authoritative page title — update the existing entry
          if (result.title) existingSource.title = result.title
          if (result.text) existingSource.description = result.text.slice(0, 200)
          if (preview?.image ?? result.image) existingSource.image = preview?.image ?? result.image
          if (result.favicon) existingSource.favicon = result.favicon
          if (ogSiteName) existingSource.siteName = ogSiteName
          if (result.author) existingSource.author = result.author
          if (result.published_date) existingSource.publishedDate = result.published_date
        } else {
          if (sourceCollector && sourceCollector.length >= sourceRegistryCap) {
            console.warn(
              `Source registry cap (${sourceRegistryCap}) reached — dropping source [${sourceIndex}]: ${result.url}`,
            )
          }
          nextIndex++
        }

        return { sourceLabel: `[Source ${sourceIndex}] (cite as [${sourceIndex}])`, sourceIndex, ...result }
      },
    },
  ]
}

/**
 * Default configs using the global ky instance
 * @deprecated Use createConfigs() with an injected httpClient instead
 */
export const configs: ToolConfig[] = createConfigs(ky)
