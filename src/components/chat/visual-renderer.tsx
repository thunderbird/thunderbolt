import type { Visual } from '@/ai/visual-types'
import { memo } from 'react'
import { LinkPreviewVisual } from './link-preview'
import { WeatherForecastVisual } from './weather-forecast-visual'

type VisualRendererProps = {
  visual: Visual
}

/**
 * Renders a visual component based on its type
 */
export const VisualRenderer = memo(({ visual }: VisualRendererProps) => {
  switch (visual.visual) {
    case 'weather-forecast':
      return <WeatherForecastVisual {...visual.args} />
    case 'link-preview':
      return <LinkPreviewVisual {...visual.args} />
    default:
      return null
  }
})
