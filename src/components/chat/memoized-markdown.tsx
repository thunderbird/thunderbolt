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
// (The system prompt in `src/ai/prompt.ts` asks for `$`-delimiters only, but
// models drift, so this defensive normalization stays — the two are
// complementary, not redundant.)
// Rewrite the paired delimiters into their `$`-equivalents so math renders no
// matter which convention the model picked. Matching *paired* delimiters (not a
// lone `\[`/`\(`) avoids clobbering markdown-escaped brackets/parens, and the
// display pattern spans lines so multi-line equations survive. The optional
// leading-indent capture preserves a list-indented `\[…\]` (see `indentedFence`;
// blockquote `>` prefixes are a documented limitation there).
const displayMathDelimiters = /(^[ \t]*)?\\\[([\s\S]+?)\\\]/gm
// `[\s\S]+?` (not `.+?`) so a `\(…\)` split across lines is still converted,
// matching the display pattern. Lazy, so it stops at the first `\)`.
const inlineMathDelimiters = /\\\(([\s\S]+?)\\\)/g

// remark-math only renders `$$…$$` as centered *display* math when the fences
// sit on their own lines; a single-line `$$…$$` falls back to inline. Models
// routinely emit standalone equations on a single line, so rewrite any line
// that is wholly a `$$…$$` equation into the fenced form.
// Inline `$…$` and mid-sentence `$$…$$` are left untouched (the `$` anchors and
// single-line `.` keep the match to a whole line), and already-fenced blocks
// don't match (their `$$` fences are alone on their lines).
const displayMathLine = /^([ \t]*)\$\$[ \t]*(.+?)[ \t]*\$\$[ \t]*$/gm

// Build a fenced `$$ … $$` display block, prefixing every line with `indent`
// (leading whitespace only) so a promoted equation keeps its list-continuation
// indentation instead of dedenting onto column 0 — which would end the enclosing
// list item early and break the surrounding bullets (the fences land outside it).
//
// Known limitation: only whitespace indentation is preserved. A blockquote keeps
// a `>` prefix on each line (not whitespace), so display math written *inside* a
// blockquote isn't promoted/converted — the line-anchored patterns don't match
// the `>`. Same container-context class as the nested-code note in
// `parseMarkdownIntoBlocks`; rare in chat, and a fully container-safe fix would
// mean moving delimiter handling to a remark AST plugin. Inline `\(…\)` still
// works in blockquotes (it isn't line-anchored).
const indentedFence = (indent: string, body: string): string => {
  const inner = body
    .trim()
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n')
  return `${indent}$$\n${inner}\n${indent}$$`
}

// Recognize math spans with the pandoc/KaTeX delimiter rules so currency dollars
// aren't mistaken for math. Display `$$…$$` is taken verbatim. An inline `$…$`
// span needs a non-space, non-`$` immediately after the opening `$`, and a
// non-space before the closing `$` that is NOT followed by a digit — so
// "$6.674 \times 10^{-11}$" pairs as math, while "$5 and $10" does not (its
// candidate close sits after a space and before a digit).
const displayMathSpan = /\$\$[\s\S]*?\$\$/g
const inlineMathSpan = /\$(?![\s$])[^$\n]*?(?<!\s)\$(?!\d)/g

// Escape each `$` that precedes a digit *unless* it sits inside a recognized math
// span — neutralizing currency ("$5", "$10 total") so remark-math renders it as a
// literal dollar, while leaving digit-leading inline math ("$3.14$") to render.
const escapeCurrencyDollars = (text: string): string => {
  const spans: Array<[number, number]> = []
  for (const regex of [displayMathSpan, inlineMathSpan]) {
    for (const match of text.matchAll(regex)) {
      spans.push([match.index, match.index + match[0].length])
    }
  }
  const insideMath = (index: number): boolean => spans.some(([start, end]) => index >= start && index < end)
  return text.replace(/\$(?=\d)/g, (dollar, index: number) => (insideMath(index) ? dollar : '\\$'))
}

// Rewrite the math delimiters in a span of prose. Never called on code — see
// `normalizeDisplayMath` (skips inline code spans) and `parseMarkdownIntoBlocks`
// (skips fenced/indented code blocks).
//
// Scope note: the `\(…\)` → `$…$` pass runs across the whole span, so a `\(…\)`
// nested *inside* display math (`\[…\]` / `$$…$$`) is also rewritten. That input
// is malformed LaTeX to begin with (math modes don't nest), so we don't
// special-case it — only already-invalid equations are affected, never
// well-formed ones.
const rewriteMath = (text: string): string =>
  // Currency escaping runs last, on the fully-normalized text, so it sees every
  // `$$…$$` / `$…$` span — including those just converted from `\[…\]` / `\(…\)`.
  escapeCurrencyDollars(
    text
      // Leave an empty `\[ \]` as-is rather than emit an empty `$$…$$` block.
      .replace(displayMathDelimiters, (match, indent: string | undefined, body: string) =>
        body.trim() ? indentedFence(indent ?? '', body) : match,
      )
      // Inline math is single-line by nature, so collapse internal whitespace
      // (including the newline a multi-line `\(…\)` carried) to a single space.
      // An empty `\( \)` is left untouched: converting it would yield a bare
      // `$$`, which remark-math reads as a display-fence opener and could swallow
      // the following prose.
      .replace(inlineMathDelimiters, (match, body: string) => {
        const inner = body.trim().replace(/\s+/g, ' ')
        return inner ? `$${inner}$` : match
      })
      .replace(displayMathLine, (_match, indent: string, body: string) => indentedFence(indent, body)),
  )

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
  //
  // Known limitation: only *top-level* code blocks are skipped here. A fenced or
  // indented code block nested inside a blockquote/list lives in the parent
  // token's `raw` (marked strips its container prefixes, so it can't be matched
  // back to the source), and `rewriteMath` still runs on it — a message that
  // shows `$$…$$`/`\(…\)` as code *inside a blockquote or list* may have that
  // text rewritten. Inline code spans (`` `…` ``) are protected at any depth via
  // `normalizeDisplayMath`. This nested-block case is rare in chat; a fully
  // code-aware pass would need AST-level handling and is deliberately out of
  // scope here.
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
