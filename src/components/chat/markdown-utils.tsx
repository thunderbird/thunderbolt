import { Fragment, memo, type ReactNode } from 'react'
import type { Components } from 'react-markdown'

import { CitationBadge } from '@/components/chat/citation-badge'
import { isSafeUrl } from '@/lib/url-utils'
import type { CitationSource } from '@/types/citation'

/**
 * Map of citation placeholder indices to their decoded sources.
 * Used to replace {{CITE:N}} placeholders with inline CitationBadge components.
 */
export type CitationMap = Map<number, CitationSource[]>

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

/**
 * Memoized components for citation-enabled markdown rendering.
 * These are created once and reused across renders to prevent unnecessary re-renders.
 */
const MemoizedParagraphWithCitations = memo(
  ({ children, citations }: { children: ReactNode; citations: CitationMap }) => (
    <p>{processChildren(children, citations)}</p>
  ),
)
MemoizedParagraphWithCitations.displayName = 'MemoizedParagraphWithCitations'

const MemoizedTableDataWithCitations = memo(
  ({ children, citations }: { children: ReactNode; citations: CitationMap }) => (
    <td>{processChildren(children, citations)}</td>
  ),
)
MemoizedTableDataWithCitations.displayName = 'MemoizedTableDataWithCitations'

const MemoizedTableHeaderWithCitations = memo(
  ({ children, citations }: { children: ReactNode; citations: CitationMap }) => (
    <th>{processChildren(children, citations)}</th>
  ),
)
MemoizedTableHeaderWithCitations.displayName = 'MemoizedTableHeaderWithCitations'

const MemoizedListItemWithCitations = memo(
  ({ children, citations }: { children: ReactNode; citations: CitationMap }) => (
    <li>{processChildren(children, citations)}</li>
  ),
)
MemoizedListItemWithCitations.displayName = 'MemoizedListItemWithCitations'

/**
 * Creates markdown components that replace {{CITE:N}} placeholders with CitationBadge
 * components inline, in addition to the standard <br> tag handling.
 * Wrapper components are memoized to prevent unnecessary re-renders during streaming.
 * The citations Map is passed as a prop to inner memoized components for stability.
 */
export const createMarkdownComponents = (citations: CitationMap): Components => {
  // Create memoized wrapper functions that pass citations as props to inner memoized components
  // This two-level memoization ensures stable component references while allowing citation updates
  const ParagraphWrapper = memo(({ children }: { children?: ReactNode }) => (
    <MemoizedParagraphWithCitations citations={citations}>{children}</MemoizedParagraphWithCitations>
  ))
  ParagraphWrapper.displayName = 'ParagraphWrapper'

  const TableDataWrapper = memo(({ children }: { children?: ReactNode }) => (
    <MemoizedTableDataWithCitations citations={citations}>{children}</MemoizedTableDataWithCitations>
  ))
  TableDataWrapper.displayName = 'TableDataWrapper'

  const TableHeaderWrapper = memo(({ children }: { children?: ReactNode }) => (
    <MemoizedTableHeaderWithCitations citations={citations}>{children}</MemoizedTableHeaderWithCitations>
  ))
  TableHeaderWrapper.displayName = 'TableHeaderWrapper'

  const ListItemWrapper = memo(({ children }: { children?: ReactNode }) => (
    <MemoizedListItemWithCitations citations={citations}>{children}</MemoizedListItemWithCitations>
  ))
  ListItemWrapper.displayName = 'ListItemWrapper'

  return {
    a: SafeLink,
    p: ParagraphWrapper,
    td: TableDataWrapper,
    th: TableHeaderWrapper,
    li: ListItemWrapper,
  }
}
