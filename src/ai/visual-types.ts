import { z } from 'zod'

/**
 * Schema for visual components that can be rendered in the UI via XML tags
 */
const WeatherForecastVisualSchema = z.object({
  visual: z.literal('weather-forecast'),
  args: z.object({
    location: z.string().describe('The city name'),
    region: z.string().describe('The state or region'),
    country: z.string().describe('The country'),
    days: z.number().min(1).max(16).describe('Number of days to forecast (1-16)'),
  }),
})

const LinkPreviewVisualSchema = z.object({
  visual: z.literal('link-preview'),
  args: z.object({
    url: z.string().describe('The URL to preview'),
  }),
})

/**
 * Union of all possible visual types
 * Add new visual types here as they're created
 */
const _VisualSchema = z.discriminatedUnion('visual', [WeatherForecastVisualSchema, LinkPreviewVisualSchema])

export type Visual = z.infer<typeof _VisualSchema>
export type WeatherForecastVisual = z.infer<typeof WeatherForecastVisualSchema>
export type LinkPreviewVisual = z.infer<typeof LinkPreviewVisualSchema>
