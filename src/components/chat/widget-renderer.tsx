/**
 * Widget renderer
 *
 * This file auto-wires widget components from the widget registry.
 * To add a new widget, update src/widgets/index.ts
 */

import type { Widget } from '@/ai/widget-types'
import type { TextUIPart } from 'ai'
import { widgetRegistry } from '@/widgets'
import { createElement, memo } from 'react'

type WidgetRendererProps = {
  widget: Widget
  messageId: string
  part: TextUIPart
}

/**
 * Renders a widget component based on its type
 * Passes messageId to each component - they handle their own enrichment
 *
 * Components are auto-loaded from the widget registry
 * Filters out widgets marked as hidden via part metadata
 */
export const WidgetRenderer = memo(({ widget, messageId, part }: WidgetRendererProps) => {
  const partWithMetadata = part as TextUIPart & { metadata?: { isHidden?: boolean } }
  if (partWithMetadata.metadata?.isHidden === true) {
    return null
  }

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
