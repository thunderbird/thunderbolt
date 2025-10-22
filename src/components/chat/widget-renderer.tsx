/**
 * Widget renderer
 *
 * This file auto-wires widget components from the widget registry.
 * To add a new widget, update src/widgets/index.ts
 */

import type { Widget } from '@/ai/widget-types'
import { widgetRegistry } from '@/widgets'
import { createElement, memo } from 'react'

type WidgetRendererProps = {
  widget: Widget
  messageId: string
}

/**
 * Renders a widget component based on its type
 * Passes messageId to each component - they handle their own enrichment
 *
 * Components are auto-loaded from the widget registry
 */
export const WidgetRenderer = memo(({ widget, messageId }: WidgetRendererProps) => {
  const widgetConfig = widgetRegistry.find((w) => w.name === widget.widget)

  if (!widgetConfig) {
    return null
  }

  // Type safety is ensured by the widget registry - widget.args matches the component's props
  return createElement(
    widgetConfig.module.Component as React.ComponentType<Record<string, unknown> & { messageId: string }>,
    {
      ...widget.args,
      messageId,
    },
  )
})
