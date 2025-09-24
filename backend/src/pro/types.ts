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
})

export const weatherResponseSchema = z.object({
  weather_data: z.string().nullable().optional(),
  data: weatherForecastDataSchema.nullable().optional(),
  success: z.boolean(),
  error: z.string().nullable().optional(),
})

export type WeatherRequest = z.infer<typeof weatherRequestSchema>
export type WeatherDay = z.infer<typeof weatherDaySchema>
export type WeatherForecastData = z.infer<typeof weatherForecastDataSchema>
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
