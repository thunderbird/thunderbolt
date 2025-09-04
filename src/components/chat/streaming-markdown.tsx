import { useEffect, useRef, type CSSProperties } from 'react'
import * as smd from 'streaming-markdown'

interface StreamingMarkdownProps {
  content: string
  isStreaming?: boolean
  className?: string
}

export function StreamingMarkdown({ content, isStreaming = false, className = '' }: StreamingMarkdownProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const parserRef = useRef<any>(null)
  const lastContentRef = useRef('')

  useEffect(() => {
    if (!containerRef.current) return

    // Initialize parser if not already done
    if (!parserRef.current) {
      const renderer = smd.default_renderer(containerRef.current)
      parserRef.current = smd.parser(renderer)
    }

    // Get the new content that needs to be streamed
    const newContent = content.slice(lastContentRef.current.length)

    if (newContent) {
      // Stream the new content
      smd.parser_write(parserRef.current, newContent)
      lastContentRef.current = content
    }

    // If streaming is complete, end the parser
    if (!isStreaming && content && lastContentRef.current === content) {
      smd.parser_end(parserRef.current)
    }
  }, [content, isStreaming])

  // Reset parser when content changes completely (new message)
  useEffect(() => {
    if (containerRef.current && content.length < lastContentRef.current.length) {
      // Clear container
      containerRef.current.innerHTML = ''

      // Reset parser
      if (parserRef.current) {
        smd.parser_end(parserRef.current)
      }

      const renderer = smd.default_renderer(containerRef.current)
      parserRef.current = smd.parser(renderer)
      lastContentRef.current = ''

      // Stream the new content
      if (content) {
        smd.parser_write(parserRef.current, content)
        lastContentRef.current = content
      }
    }
  }, [content])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (parserRef.current) {
        smd.parser_end(parserRef.current)
      }
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className={`prose prose-sm max-w-none dark:prose-invert ${className}`}
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
        } as CSSProperties
      }
    />
  )
}
