import type { Widget } from '@/ai/widget-types'
import { LinkPreviewWidget, WeatherForecastWidget } from '@/widgets'
import { memo } from 'react'

type WidgetRendererProps = {
  widget: Widget
  messageId: string
}

/**
 * Renders a widget component based on its type
 * Passes messageId to each component - they handle their own enrichment
 */
export const WidgetRenderer = memo(({ widget, messageId }: WidgetRendererProps) => {
  switch (widget.widget) {
    case 'weather-forecast':
      return <WeatherForecastWidget {...widget.args} messageId={messageId} />
    case 'link-preview':
      return <LinkPreviewWidget {...widget.args} messageId={messageId} />
    default:
      return null
  }
})
