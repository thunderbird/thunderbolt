import { marked } from 'marked'
import { type CSSProperties, memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { markdownComponents } from './markdown-utils'

function parseMarkdownIntoBlocks(markdown: string): string[] {
  const tokens = marked.lexer(markdown)
  return tokens.map((token) => token.raw)
}

const MemoizedMarkdownBlock = memo(
  ({ content }: { content: string }) => {
    return (
      <div className="overflow-x-scroll">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {content}
        </ReactMarkdown>
      </div>
    )
  },
  (prevProps, nextProps) => {
    if (prevProps.content !== nextProps.content) return false
    return true
  },
)

MemoizedMarkdownBlock.displayName = 'MemoizedMarkdownBlock'

export const MemoizedMarkdown = memo(({ content, id }: { content: string; id: string }) => {
  const blocks = useMemo(() => parseMarkdownIntoBlocks(content), [content])

  return (
    <div
      className="prose prose-sm max-w-none dark:prose-invert"
      style={
        {
          // Override prose styles to match your design
          color: 'inherit',
          fontSize: 'inherit',
          lineHeight: 'inherit',
          // Ensure proper styling for markdown elements
          '--tw-prose-body': 'inherit',
          '--tw-prose-headings': 'inherit',
          '--tw-prose-lead': 'inherit',
          '--tw-prose-links': 'inherit',
          '--tw-prose-bold': 'inherit',
          '--tw-prose-counters': 'inherit',
          '--tw-prose-bullets': 'inherit',
          '--tw-prose-hr': 'inherit',
          '--tw-prose-quotes': 'inherit',
          '--tw-prose-quote-borders': 'inherit',
          '--tw-prose-captions': 'inherit',
          '--tw-prose-code': 'inherit',
          '--tw-prose-pre-code': 'inherit',
          '--tw-prose-pre-bg': 'inherit',
          '--tw-prose-th-borders': 'inherit',
          '--tw-prose-td-borders': 'inherit',
          '--tw-prose-invert-body': 'inherit',
          '--tw-prose-invert-headings': 'inherit',
          '--tw-prose-invert-lead': 'inherit',
          '--tw-prose-invert-links': 'inherit',
          '--tw-prose-invert-bold': 'inherit',
          '--tw-prose-invert-counters': 'inherit',
          '--tw-prose-invert-bullets': 'inherit',
          '--tw-prose-invert-hr': 'inherit',
          '--tw-prose-invert-quotes': 'inherit',
          '--tw-prose-invert-quote-borders': 'inherit',
          '--tw-prose-invert-captions': 'inherit',
          '--tw-prose-invert-code': 'inherit',
          '--tw-prose-invert-pre-code': 'inherit',
          '--tw-prose-invert-pre-bg': 'inherit',
          '--tw-prose-invert-th-borders': 'inherit',
          '--tw-prose-invert-td-borders': 'inherit',
        } as CSSProperties
      }
    >
      {blocks.map((block, index) => (
        <MemoizedMarkdownBlock content={block} key={`${id}-block_${index}`} />
      ))}
    </div>
  )
})

MemoizedMarkdown.displayName = 'MemoizedMarkdown'
