/**
 * Central registry for all widget components and their AI instructions
 *
 * To add a new widget:
 * 1. Create a new directory under src/widgets/ with:
 *    - instructions.ts (AI prompt instructions)
 *    - schema.ts (Zod schema + parse function)
 *    - [widget-name].tsx (React component)
 *    - [widget-name].stories.tsx (Storybook stories - optional)
 *    - index.ts (exports all of the above)
 * 2. Add the widget to the widgetRegistry array below
 *
 * That's it! Everything else auto-wires.
 */

import * as citation from './citation'
import * as connectIntegration from './connect-integration'
import * as linkPreview from './link-preview'
import * as weatherForecast from './weather-forecast'

// Re-export components for easy importing
export { CitationBadge } from './citation'
export { ConnectIntegrationWidget } from './connect-integration'
export { LinkPreview, LinkPreviewSkeleton, LinkPreviewWidget } from './link-preview'
export { WeatherForecastWidget } from './weather-forecast'

/**
 * Widget registry - ADD YOUR WIDGET HERE
 * This is the single source of truth for all widgets in the system
 */
export const widgetRegistry = [
  {
    name: 'citation' as const,
    module: citation,
  },
  {
    name: 'connect-integration' as const,
    module: connectIntegration,
  },
  {
    name: 'weather-forecast' as const,
    module: weatherForecast,
  },
  {
    name: 'link-preview' as const,
    module: linkPreview,
  },
] as const

/**
 * Aggregated instructions for all widgets to be included in the AI system prompt
 */
export const widgetPrompts = [
  '# Widget Components',
  'Use these XML-like tags in your response to show rich widgets:',
  '',
  ...widgetRegistry.flatMap((widget) => [widget.module.instructions, '']),
]
  .join('\n')
  .trim()

/**
 * Widget name type - auto-generated from registry
 */
export type WidgetName = (typeof widgetRegistry)[number]['name']

/**
 * Parser registry for widget-parser.ts
 */
export const widgetParsers = widgetRegistry.map((widget) => ({
  tagName: widget.name,
  parse: widget.module.parse,
}))

/**
 * Schema registry for widget-types.ts
 */
export const widgetSchemas = widgetRegistry.map((widget) => widget.module.schema)

/**
 * Component registry for widget-renderer.tsx
 */
export const widgetComponents = Object.fromEntries(
  widgetRegistry.map((widget) => [widget.name, widget.module.Component]),
) as Record<WidgetName, React.ComponentType<any>>

/**
 * Union type of all widget cache data - auto-generated from registry
 * This is used for the chat message cache field
 */
export type WidgetCacheData =
  | connectIntegration.CacheData
  | linkPreview.CacheData
  | weatherForecast.CacheData
  | citation.CacheData
