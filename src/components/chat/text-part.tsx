import { type ContentPart, parseContentParts } from '@/ai/widget-parser'
import { decodeCitationSources } from '@/lib/citation-utils'
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
 * Text fragments that should be appended directly without a paragraph break:
 * - Punctuation/connectors between adjacent citations (e.g., ",", ".", ", and")
 * - Table row continuations that start with | (internal \n is preserved by the parser)
 */
const shouldAppendInline = (text: string): boolean =>
  /^[,;.·\s]*(and|or|,|;|\.)*\s*$/i.test(text) || text.trimStart().startsWith('|')

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
    if (part.type !== 'widget' || part.widget.widget !== 'link-preview') return true
    const url = normalizeUrl((part.widget.args as { url: string }).url)
    if (seen.has(url)) return false
    seen.add(url)
    return true
  })
}

/**
 * Detects `[N]` citation patterns in text and builds a CitationMap from SourceMetadata[].
 * Each `[N]` where `N-1` is a valid index into `sources` becomes a `{{CITE:mapKey}}` placeholder.
 * Out-of-range references are left as-is in the text.
 * @returns fullText with placeholders, and the corresponding CitationMap
 */
export const buildSourceCitationPlaceholders = (
  text: string,
  sources: SourceMetadata[],
): { fullText: string; citations: CitationMap } => {
  const citations: CitationMap = new Map()
  let nextKey = 0

  const fullText = text.replace(groupedCitationRegex, (match) => {
    const validSources: CitationSource[] = []
    for (const m of match.matchAll(individualCitationRegex)) {
      const n = parseInt(m[1], 10)
      const source = sources[n - 1]
      if (source) validSources.push(sourceToCitation(source, validSources.length === 0))
    }

    if (validSources.length === 0) return match

    const key = nextKey++
    citations.set(key, validSources)
    return `{{CITE:${key}}}`
  })

  return { fullText, citations }
}

/**
 * Builds a single markdown string with {{CITE:N}} placeholders at the positions
 * where the AI placed citation widgets, and returns the citation data map.
 */
const buildTextWithCitationPlaceholders = (
  contentParts: ReturnType<typeof parseContentParts>,
): { fullText: string; citations: CitationMap } => {
  let fullText = ''
  const citations: CitationMap = new Map()
  const parts = [...contentParts]

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part.type === 'text') {
      if (fullText.length === 0 || shouldAppendInline(part.content)) {
        fullText += part.content
      } else if (!fullText.endsWith('\n\n')) {
        fullText += '\n\n' + part.content
      } else {
        fullText += part.content
      }
    } else if (part.type === 'widget' && part.widget.widget === 'citation') {
      const sources = decodeCitationSources(part.widget.args.sources)
      if (sources) {
        // Consume a leading period from the next text part so the citation
        // renders after the sentence end: "sentence. [Source]"
        const next = parts[i + 1]
        if (next?.type === 'text' && next.content.startsWith('.')) {
          fullText = fullText.trimEnd() + '.'
          parts[i + 1] = { ...next, content: next.content.slice(1) }
        }
        fullText = fullText.trimEnd() + ` {{CITE:${citations.size}}}`
        citations.set(citations.size, sources)
      }
    }
  }

  return { fullText, citations }
}

export const TextPart = memo(({ part, messageId, sources }: TextPartProps) => {
  const hasNewSources = !!sources && sources.length > 0

  // Build citation data upfront so the hook is always called in the same order
  const { contentParts, fullText, citations, hasCitations, hasText } = useMemo(() => {
    if (!part.text) {
      return {
        contentParts: [],
        fullText: '',
        citations: new Map() as CitationMap,
        hasCitations: false,
        hasText: false,
      }
    }

    const parts = parseContentParts(part.text)

    // Path A: new [N] format — sources metadata exists
    if (hasNewSources) {
      const textContent = parts
        .filter((p) => p.type === 'text')
        .map((p) => p.content)
        .join('\n\n')

      const result = buildSourceCitationPlaceholders(textContent, sources)
      const hasCit = result.citations.size > 0
      return { contentParts: parts, ...result, hasCitations: hasCit, hasText: textContent.length > 0 }
    }

    // Path B: old <widget:citation> format (backward compat)
    const hasCit = parts.some((p) => p.type === 'widget' && p.widget.widget === 'citation')
    const hasTxt = parts.some((p) => p.type === 'text')

    if (hasCit && hasTxt) {
      const result = buildTextWithCitationPlaceholders(parts)
      return { contentParts: parts, ...result, hasCitations: true, hasText: true }
    }

    return {
      contentParts: parts,
      fullText: '',
      citations: new Map() as CitationMap,
      hasCitations: hasCit,
      hasText: hasTxt,
    }
  }, [part.text, hasNewSources, sources])

  if (!part.text) return null

  if (hasCitations && hasText) {
    return (
      <div className="p-4 rounded-md my-2">
        <CitationPopoverProvider>
          <CitationContext.Provider value={citations}>
            <MemoizedMarkdown
              key={`${messageId}-text`}
              id={messageId}
              content={fullText}
              components={citationMarkdownComponents}
            />
          </CitationContext.Provider>
        </CitationPopoverProvider>
      </div>
    )
  }

  // Default behavior for block-level widgets or no citations
  return (
    <>
      {deduplicateLinkPreviews(contentParts).map((contentPart, index) => {
        if (contentPart.type === 'text') {
          return (
            <div key={`text-${index}`} className="p-4 rounded-md my-2">
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
