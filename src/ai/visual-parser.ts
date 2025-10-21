import type { Visual } from './visual-types'

export type ContentPart = { type: 'text'; content: string } | { type: 'visual'; visual: Visual }

/**
 * Defines how to parse and validate a specific visual type
 */
type VisualSpec = {
  tagName: string
  parse: (attrs: Record<string, string>) => Visual | null
}

/**
 * Registry of all supported visual types
 * To add a new visual type, just add a new spec to this array
 *
 * Example:
 * {
 *   tagName: 'stock-chart',
 *   parse: (attrs) => {
 *     if (!attrs.symbol || !attrs.range) return null
 *     return {
 *       visual: 'stock-chart',
 *       args: {
 *         symbol: attrs.symbol.toUpperCase(),
 *         range: attrs.range,
 *         showVolume: attrs.showVolume === 'true',
 *       },
 *     }
 *   },
 * }
 */
const visualSpecs: VisualSpec[] = [
  {
    tagName: 'weather-forecast',
    parse: (attrs) => {
      if (!attrs.location || !attrs.region || !attrs.country) {
        return null
      }
      return {
        visual: 'weather-forecast',
        args: {
          location: attrs.location,
          region: attrs.region,
          country: attrs.country,
        },
      }
    },
  },
  {
    tagName: 'link-preview',
    parse: (attrs) => {
      if (!attrs.url?.trim()) {
        return null
      }
      return {
        visual: 'link-preview',
        args: {
          url: attrs.url,
        },
      }
    },
  },
]

/**
 * Parses attributes from a visual tag's attribute string
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
 * Creates a Visual object from tag name and attributes using the registry
 */
const createVisual = (tagName: string, attrs: Record<string, string>): Visual | null => {
  const normalizedTagName = tagName.toLowerCase()

  const spec = visualSpecs.find((s) => s.tagName === normalizedTagName)
  if (!spec) {
    return null
  }

  return spec.parse(attrs)
}

/**
 * Parses custom visual tags from text and returns an ordered array of text and visual parts
 * This preserves the position where the LLM placed the visuals in the response
 *
 * Format: <visual-name attr="value" attr2="value2" />
 * Example: <weather-forecast location="Seattle" region="Washington" country="USA" />
 */
export const parseContentParts = (text: string): ContentPart[] => {
  const parts: ContentPart[] = []

  // Match any self-closing tag with kebab-case naming
  // Captures: tagName and attributes
  const visualTagRegex = /<([a-z][a-z0-9-]*)\s+((?:[^/]|\/(?!>))+)\/>/gi

  let lastIndex = 0
  let match: RegExpExecArray | null

  // Process each visual tag sequentially
  while ((match = visualTagRegex.exec(text)) !== null) {
    const matchIndex = match.index
    const fullTag = match[0]
    const tagName = match[1]
    const attributesStr = match[2]

    // Add text before this visual if there is any
    if (matchIndex > lastIndex) {
      const textBefore = text.slice(lastIndex, matchIndex).trim()
      if (textBefore) {
        parts.push({ type: 'text', content: textBefore })
      }
    }

    // Parse and create the visual
    const attrs = parseAttributes(attributesStr)
    const visual = createVisual(tagName, attrs)

    if (visual) {
      parts.push({ type: 'visual', visual })
    }

    lastIndex = matchIndex + fullTag.length
  }

  // Add remaining text after the last match (or all text if no matches)
  if (lastIndex < text.length) {
    let textAfter = text.slice(lastIndex).trim()

    // Remove incomplete tags at the end (for streaming)
    const incompleteTagMatch = textAfter.match(/<[^>]*$/)
    if (incompleteTagMatch) {
      textAfter = textAfter.slice(0, incompleteTagMatch.index).trim()
    }

    if (textAfter) {
      parts.push({ type: 'text', content: textAfter })
    }
  }

  return parts
}
