/**
 * Widget tag parser
 *
 * This file auto-wires parsers from the widget registry.
 * To add a new widget parser, update src/widgets/index.ts
 */

import { widgetParsers } from '@/widgets'
import type { Widget } from './widget-types'

export type ContentPart = { type: 'text'; content: string } | { type: 'widget'; widget: Widget }

/**
 * Defines how to parse and validate a specific widget type
 */
type WidgetSpec = {
  tagName: string
  parse: (attrs: Record<string, string>) => Widget | null
}

/**
 * Registry of all supported widget types - auto-loaded from widget registry
 */
const widgetSpecs: WidgetSpec[] = widgetParsers

/**
 * Parses attributes from a widget tag's attribute string
 * Example: 'location="Seattle" region="WA"' -> { location: 'Seattle', region: 'WA' }
 */
const parseAttributes = (attributesStr: string): Record<string, string> => {
  const attrs: Record<string, string> = {}
  const attrRegex = /(\w+)="([^"]*)"/g
  let match

  while ((match = attrRegex.exec(attributesStr)) !== null) {
    attrs[match[1]] = match[2]
  }

  return attrs
}

/**
 * Creates a Widget object from namespaced tag name and attributes using the registry
 */
const createWidget = (tagName: string, attrs: Record<string, string>): Widget | null => {
  const normalizedTagName = tagName.toLowerCase()

  const [namespace, componentName] = normalizedTagName.split(':')
  if (namespace !== 'widget' || !componentName) {
    return null
  }

  const spec = widgetSpecs.find((s) => s.tagName === componentName)
  if (!spec) {
    return null
  }

  return spec.parse(attrs)
}

/**
 * Parses custom widget tags from text and returns an ordered array of text and widget parts
 * This preserves the position where the LLM placed the widgets in the response
 *
 * Format: <namespace:widget-name attr="value" attr2="value2" />
 * Example: <widget:weather-forecast location="Seattle" region="Washington" country="USA" />
 */
export const parseContentParts = (text: string): ContentPart[] => {
  const parts: ContentPart[] = []

  // Match any self-closing namespaced tag like widget:link-preview
  // Captures: namespacedTagName and attributes
  const widgetTagRegex = /<([a-z][a-z0-9-]*:[a-z][a-z0-9-]*)\s+((?:[^\/]|\/(?!>))+)\/>/gi

  let lastIndex = 0
  let match: RegExpExecArray | null

  // Process each widget tag sequentially
  while ((match = widgetTagRegex.exec(text)) !== null) {
    const matchIndex = match.index
    const fullTag = match[0]
    const tagName = match[1]
    const attributesStr = match[2]

    // Add text before this widget if there is any
    if (matchIndex > lastIndex) {
      const textBefore = text.slice(lastIndex, matchIndex).trim()
      if (textBefore) {
        parts.push({ type: 'text', content: textBefore })
      }
    }

    // Parse and create the widget
    const attrs = parseAttributes(attributesStr)
    const widget = createWidget(tagName, attrs)

    if (widget) {
      parts.push({ type: 'widget', widget })
    }

    lastIndex = matchIndex + fullTag.length
  }

  // Add remaining text after the last match (or all text if no matches)
  if (lastIndex < text.length) {
    let textAfter = text.slice(lastIndex).trim()

    // Remove incomplete widget tags at the end (for streaming)
    const incompleteWidgetTagMatch = textAfter.match(/<[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?(?:\s+[^>]*)?$/)
    if (incompleteWidgetTagMatch) {
      textAfter = textAfter.slice(0, incompleteWidgetTagMatch.index).trim()
    }

    if (textAfter) {
      parts.push({ type: 'text', content: textAfter })
    }
  }

  return parts
}
