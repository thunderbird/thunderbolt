import { Fragment, type ReactNode } from 'react'
import type { Components } from 'react-markdown'

/**
 * Regex to split on <br> tags (case-insensitive, global)
 */
const BR_SPLIT_REGEX = /<br\s*\/?>/gi

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
 * Custom ReactMarkdown component overrides that handle <br> tags in rendered output.
 * Ensures line breaks work correctly in tables, lists, and paragraphs.
 */
export const markdownComponents: Components = {
  p: ({ children }) => <p>{processTextContent(children)}</p>,
  td: ({ children }) => <td>{processTextContent(children)}</td>,
  th: ({ children }) => <th>{processTextContent(children)}</th>,
  li: ({ children }) => <li>{processTextContent(children)}</li>,
}
