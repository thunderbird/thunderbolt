import { parseContentParts } from '@/ai/widget-parser'
import { decodeCitationSources } from '@/lib/citation-utils'
import { type TextUIPart } from 'ai'
import { memo, useMemo } from 'react'
import type { CitationMap } from './markdown-utils'
import { MemoizedMarkdown } from './memoized-markdown'
import { WidgetRenderer } from './widget-renderer'

type TextPartProps = {
  part: TextUIPart
  messageId: string
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

  for (const part of contentParts) {
    if (part.type === 'text') {
      if (fullText.length > 0 && !fullText.endsWith('\n\n')) {
        fullText += '\n\n'
      }
      fullText += part.content
    } else if (part.type === 'widget' && part.widget.widget === 'citation') {
      const sources = decodeCitationSources(part.widget.args.sources)
      if (sources) {
        fullText = fullText.trimEnd() + ` {{CITE:${citations.size}}}`
        citations.set(citations.size, sources)
      }
    }
  }

  return { fullText, citations }
}

export const TextPart = memo(({ part, messageId }: TextPartProps) => {
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
  }, [part.text])

  if (!part.text) return null

  // Citations are rendered inline within the markdown text via {{CITE:N}} placeholders
  if (hasCitations && hasText) {
    return (
      <div className="p-4 rounded-md my-2">
        <MemoizedMarkdown key={`${messageId}-text`} id={messageId} content={fullText} citations={citations} />
      </div>
    )
  }

  // Default behavior for block-level widgets or no citations
  return (
    <>
      {contentParts.map((contentPart, index) => {
        if (contentPart.type === 'text') {
          return (
            <div key={`text-${index}`} className="p-4 rounded-md my-2">
              <MemoizedMarkdown key={`${messageId}-text`} id={messageId} content={contentPart.content} />
            </div>
          )
        }
        return (
          <div key={`widget-${index}`} className="animate-in slide-in-from-bottom-2 fade-in duration-300 ease-out">
            <WidgetRenderer widget={contentPart.widget} messageId={messageId} />
          </div>
        )
      })}
    </>
  )
})

TextPart.displayName = 'TextPart'
