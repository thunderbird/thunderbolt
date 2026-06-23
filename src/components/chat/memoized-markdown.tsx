/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { marked } from 'marked'
import { type CSSProperties, memo, useMemo } from 'react'
import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

import { markdownComponents } from './markdown-utils'

// KaTeX styles for LaTeX math rendered by remark-math + rehype-katex. Imported
// here so the stylesheet ships with the markdown renderer (chat critical path).
import 'katex/dist/katex.min.css'

// remark-math parses `$…$` / `$$…$$` into math nodes; rehype-katex renders them
// to KaTeX HTML. Shared across every markdown block so inline and display math
// render consistently. GFM stays first so its tokenizer runs before math.
const remarkPlugins = [remarkGfm, remarkMath]
const rehypePlugins = [rehypeKatex]

// Models often emit LaTeX's native delimiters — `\[…\]` for display, `\(…\)`
// for inline — instead of the `$$…$$` / `$…$` that remark-math understands.
// Rewrite the paired delimiters into their `$`-equivalents so math renders no
// matter which convention the model picked. Matching *paired* delimiters (not a
// lone `\[`/`\(`) avoids clobbering markdown-escaped brackets/parens, and the
// display pattern spans lines so multi-line equations survive.
const displayMathDelimiters = /\\\[([\s\S]+?)\\\]/g
const inlineMathDelimiters = /\\\((.+?)\\\)/g

// remark-math only renders `$$…$$` as centered *display* math when the fences
// sit on their own lines; a single-line `$$…$$` falls back to inline. Models
// routinely emit standalone equations on a single line, so rewrite any line
// that is wholly a `$$…$$` equation into the fenced form.
// Inline `$…$` and mid-sentence `$$…$$` are left untouched (the `$` anchors and
// single-line `.` keep the match to a whole line), and already-fenced blocks
// don't match (their `$$` fences are alone on their lines).
const displayMathLine = /^([ \t]*)\$\$[ \t]*(.+?)[ \t]*\$\$[ \t]*$/gm

// Rewrite the math delimiters in a span of prose. Never called on code — see
// `normalizeDisplayMath` (skips inline code spans) and `parseMarkdownIntoBlocks`
// (skips fenced/indented code blocks).
const rewriteMath = (text: string): string =>
  text
    .replace(displayMathDelimiters, (_match, body: string) => `$$\n${body.trim()}\n$$`)
    .replace(inlineMathDelimiters, (_match, body: string) => `$${body.trim()}$`)
    .replace(displayMathLine, (_match, indent: string, body: string) => `${indent}$$\n${body}\n$$`)

// An inline code span (`` `…` ``, `` ``…`` ``, …). Left verbatim so a message
// that shows `$$…$$` / `\(…\)` *as inline code* keeps its literal text.
const inlineCodeSpan = /(`+)[^`]*?\1/g

// Rewrite math everywhere except inside inline code spans.
const normalizeDisplayMath = (markdown: string): string => {
  let result = ''
  let lastIndex = 0
  for (const match of markdown.matchAll(inlineCodeSpan)) {
    result += rewriteMath(markdown.slice(lastIndex, match.index)) + match[0]
    lastIndex = match.index + match[0].length
  }
  return result + rewriteMath(markdown.slice(lastIndex))
}

const parseMarkdownIntoBlocks = (markdown: string): string[] => {
  // Rewrite math per top-level token, skipping `code` tokens (fenced *and*
  // indented code) so a message that shows `$$…$$` as source keeps its literal
  // text. Re-lex the rewritten string so a promoted single-line `$$…$$` still
  // splits into its own display-math block.
  const normalized = marked
    .lexer(markdown)
    .map((token) => (token.type === 'code' ? token.raw : normalizeDisplayMath(token.raw)))
    .join('')
  return marked.lexer(normalized).map((token) => token.raw)
}

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
  const blocks = useMemo(() => parseMarkdownIntoBlocks(content), [content])
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
