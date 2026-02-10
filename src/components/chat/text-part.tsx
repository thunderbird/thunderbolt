import { parseContentParts } from '@/ai/widget-parser'
import { decodeCitationSources } from '@/lib/citation-utils'
import { type TextUIPart } from 'ai'
import { memo, useRef, useMemo } from 'react'
import type { Components } from 'react-markdown'
import { CitationPopoverProvider } from './citation-popover'
import { type CitationMap, createMarkdownComponents } from './markdown-utils'
import { MemoizedMarkdown } from './memoized-markdown'
import { WidgetRenderer } from './widget-renderer'

type TextPartProps = {
  part: TextUIPart
  messageId: string
}

/**
 * Text fragments that should be appended directly without a paragraph break:
 * - Punctuation/connectors between adjacent citations (e.g., ",", ".", ", and")
 * - Table row continuations that start with | (internal \n is preserved by the parser)
 */
const shouldAppendInline = (text: string): boolean =>
  /^[,;.·\s]*(and|or|,|;|\.)*\s*$/i.test(text) || text.trimStart().startsWith('|')

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

  // Stabilize the components reference so completed markdown blocks stay memoized
  // during streaming. Only recreate when citation count changes (a new citation was parsed),
  // not on every text chunk.
  const citationCountRef = useRef(0)
  const componentsRef = useRef<Components | undefined>(undefined)
  if (citations.size !== citationCountRef.current) {
    citationCountRef.current = citations.size
    componentsRef.current = citations.size > 0 ? createMarkdownComponents(citations) : undefined
  }

  if (!part.text) return null

  if (hasCitations && hasText) {
    return (
      <div className="p-4 rounded-md my-2">
        <CitationPopoverProvider>
          <MemoizedMarkdown
            key={`${messageId}-text`}
            id={messageId}
            content={fullText}
            components={componentsRef.current}
          />
        </CitationPopoverProvider>
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
