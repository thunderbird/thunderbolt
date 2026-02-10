import { z } from 'zod'

/**
 * Schema for web search requests
 */
export const searchSchema = z
  .object({
    query: z.string().describe('The search query string'),
    max_results: z.number().describe('Maximum number of results to return'),
  })
  .strict()

/**
 * Schema for fetching webpage content
 */
export const fetchContentSchema = z
  .object({
    url: z.string().describe('Webpage URL to fetch content from'),
    max_length: z
      .number()
      .optional()
      .describe(
        'Maximum content length in characters (default: 16000, max: 64000). Increase if content was truncated.',
      ),
  })
  .strict()

/**
 * Schema for link preview metadata requests
 */
export const linkPreviewSchema = z
  .object({
    url: z.string().describe('URL to fetch preview metadata from'),
  })
  .strict()

/**
 * Schema for location search requests
 */
export const searchLocationSchema = z
  .object({
    query: z.string().describe('The location name to search for'),
    region: z.string().describe("The location's state or region."),
    country: z.string().describe("The location's country."),
  })
  .strict()

/**
 * Schema for weather requests
 */
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

/**
 * Data type for search results
 */
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
  sourceIndex?: number
}

/**
 * Data type for fetched webpage content.
 * - text: May be truncated to ~16K chars to prevent context overflow
 * - isTruncated: True if text was truncated
 */
export type FetchContentData = {
  url: string
  title: string | null
  text: string
  isTruncated?: boolean
  highlights?: string[]
  highlightScores?: number[]
  favicon: string | null
  image: string | null
  author: string | null
  published_date: string | null
  sourceIndex?: number
} | null

/**
 * Data type for link preview metadata
 */
export type LinkPreviewData = {
  title: string | null
  description: string | null
  image: string | null
}
