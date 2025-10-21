import type { Visual } from '@/ai/visual-types'
import { memo } from 'react'
import { LinkPreviewVisual } from './link-preview'
import { WeatherForecastVisual } from './weather-forecast-visual'

type VisualRendererProps = {
  visual: Visual
  messageId: string
}

/**
 * Renders a visual component based on its type
 * Passes messageId to each component - they handle their own enrichment
 */
export const VisualRenderer = memo(({ visual, messageId }: VisualRendererProps) => {
  switch (visual.visual) {
    case 'weather-forecast':
      return <WeatherForecastVisual {...visual.args} messageId={messageId} />
    case 'link-preview':
      return <LinkPreviewVisual {...visual.args} messageId={messageId} />
    default:
      return null
  }
})
