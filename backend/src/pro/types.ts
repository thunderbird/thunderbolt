import { type SearchResult } from 'exa-js'
import { z } from 'zod'

/**
 * Base API response schema that all endpoints should extend
 */
export const baseApiResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    data: dataSchema.nullable(),
    success: z.boolean(),
    error: z.string().nullable().optional(),
  })

export type BaseApiResponse<T> = {
  data: T | null
  success: boolean
  error?: string | null
}

/**
 * Search request/response schemas
 */
export const searchRequestSchema = z.object({
  query: z.string(),
  max_results: z.number().default(10),
})

export type SearchRequest = z.infer<typeof searchRequestSchema>
export type SearchResponse = {
  data: SearchResult<{}>[]
  success: boolean
  error?: string | null
}

/**
 * Fetch content request/response schemas
 */
export const fetchContentRequestSchema = z.object({
  url: z.string(),
})

export type FetchContentRequest = z.infer<typeof fetchContentRequestSchema>

/**
 * FetchContentData extends Exa's SearchResult with additional fields for graceful degradation.
 * - text: Truncated to maxCharacters (16K) to prevent context overflow
 * - isTruncated: Flag indicating if text was truncated
 */
export type FetchContentData = SearchResult<{ text: { maxCharacters: number } }> & {
  isTruncated: boolean
}

export type FetchContentResponse = {
  data: FetchContentData | null
  success: boolean
  error?: string | null
}

/**
 * Weather request/response schemas
 */
export const weatherRequestSchema = z.object({
  location: z.string(),
  region: z.string(),
  country: z.string(),
  days: z.number().default(3), // Only used for forecast
})

export const weatherDaySchema = z.object({
  date: z.string(),
  weather_code: z.number(),
  temperature_max: z.number(),
  temperature_min: z.number(),
  apparent_temperature_max: z.number(),
  apparent_temperature_min: z.number(),
  precipitation_sum: z.number(),
  precipitation_probability_max: z.number(),
  wind_speed_10m_max: z.number(),
})

export const weatherForecastDataSchema = z.object({
  location: z.string(),
  days: z.array(weatherDaySchema),
  temperature_unit: z.enum(['c', 'f']),
})

export const weatherCurrentResponseSchema = baseApiResponseSchema(z.string())
export const weatherForecastResponseSchema = baseApiResponseSchema(weatherForecastDataSchema)

export type WeatherRequest = z.infer<typeof weatherRequestSchema>
export type WeatherDay = z.infer<typeof weatherDaySchema>
export type WeatherForecastData = z.infer<typeof weatherForecastDataSchema>
export type WeatherCurrentResponse = z.infer<typeof weatherCurrentResponseSchema>
export type WeatherForecastResponse = z.infer<typeof weatherForecastResponseSchema>

/**
 * Location search request/response schemas
 */
export const locationSearchRequestSchema = z.object({
  query: z.string(),
  region: z.string(),
  country: z.string(),
})

export const locationSearchResponseSchema = baseApiResponseSchema(z.string())

export type LocationSearchRequest = z.infer<typeof locationSearchRequestSchema>
export type LocationSearchResponse = z.infer<typeof locationSearchResponseSchema>

/**
 * Link preview request/response schemas
 */
export const linkPreviewDataSchema = z.object({
  title: z.string().nullable(),
  description: z.string().nullable(),
  image: z.string().nullable(),
  siteName: z.string().nullable(),
})

export const linkPreviewResponseSchema = baseApiResponseSchema(linkPreviewDataSchema)

export type LinkPreviewData = z.infer<typeof linkPreviewDataSchema>
export type LinkPreviewResponse = z.infer<typeof linkPreviewResponseSchema>
