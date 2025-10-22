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
 * Type assertion is safe because we know the schemas are discriminated unions at runtime
 */
const _WidgetSchema = z.discriminatedUnion(
  'widget',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  widgetSchemas as any,
)

export type Widget = z.infer<typeof _WidgetSchema>

/**
 * Individual widget types - import these from widget folders directly:
 *
 * import type { WeatherForecastWidgetType } from '@/widgets/weather-forecast'
 * import type { LinkPreviewWidgetType } from '@/widgets/link-preview'
 */
