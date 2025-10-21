/**
 * Central registry for all widget components and their AI instructions
 */

import { instructions as linkPreviewInstructions } from './link-preview'
import { instructions as weatherForecastInstructions } from './weather-forecast'

export { LinkPreview, LinkPreviewSkeleton, LinkPreviewWidget } from './link-preview'
export { WeatherForecastWidget } from './weather-forecast'

/**
 * Aggregated instructions for all widgets to be included in the AI system prompt
 */
export const widgetPrompts = [
  '# Widget Components',
  'Use these XML-like tags in your response to show rich widgets:',
  '',
  weatherForecastInstructions,
  '',
  linkPreviewInstructions,
].join('\n')
