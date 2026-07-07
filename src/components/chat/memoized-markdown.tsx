/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type CSSProperties, memo, useEffect, useMemo, useState } from 'react'
import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import type { PluggableList } from 'unified'
import { unified } from 'unified'

import { markdownComponents } from './markdown-utils'

// Parser mirroring react-markdown's own pipeline (remark-parse + remark-gfm) so
// the top-level block boundaries we split on match how each block will render.
// Reusing this single parser also keeps only ONE markdown tokenizer in the entry
// bundle (react-markdown already ships remark) instead of a second one.
const markdownParser = unified().use(remarkParse).use(remarkGfm)

// remark-gfm is small and used by every block, so it stays statically imported.
// remark-math + rehype-katex + the KaTeX stylesheet (~70KB gzip) are lazy-loaded
// only when a block actually contains math — see `loadMathPlugins`.

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

// One top-level block plus whether it's a `code` node. `isCode` lets the
// renderer skip math detection on fenced/indented code, so a block that merely
// *shows* `$$…$$` as source never pulls the KaTeX chunk (remark-math renders
// nothing there anyway).
type Block = { content: string; isCode: boolean }

type MarkdownNode = ReturnType<typeof markdownParser.parse>['children'][number]

// remark sets byte offsets on every node at parse time. Fail loudly if one is
// ever missing rather than fall back to 0 — a `?? 0` here would silently slice
// an empty (or wrong) block and drop message content, which is painful to debug.
const nodeOffsets = (node: MarkdownNode): { start: number; end: number } => {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start === undefined || end === undefined) {
    throw new Error(`memoized-markdown: markdown "${node.type}" node is missing position offsets`)
  }
  return { start, end }
}

// Slice each top-level mdast node back out of `source` by its position offsets,
// reproducing the exact block strings without a second markdown parser.
const sliceTopLevelBlocks = (source: string): Block[] =>
  markdownParser.parse(source).children.map((node) => {
    const { start, end } = nodeOffsets(node)
    return { content: source.slice(start, end), isCode: node.type === 'code' }
  })

const parseMarkdownIntoBlocks = (markdown: string): Block[] => {
  // Rewrite math per top-level node, skipping `code` nodes (fenced *and*
  // indented code) so a message that shows `$$…$$` as source keeps its literal
  // text. Re-parse the rewritten string so a promoted single-line `$$…$$` still
  // splits into its own display-math block. Whitespace *between* top-level nodes
  // (blank lines) is copied verbatim so the reconstructed string is byte-exact
  // apart from the math rewrites.
  //
  // Known limitation: only *top-level* code blocks are skipped here. A fenced or
  // indented code block nested inside a blockquote/list lives inside the parent
  // node's range, and `rewriteMath` still runs on it — a message that shows
  // `$$…$$`/`\(…\)` as code *inside a blockquote or list* may have that text
  // rewritten. Inline code spans (`` `…` ``) are protected at any depth via
  // `normalizeDisplayMath`. This nested-block case is rare in chat; a fully
  // code-aware pass would need deeper AST handling and is deliberately out of
  // scope here.
  const tree = markdownParser.parse(markdown)
  let normalized = ''
  let lastOffset = 0
  for (const node of tree.children) {
    const { start, end } = nodeOffsets(node)
    normalized += markdown.slice(lastOffset, start)
    normalized += node.type === 'code' ? markdown.slice(start, end) : normalizeDisplayMath(markdown.slice(start, end))
    lastOffset = end
  }
  normalized += markdown.slice(lastOffset)
  return sliceTopLevelBlocks(normalized)
}

type MathPlugins = { remark: PluggableList[number]; rehype: PluggableList[number] }

// remark-math + rehype-katex + the KaTeX stylesheet make up their own chunk,
// loaded once (module-level cached promise) and reused across every block, and
// only when a block needs math — so the ~70KB never ships in the entry for the
// many messages that render no equations. The CSS is imported here so the
// stylesheet lands in the katex chunk rather than the entry.
let mathPluginsPromise: Promise<MathPlugins> | null = null
const loadMathPlugins = (): Promise<MathPlugins> => {
  mathPluginsPromise ??= (async () => {
    try {
      const [remark, rehype] = await Promise.all([
        import('remark-math'),
        import('rehype-katex'),
        import('katex/dist/katex.min.css'),
      ])
      return { remark: remark.default, rehype: rehype.default }
    } catch (error) {
      // Don't let a flaky import (bad network, stale chunk hash after a deploy)
      // poison the cache for the whole session — clear it so a later block retries.
      mathPluginsPromise = null
      throw error
    }
  })()
  return mathPluginsPromise
}

// A block "has math" if either recognized math-span pattern matches its
// (already-normalized) content — the same spans `escapeCurrencyDollars` uses, so
// detection agrees with what remark-math would render. `.test()` on a global
// regex advances (and leaks) `lastIndex`, and `matchAll` reads that `lastIndex`
// at creation — so a leftover value would corrupt the currency-escaping spans on
// the next block. Reset both before and after probing to keep the shared regexes
// clean and detection stable.
const blockHasMath = (content: string): boolean => {
  displayMathSpan.lastIndex = 0
  inlineMathSpan.lastIndex = 0
  const hasMath = displayMathSpan.test(content) || inlineMathSpan.test(content)
  displayMathSpan.lastIndex = 0
  inlineMathSpan.lastIndex = 0
  return hasMath
}

// Lazy-load the math plugins when a block needs them. Until they resolve the
// block renders without math (a brief FOUC of raw `$…$`, then a re-render into
// KaTeX). The cancelled flag guards against a setState after unmount.
const useMathPlugins = (enabled: boolean): MathPlugins | null => {
  const [plugins, setPlugins] = useState<MathPlugins | null>(null)
  useEffect(() => {
    if (!enabled || plugins) {
      return
    }
    let cancelled = false
    const load = async () => {
      try {
        const loaded = await loadMathPlugins()
        if (!cancelled) {
          setPlugins(loaded)
        }
      } catch (error) {
        // `loadMathPlugins` already cleared its cached promise, so a freshly
        // mounted block retries the import. Log rather than retry in place: this
        // block has no back-off, and re-running on every render would busy-loop
        // against a persistently failing chunk. The block renders raw `$…$`.
        console.error('memoized-markdown: failed to load KaTeX math plugins', error)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [enabled, plugins])
  return enabled ? plugins : null
}

const MemoizedMarkdownBlock = memo(
  ({ content, isCode, components }: { content: string; isCode: boolean; components: Components }) => {
    const hasMath = useMemo(() => !isCode && blockHasMath(content), [content, isCode])
    const mathPlugins = useMathPlugins(hasMath)
    const remarkPlugins: PluggableList = mathPlugins ? [remarkGfm, mathPlugins.remark] : [remarkGfm]
    const rehypePlugins: PluggableList = mathPlugins ? [mathPlugins.rehype] : []
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
        <MemoizedMarkdownBlock
          content={block.content}
          isCode={block.isCode}
          components={resolvedComponents}
          key={`${id}-block_${index}`}
        />
      ))}
    </div>
  )
})

MemoizedMarkdown.displayName = 'MemoizedMarkdown'
