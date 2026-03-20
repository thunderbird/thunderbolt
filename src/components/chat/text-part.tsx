import { type ContentPart, parseContentParts } from '@/ai/widget-parser'
import { sourceToCitation } from '@/lib/source-utils'
import type { CitationMap, CitationSource } from '@/types/citation'
import type { SourceMetadata } from '@/types/source'
import { type TextUIPart } from 'ai'
import { memo, useMemo } from 'react'
import { CitationPopoverProvider } from './citation-popover'
import { CitationContext, citationMarkdownComponents } from './markdown-utils'
import { MemoizedMarkdown } from './memoized-markdown'
import { WidgetRenderer } from './widget-renderer'

type TextPartProps = {
  part: TextUIPart
  messageId: string
  sources?: SourceMetadata[]
}

/**
 * Matches one or more adjacent [N] citations separated by optional whitespace.
 * Negative lookahead on each [N] prevents matching markdown links [text](url).
 */
const groupedCitationRegex = /\[\d+\](?!\()(?:\s*\[\d+\](?!\())*/g

/** Extracts individual [N] numbers from a matched group */
const individualCitationRegex = /\[(\d+)\]/g

/** Normalize URL for dedup: lowercase host, strip trailing slash */
const normalizeUrl = (url: string): string => {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/$/, '')}${parsed.search}`
  } catch {
    return url.toLowerCase().replace(/\/$/, '')
  }
}

/** Filter out duplicate link-preview widgets, keeping first occurrence */
export const deduplicateLinkPreviews = (parts: ContentPart[]): ContentPart[] => {
  const seen = new Set<string>()
  return parts.filter((part) => {
    if (part.type !== 'widget' || part.widget.widget !== 'link-preview') {
      return true
    }
    const url = normalizeUrl((part.widget.args as { url: string }).url)
    if (seen.has(url)) {
      return false
    }
    seen.add(url)
    return true
  })
}

/**
 * Detects `[N]` citation patterns in text and builds a CitationMap from SourceMetadata[].
 * Each `[N]` where `N-1` is a valid index into `sources` becomes a `{{CITE:mapKey}}` placeholder.
 * Out-of-range references are left as-is in the text.
 * @param startKey - Initial key value for the citation map (default 0). Use to avoid key collisions when processing multiple segments.
 * @returns fullText with placeholders, and the corresponding CitationMap
 */
export const buildSourceCitationPlaceholders = (
  text: string,
  sources: SourceMetadata[],
  startKey = 0,
): { fullText: string; citations: CitationMap } => {
  const citations: CitationMap = new Map()
  let nextKey = startKey

  const fullText = text.replace(groupedCitationRegex, (match) => {
    const validSources: CitationSource[] = []
    for (const m of match.matchAll(individualCitationRegex)) {
      const n = parseInt(m[1], 10)
      const source = sources[n - 1]
      if (source) {
        validSources.push(sourceToCitation(source, validSources.length === 0))
      }
    }

    if (validSources.length === 0) {
      return match
    }

    const key = nextKey++
    citations.set(key, validSources)
    return `{{CITE:${key}}}`
  })

  return { fullText, citations }
}

export const TextPart = memo(({ part, messageId, sources }: TextPartProps) => {
  const hasNewSources = !!sources && sources.length > 0

  // Build citation data upfront so the hook is always called in the same order
  const { processedParts, citations, hasCitations, hasText } = useMemo(() => {
    if (!part.text) {
      return {
        processedParts: [] as ContentPart[],
        citations: new Map() as CitationMap,
        hasCitations: false,
        hasText: false,
      }
    }

    const parts = parseContentParts(part.text)

    if (hasNewSources) {
      let keyOffset = 0
      const mergedCitations: CitationMap = new Map()
      const processedParts: ContentPart[] = parts.map((p) => {
        if (p.type !== 'text') {
          return p
        }
        const { fullText, citations } = buildSourceCitationPlaceholders(p.content, sources, keyOffset)
        for (const [key, value] of citations) {
          mergedCitations.set(key, value)
        }
        keyOffset += citations.size
        return { type: 'text' as const, content: fullText }
      })

      const hasCit = mergedCitations.size > 0
      return {
        processedParts,
        citations: mergedCitations,
        hasCitations: hasCit,
        hasText: parts.some((p) => p.type === 'text' && p.content.length > 0),
      }
    }

    return {
      processedParts: parts,
      citations: new Map() as CitationMap,
      hasCitations: false,
      hasText: parts.some((p) => p.type === 'text'),
    }
  }, [part.text, hasNewSources, sources])

  const dedupedParts = useMemo(() => deduplicateLinkPreviews(processedParts), [processedParts])

  if (!part.text) {
    return null
  }

  if (hasCitations && hasText) {
    return (
      <CitationPopoverProvider>
        <CitationContext.Provider value={citations}>
          {dedupedParts.map((part, index) => {
            if (part.type === 'text') {
              return (
                <div key={`text-${index}`} className="p-4 my-2">
                  <MemoizedMarkdown
                    key={`${messageId}-text-${index}`}
                    id={`${messageId}-${index}`}
                    content={part.content}
                    components={citationMarkdownComponents}
                  />
                </div>
              )
            }
            return (
              <div
                key={
                  part.widget.widget === 'link-preview' ? (part.widget.args as { url: string }).url : `widget-${index}`
                }
                className="animate-in slide-in-from-bottom-2 fade-in duration-300 ease-out"
              >
                <WidgetRenderer widget={part.widget} messageId={messageId} sources={sources} />
              </div>
            )
          })}
        </CitationContext.Provider>
      </CitationPopoverProvider>
    )
  }

  // Default behavior for block-level widgets or no citations
  return (
    <>
      {dedupedParts.map((contentPart, index) => {
        if (contentPart.type === 'text') {
          return (
            <div key={`text-${index}`} className="p-4 my-2">
              <MemoizedMarkdown key={`${messageId}-text`} id={messageId} content={contentPart.content} />
            </div>
          )
        }
        return (
          <div key={`widget-${index}`} className="animate-in slide-in-from-bottom-2 fade-in duration-300 ease-out">
            <WidgetRenderer widget={contentPart.widget} messageId={messageId} sources={sources} />
          </div>
        )
      })}
    </>
  )
})

TextPart.displayName = 'TextPart'
