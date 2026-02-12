import { createContext, Fragment, memo, useContext, type ReactNode } from 'react'
import type { Components } from 'react-markdown'

import { CitationBadge } from '@/components/chat/citation-badge'
import { isSafeUrl } from '@/lib/url-utils'
import type { CitationMap } from '@/types/citation'

// Re-export for consumers that import CitationMap from here
export type { CitationMap }

/**
 * Context for passing citation data to markdown components without creating
 * new component types on each render. Components read from this context
 * to render inline CitationBadge elements.
 */
export const CitationContext = createContext<CitationMap | undefined>(undefined)

/**
 * Regex to split on <br> tags (case-insensitive, global)
 */
const brSplitRegex = /<br\s*\/?>/gi

/**
 * Regex to split on citation placeholders like {{CITE:0}}, {{CITE:1}}, etc.
 * The capturing group extracts the citation index number.
 */
const citationPlaceholderRegex = /\{\{CITE:(\d+)\}\}/

/**
 * Processes text content to convert <br> tags into actual React <br /> elements.
 * Models use <br> for line breaks in table cells and lists where Markdown doesn't support native breaks.
 */
const processTextContent = (children: ReactNode): ReactNode => {
  if (typeof children === 'string') {
    const parts = children.split(brSplitRegex)
    if (parts.length === 1) return children

    return parts.map((part, i) => (
      <Fragment key={i}>
        {part}
        {i < parts.length - 1 && <br />}
      </Fragment>
    ))
  }

  if (Array.isArray(children)) {
    let hasChanges = false
    const processed = children.flatMap((child, i) => {
      if (typeof child === 'string') {
        const parts = child.split(brSplitRegex)
        if (parts.length > 1) {
          hasChanges = true
          return parts.map((part, j) => (
            <Fragment key={`${i}-${j}`}>
              {part}
              {j < parts.length - 1 && <br />}
            </Fragment>
          ))
        }
      }
      return child
    })

    return hasChanges ? processed : children
  }

  return children
}

/**
 * Replaces {{CITE:N}} placeholders in text children with inline CitationBadge components.
 * String.split with a capturing group produces alternating [text, index, text, index, ...].
 */
const processCitationPlaceholders = (children: ReactNode, citations: CitationMap): ReactNode => {
  if (typeof children === 'string') {
    const parts = children.split(citationPlaceholderRegex)
    if (parts.length === 1) return children

    return parts
      .map((part, i) => {
        if (i % 2 === 1) {
          const citationId = parseInt(part, 10)
          const sources = citations.get(citationId)
          return sources ? <CitationBadge key={`cite-${part}`} sources={sources} citationId={citationId} /> : null
        }
        return part || null
      })
      .filter(Boolean)
  }

  if (Array.isArray(children)) {
    let hasChanges = false
    const processed = children.flatMap((child, i) => {
      if (typeof child === 'string') {
        const parts = child.split(citationPlaceholderRegex)
        if (parts.length > 1) {
          hasChanges = true
          return parts
            .map((part, j) => {
              if (j % 2 === 1) {
                const citationId = parseInt(part, 10)
                const sources = citations.get(citationId)
                return sources ? (
                  <CitationBadge key={`cite-${i}-${part}`} sources={sources} citationId={citationId} />
                ) : null
              }
              return part || null
            })
            .filter(Boolean)
        }
      }
      return [child]
    })
    return hasChanges ? processed : children
  }

  return children
}

/**
 * Processes children through citation replacement (if citations exist) then <br> handling.
 * Citation placeholders are processed first so <br> processing can handle the resulting array.
 */
const processChildren = (children: ReactNode, citations?: CitationMap): ReactNode => {
  const afterCitations = citations ? processCitationPlaceholders(children, citations) : children
  return processTextContent(afterCitations)
}

/**
 * Custom ReactMarkdown component overrides that handle <br> tags in rendered output.
 * Ensures line breaks work correctly in tables, lists, and paragraphs.
 * All components are memoized to prevent unnecessary re-renders during streaming.
 */
const SafeLink = memo(({ href, children, ...props }: React.ComponentProps<'a'>) => {
  const safeHref = href && isSafeUrl(href) ? href : undefined
  return (
    <a {...props} href={safeHref} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
})

SafeLink.displayName = 'SafeLink'

const MemoizedParagraph = memo(({ children }: { children?: ReactNode }) => <p>{processTextContent(children)}</p>)
MemoizedParagraph.displayName = 'MemoizedParagraph'

const MemoizedTableData = memo(({ children }: { children?: ReactNode }) => <td>{processTextContent(children)}</td>)
MemoizedTableData.displayName = 'MemoizedTableData'

const MemoizedTableHeader = memo(({ children }: { children?: ReactNode }) => <th>{processTextContent(children)}</th>)
MemoizedTableHeader.displayName = 'MemoizedTableHeader'

const MemoizedListItem = memo(({ children }: { children?: ReactNode }) => <li>{processTextContent(children)}</li>)
MemoizedListItem.displayName = 'MemoizedListItem'

export const markdownComponents: Components = {
  a: SafeLink,
  p: MemoizedParagraph,
  td: MemoizedTableData,
  th: MemoizedTableHeader,
  li: MemoizedListItem,
}

// --- Citation-aware components (read from CitationContext) ---

const CitationParagraph = memo(({ children }: { children?: ReactNode }) => {
  const citations = useContext(CitationContext)
  return <p>{citations ? processChildren(children, citations) : processTextContent(children)}</p>
})
CitationParagraph.displayName = 'CitationParagraph'

const CitationTableData = memo(({ children }: { children?: ReactNode }) => {
  const citations = useContext(CitationContext)
  return <td>{citations ? processChildren(children, citations) : processTextContent(children)}</td>
})
CitationTableData.displayName = 'CitationTableData'

const CitationTableHeader = memo(({ children }: { children?: ReactNode }) => {
  const citations = useContext(CitationContext)
  return <th>{citations ? processChildren(children, citations) : processTextContent(children)}</th>
})
CitationTableHeader.displayName = 'CitationTableHeader'

const CitationListItem = memo(({ children }: { children?: ReactNode }) => {
  const citations = useContext(CitationContext)
  return <li>{citations ? processChildren(children, citations) : processTextContent(children)}</li>
})
CitationListItem.displayName = 'CitationListItem'

/**
 * Stable markdown component overrides for citation-enabled rendering.
 * These are module-level constants — React never unmounts/remounts them.
 * Citation data flows through CitationContext, which correctly triggers
 * re-renders only when citations change.
 */
export const citationMarkdownComponents: Components = {
  a: SafeLink,
  p: CitationParagraph,
  td: CitationTableData,
  th: CitationTableHeader,
  li: CitationListItem,
}
