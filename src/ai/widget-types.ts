import { z } from 'zod'

/**
 * Schema for widget components that can be rendered in the UI via XML-like tags
 */
const WeatherForecastWidgetSchema = z.object({
  widget: z.literal('weather-forecast'),
  args: z.object({
    location: z.string().describe('The city name'),
    region: z.string().describe('The state or region'),
    country: z.string().describe('The country'),
  }),
})

const LinkPreviewWidgetSchema = z.object({
  widget: z.literal('link-preview'),
  args: z.object({
    url: z.string().describe('The URL to preview'),
  }),
})

/**
 * Union of all possible widget types
 * Add new widget types here as they're created
 */
const _WidgetSchema = z.discriminatedUnion('widget', [WeatherForecastWidgetSchema, LinkPreviewWidgetSchema])

export type Widget = z.infer<typeof _WidgetSchema>
export type WeatherForecastWidget = z.infer<typeof WeatherForecastWidgetSchema>
export type LinkPreviewWidget = z.infer<typeof LinkPreviewWidgetSchema>
