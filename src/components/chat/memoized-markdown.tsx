/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type CSSProperties, memo, useMemo, useRef } from 'react'
import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

import { type IncrementalMarkdownState, parseMarkdownIntoBlocksIncremental } from './markdown-blocks'
import { markdownComponents } from './markdown-utils'

// KaTeX styles for LaTeX math rendered by remark-math + rehype-katex. Imported
// here so the stylesheet ships with the markdown renderer (chat critical path).
import 'katex/dist/katex.min.css'

// remark-math parses `$…$` / `$$…$$` into math nodes; rehype-katex renders them
// to KaTeX HTML. Shared across every markdown block so inline and display math
// render consistently. GFM stays first so its tokenizer runs before math.
const remarkPlugins = [remarkGfm, remarkMath]
const rehypePlugins = [rehypeKatex]

const MemoizedMarkdownBlock = memo(
  ({ content, components }: { content: string; components: Components }) => {
    return (
      <div className="overflow-x-scroll">
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
          {content}
        </ReactMarkdown>
      </div>
    )
  },
  (prevProps, nextProps) => prevProps.content === nextProps.content && prevProps.components === nextProps.components,
)

MemoizedMarkdownBlock.displayName = 'MemoizedMarkdownBlock'

type MemoizedMarkdownProps = {
  content: string
  id: string
  components?: Components
}

export const MemoizedMarkdown = memo(({ content, id, components }: MemoizedMarkdownProps) => {
  // Thread incremental parse state across renders so a streamed message re-lexes
  // only its last block + appended tail instead of the whole growing content.
  const parseStateRef = useRef<IncrementalMarkdownState | null>(null)
  const blocks = useMemo(() => {
    const { blocks, state } = parseMarkdownIntoBlocksIncremental(content, parseStateRef.current)
    // Render-phase ref write, safe by construction: parse state is a pure function
    // of `content`. StrictMode double-invocation and concurrent renders that never
    // commit therefore produce equally valid state. Worst case a discarded/stale
    // state isn't a clean prefix of the next content, so `parseMarkdownIntoBlocksIncremental`
    // just falls back to one full re-parse — never wrong output, only a one-render cost.
    parseStateRef.current = state
    return blocks
  }, [content])
  const resolvedComponents = components ?? markdownComponents

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
        <MemoizedMarkdownBlock content={block} components={resolvedComponents} key={`${id}-block_${index}`} />
      ))}
    </div>
  )
})

MemoizedMarkdown.displayName = 'MemoizedMarkdown'
