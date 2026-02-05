import { Fragment, type ReactNode } from 'react'
import type { Components } from 'react-markdown'

import { CitationBadge } from '@/components/chat/citation-badge'
import type { CitationSource } from '@/types/citation'

/**
 * Map of citation placeholder indices to their decoded sources.
 * Used to replace {{CITE:N}} placeholders with inline CitationBadge components.
 */
export type CitationMap = Map<number, CitationSource[]>

/**
 * Regex to split on <br> tags (case-insensitive, global)
 */
const BR_SPLIT_REGEX = /<br\s*\/?>/gi

/**
 * Regex to split on citation placeholders like {{CITE:0}}, {{CITE:1}}, etc.
 * The capturing group extracts the citation index number.
 */
const CITATION_PLACEHOLDER_REGEX = /\{\{CITE:(\d+)\}\}/g

/**
 * Processes text content to convert <br> tags into actual React <br /> elements.
 * Models use <br> for line breaks in table cells and lists where Markdown doesn't support native breaks.
 */
const processTextContent = (children: ReactNode): ReactNode => {
  if (typeof children === 'string') {
    const parts = children.split(BR_SPLIT_REGEX)
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
        const parts = child.split(BR_SPLIT_REGEX)
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
    const parts = children.split(CITATION_PLACEHOLDER_REGEX)
    if (parts.length === 1) return children

    return parts
      .map((part, i) => {
        if (i % 2 === 1) {
          const sources = citations.get(parseInt(part, 10))
          return sources ? <CitationBadge key={`cite-${part}`} sources={sources} /> : null
        }
        return part || null
      })
      .filter(Boolean)
  }

  if (Array.isArray(children)) {
    let hasChanges = false
    const processed = children.flatMap((child, i) => {
      if (typeof child === 'string') {
        const parts = child.split(CITATION_PLACEHOLDER_REGEX)
        if (parts.length > 1) {
          hasChanges = true
          return parts
            .map((part, j) => {
              if (j % 2 === 1) {
                const sources = citations.get(parseInt(part, 10))
                return sources ? <CitationBadge key={`cite-${i}-${part}`} sources={sources} /> : null
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
 */
export const markdownComponents: Components = {
  p: ({ children }) => <p>{processTextContent(children)}</p>,
  td: ({ children }) => <td>{processTextContent(children)}</td>,
  th: ({ children }) => <th>{processTextContent(children)}</th>,
  li: ({ children }) => <li>{processTextContent(children)}</li>,
}

/**
 * Creates markdown components that replace {{CITE:N}} placeholders with CitationBadge
 * components inline, in addition to the standard <br> tag handling.
 */
export const createMarkdownComponents = (citations: CitationMap): Components => ({
  p: ({ children }) => <p>{processChildren(children, citations)}</p>,
  td: ({ children }) => <td>{processChildren(children, citations)}</td>,
  th: ({ children }) => <th>{processChildren(children, citations)}</th>,
  li: ({ children }) => <li>{processChildren(children, citations)}</li>,
})
