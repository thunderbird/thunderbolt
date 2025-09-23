import { z } from 'zod'

/**
 * Search request/response schemas
 */
export const searchRequestSchema = z.object({
  query: z.string(),
  max_results: z.number().default(10),
})

export const searchResponseSchema = z.object({
  results: z.string(),
  success: z.boolean(),
  error: z.string().nullable().optional(),
})

export type SearchRequest = z.infer<typeof searchRequestSchema>
export type SearchResponse = z.infer<typeof searchResponseSchema>

/**
 * Fetch content request/response schemas
 */
export const fetchContentRequestSchema = z.object({
  url: z.string(),
})

export const fetchContentResponseSchema = z.object({
  content: z.string(),
  success: z.boolean(),
  error: z.string().nullable().optional(),
})

export type FetchContentRequest = z.infer<typeof fetchContentRequestSchema>
export type FetchContentResponse = z.infer<typeof fetchContentResponseSchema>

/**
 * Weather request/response schemas
 */
export const weatherRequestSchema = z.object({
  location: z.string(),
  days: z.number().default(3), // Only used for forecast
})

export const weatherResponseSchema = z.object({
  weather_data: z.string(),
  success: z.boolean(),
  error: z.string().nullable().optional(),
})

export type WeatherRequest = z.infer<typeof weatherRequestSchema>
export type WeatherResponse = z.infer<typeof weatherResponseSchema>

/**
 * Location search request/response schemas
 */
export const locationSearchRequestSchema = z.object({
  query: z.string(),
})

export const locationSearchResponseSchema = z.object({
  locations: z.string(),
  success: z.boolean(),
  error: z.string().nullable().optional(),
})

export type LocationSearchRequest = z.infer<typeof locationSearchRequestSchema>
export type LocationSearchResponse = z.infer<typeof locationSearchResponseSchema>
