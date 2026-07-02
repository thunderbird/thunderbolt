/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Widget tag parser
 *
 * This file auto-wires parsers from the widget registry.
 * To add a new widget parser, update src/widgets/index.ts
 */

import { widgetParsers, widgetSkeletons } from '@/widgets'
import type { Widget } from './widget-types'

export type ContentPart =
  | { type: 'text'; content: string }
  | { type: 'widget'; widget: Widget }
  | { type: 'widget-loading'; name: string }

/** Widget names that ship a streaming skeleton (so a placeholder is worth emitting). */
const skeletonWidgetNames = new Set(Object.keys(widgetSkeletons))

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
 * Extracts a single-quoted value containing JSON with apostrophes (e.g., "NASA's Mission").
 * Tracks bracket depth and "..." boundaries so only a ' outside JSON content closes the value.
 */
const extractSingleQuotedValue = (str: string, start: number): string | null => {
  let depth = 0
  let inString = false
  for (let i = start; i < str.length; i++) {
    const ch = str[i]
    if (inString) {
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '[' || ch === '{') {
      depth++
    } else if (ch === ']' || ch === '}') {
      depth--
    } else if (ch === "'" && depth === 0) {
      return str.slice(start, i)
    }
  }
  return null
}

/** Parses widget tag attributes. Double quotes use indexOf; single quotes use a depth-aware scanner. */
const parseAttributes = (attributesStr: string): Record<string, string> => {
  const attrs: Record<string, string> = {}
  const attrStart = /(\w+)=(['"])/g
  let match

  while ((match = attrStart.exec(attributesStr)) !== null) {
    const key = match[1]
    const quote = match[2]
    const valueStart = match.index + match[0].length

    if (quote === '"') {
      const end = attributesStr.indexOf('"', valueStart)
      if (end === -1) {
        continue
      }
      attrs[key] = attributesStr.slice(valueStart, end)
      attrStart.lastIndex = end + 1
    } else {
      const value = extractSingleQuotedValue(attributesStr, valueStart)
      if (!value) {
        continue
      }
      attrs[key] = value
      attrStart.lastIndex = valueStart + value.length + 1
    }
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
 * Strips model-native citation formats that leak through prompt constraints.
 * Only targets OpenAI-style patterns like 【2†title】 or 【6】 — preserves legitimate CJK brackets.
 */
const stripBracketCitations = (text: string): string =>
  text.replace(/\s*【\d+†[^】]*】/g, '').replace(/\s*【\d+】/g, '')

/**
 * Parses custom widget tags from text and returns an ordered array of text and widget parts
 * This preserves the position where the LLM placed the widgets in the response
 *
 * Format: <namespace:widget-name attr="value" attr2="value2" />
 * Example: <widget:weather-forecast location="Seattle" region="Washington" country="USA" />
 */
export const parseContentParts = (rawText: string): ContentPart[] => {
  const text = stripBracketCitations(rawText)
  const parts: ContentPart[] = []

  // Match any self-closing namespaced tag like widget:link-preview
  // Captures: namespacedTagName and attributes
  const widgetTagRegex = /<([a-z][a-z0-9-]*:[a-z][a-z0-9-]*)\s+((?:[^/]|\/(?!>))+)\/>/gi

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
    // Matches: < | <w | <wi | <wid | <widg | <widge | <widget | <widget:... (incomplete)
    const incompleteWidgetTagMatch = textAfter.match(
      /<(?:widget:[a-z0-9-]*(?:\s+[^>]*)?|w(?:i(?:d(?:g(?:e(?:t)?)?)?)?)?)?$/i,
    )

    // If the partial tag already names a known skeleton-capable widget (its name
    // is fully typed, followed by whitespace = into its attributes), emit a
    // loading placeholder so the widget's skeleton shows while its payload is
    // still streaming — instead of nothing until the closing `/>` arrives.
    let loadingName: string | null = null
    if (incompleteWidgetTagMatch) {
      const incompleteTag = textAfter.slice(incompleteWidgetTagMatch.index)
      textAfter = textAfter.slice(0, incompleteWidgetTagMatch.index).trim()
      const name = incompleteTag.match(/^<widget:([a-z][a-z0-9-]*)\s/i)?.[1]?.toLowerCase()
      if (name && skeletonWidgetNames.has(name)) {
        loadingName = name
      }
    }

    if (textAfter) {
      parts.push({ type: 'text', content: textAfter })
    }
    if (loadingName) {
      parts.push({ type: 'widget-loading', name: loadingName })
    }
  }

  return parts
}

/**
 * Streaming cache for {@link parseContentPartsIncremental}. Keyed on the exact
 * raw text so the reference of {@link parts} stays stable across renders that
 * don't change the text, and `hasMarkers` records whether a full parse is needed.
 */
export type ContentPartsState = {
  rawText: string
  parts: ContentPart[]
  hasMarkers: boolean
}

/**
 * Whether text contains a widget-tag opener (`<`) or a model-native citation
 * bracket (`【`) — the only markers {@link parseContentParts} reacts to. Marker-free
 * text always parses to a single trimmed text part (or none).
 */
const hasContentMarker = (text: string): boolean => text.includes('<') || text.includes('【')

/**
 * Incremental {@link parseContentParts} for the streaming-append case.
 *
 * The overwhelmingly common streamed message is marker-free prose, which parses
 * to a single trimmed text part. When the previous text was marker-free and the
 * appended tail introduces no markers either, that result is produced directly —
 * skipping the citation-strip and widget-tag scans that otherwise re-run over the
 * whole growing string every token. Anything containing widget tags or citation
 * brackets falls back to a full parse (correctness over cleverness).
 *
 * @param rawText - Current full text of the streamed part.
 * @param prev - State from the previous call for the same part, or null.
 * @returns The parsed parts plus the state to thread into the next call.
 */
export const parseContentPartsIncremental = (
  rawText: string,
  prev: ContentPartsState | null,
): { parts: ContentPart[]; state: ContentPartsState } => {
  if (prev && prev.rawText === rawText) {
    return { parts: prev.parts, state: prev }
  }

  const isMarkerFreeAppend =
    prev !== null && prev.rawText.length > 0 && !prev.hasMarkers && rawText.startsWith(prev.rawText)
  if (isMarkerFreeAppend && !hasContentMarker(rawText.slice(prev.rawText.length))) {
    const trimmed = rawText.trim()
    const parts: ContentPart[] = trimmed ? [{ type: 'text', content: trimmed }] : []
    return { parts, state: { rawText, parts, hasMarkers: false } }
  }

  const parts = parseContentParts(rawText)
  return { parts, state: { rawText, parts, hasMarkers: hasContentMarker(rawText) } }
}
