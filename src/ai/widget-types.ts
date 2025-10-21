/**
 * Widget type definitions
 *
 * This file auto-generates types from the widget registry.
 * To add a new widget type, update src/widgets/index.ts
 */

import { widgetSchemas } from '@/widgets'
import { z } from 'zod'

/**
 * Union of all possible widget types - auto-generated from widget registry
 */
const _WidgetSchema = z.discriminatedUnion(
  'widget',
  widgetSchemas as unknown as readonly [z.ZodObject<any>, z.ZodObject<any>, ...z.ZodObject<any>[]],
)

export type Widget = z.infer<typeof _WidgetSchema>

/**
 * Individual widget types - import these from widget folders directly:
 *
 * import type { WeatherForecastWidgetType } from '@/widgets/weather-forecast'
 * import type { LinkPreviewWidgetType } from '@/widgets/link-preview'
 */
