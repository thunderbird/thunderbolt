/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

// Parser mirroring react-markdown's own pipeline (remark-parse + remark-gfm) so
// the top-level block boundaries we split on match how each block will render.
// Reusing this single parser also keeps only ONE markdown tokenizer in the entry
// bundle (react-markdown already ships remark) instead of a second one.
const markdownParser = unified().use(remarkParse).use(remarkGfm)

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

/**
 * One top-level block plus whether it's a `code` node. `isCode` lets the renderer
 * skip math detection on fenced/indented code, so a block that merely *shows*
 * `$$…$$` as source never pulls the KaTeX chunk (remark-math renders nothing
 * there anyway).
 */
export type Block = { content: string; isCode: boolean }

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

// One unit of source: either a top-level mdast node (`isGap: false`) or the raw
// whitespace/blank-line gap *between* two nodes (`isGap: true`). Concatenating
// every `raw` in order reproduces the source byte-for-byte, so the segment list
// is a lossless, node-aware view we can normalize per-unit and re-split.
type Segment = { type: string; raw: string; isGap: boolean }

// Break `source` into node + gap segments. Top-level blocks are always separated
// by at least one line break, so every pair of content segments has a gap segment
// between them — the invariant `committableSegmentCount` relies on.
const parseSegments = (source: string): Segment[] => {
  const segments: Segment[] = []
  let lastOffset = 0
  for (const node of markdownParser.parse(source).children) {
    const { start, end } = nodeOffsets(node)
    if (start > lastOffset) {
      segments.push({ type: 'gap', raw: source.slice(lastOffset, start), isGap: true })
    }
    segments.push({ type: node.type, raw: source.slice(start, end), isGap: false })
    lastOffset = end
  }
  if (lastOffset < source.length) {
    segments.push({ type: 'gap', raw: source.slice(lastOffset), isGap: true })
  }
  return segments
}

// Normalize a single segment's raw text. Gap and `code` segments are left
// verbatim so a message that shows `$$…$$` / `\(…\)` as source (fenced *and*
// indented code) keeps its literal text; every other node has its math rewritten.
const normalizeSegment = (segment: Segment): string =>
  segment.isGap || segment.type === 'code' ? segment.raw : normalizeDisplayMath(segment.raw)

const normalizeMarkdown = (markdown: string): string => parseSegments(markdown).map(normalizeSegment).join('')

/**
 * Splits markdown into top-level blocks, promoting model math-delimiter drift
 * (`\[…\]`, `\(…\)`, single-line `$$…$$`) into the fenced forms remark-math
 * understands.
 *
 * Two-pass: parse into top-level nodes, rewrite math per non-code node (gaps
 * copied verbatim), then re-parse the rewritten string so a promoted single-line
 * `$$…$$` still splits into its own display-math block.
 *
 * Known limitation: only *top-level* code blocks are skipped for math rewriting.
 * A fenced/indented code block nested inside a blockquote/list lives inside the
 * parent node's range, and `rewriteMath` still runs on it. Inline code spans
 * (`` `…` ``) are protected at any depth via `normalizeDisplayMath`.
 */
export const parseMarkdownIntoBlocks = (markdown: string): Block[] => sliceTopLevelBlocks(normalizeMarkdown(markdown))

// A gap counts as a hard block terminator only when it contains a genuinely blank
// line — two consecutive line ends with nothing between them. A single line break
// (`heading` interrupting a paragraph, etc.) or a whitespace-only "blank" line
// (`\n\t\n`, which a later lazy line can dissolve) is NOT enough to freeze the
// block before it, so those keep the preceding block volatile. CRLF is matched so
// `\r\n\r\n` streams incrementally too.
const blankLineGap = /\r?\n\r?\n/
const gapHasBlankLine = (gap: string): boolean => blankLineGap.test(gap)

/**
 * Number of leading segments safe to freeze against any future append.
 *
 * A content block is only stable once a genuinely blank line seals it (before
 * that, appended text on the next line can fold into it via lazy continuation),
 * and only if that blank line is already followed by more content. So the frozen
 * prefix runs through the last blank-line gap that has content after it; it stops
 * at the first single-line/whitespace-only gap (the block before it can still
 * grow) and at a trailing block (which is always volatile).
 *
 * Final guard: a `list`/`blockquote` immediately before the boundary can absorb
 * the volatile block as a loose item / lazy quote line (`1. a\n\n2` where the `2`
 * later becomes `2.`), so it — and everything after — is kept volatile too.
 */
const committableSegmentCount = (segments: Segment[]): number => {
  let boundary = 0
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    if (segment.isGap) {
      // Freeze through a blank line already followed by content; a single-line,
      // whitespace-only, or trailing gap keeps the preceding block volatile.
      if (i + 1 < segments.length && gapHasBlankLine(segment.raw)) {
        boundary = i + 1
        continue
      }
      break
    }
    // A content block is only committed once we cross the blank-line gap after it,
    // so a trailing content block (no following segment) can never be frozen.
    if (i + 1 >= segments.length) {
      break
    }
  }
  let prev = boundary - 1
  while (prev >= 0 && segments[prev].isGap) {
    prev--
  }
  if (prev >= 0 && (segments[prev].type === 'list' || segments[prev].type === 'blockquote')) {
    boundary = prev
  }
  return boundary
}

/**
 * Incremental streaming state for {@link parseMarkdownIntoBlocksIncremental}.
 *
 * Two independent caches, because {@link parseMarkdownIntoBlocks} parses twice —
 * once to normalize math per source node, then again to split the *normalized*
 * string into blocks — and normalization can change block structure (a promoted
 * `$$` fence turns one source paragraph into a display-math block). So the block
 * split must run on the normalized text, not the source segments.
 *
 * Level 1 (`committedSourceLen` / `committedNorm`): the normalization of the
 * committed source prefix. Level 2 (`committedNormLen` / `committedBlocks`): the
 * block split of the committed *normalized* prefix. Both freeze everything except
 * the last content block and any `list`/`blockquote` a later append could merge
 * back into.
 */
export type IncrementalMarkdownState = {
  /** The full markdown parsed to produce {@link blocks}. */
  source: string
  /** Final blocks, i.e. the return value of a full parse of {@link source}. */
  blocks: Block[]
  /** Length (in `source` chars) of the source prefix whose normalization is frozen. */
  committedSourceLen: number
  /** Normalized text of that frozen source prefix (a stable prefix of the full normalized string). */
  committedNorm: string
  /** Length (in normalized chars) of the {@link committedNorm} prefix whose block split is frozen. */
  committedNormLen: number
  /** Blocks for `committedNorm.slice(0, committedNormLen)`. */
  committedBlocks: Block[]
}

const buildState = (source: string, prev: IncrementalMarkdownState | null): IncrementalMarkdownState => {
  const committedSourceLen = prev?.committedSourceLen ?? 0
  const committedNorm = prev?.committedNorm ?? ''
  const committedNormLen = prev?.committedNormLen ?? 0
  const committedBlocks = prev?.committedBlocks ?? []

  // Level 1 — normalization. Re-parse only the source tail (from the last frozen
  // source boundary) and normalize its now-settled segments, extending the stable
  // normalized prefix. The still-open tail segments are normalized but not frozen.
  const sourceTail = source.slice(committedSourceLen)
  const sourceTailSegments = parseSegments(sourceTail)
  const sourceCommitCount = committableSegmentCount(sourceTailSegments)
  const newlyCommittedSource = sourceTailSegments.slice(0, sourceCommitCount)
  const volatileSource = sourceTailSegments.slice(sourceCommitCount)

  const nextCommittedNorm = committedNorm + newlyCommittedSource.map(normalizeSegment).join('')
  const nextCommittedSourceLen =
    committedSourceLen + newlyCommittedSource.reduce((sum, segment) => sum + segment.raw.length, 0)
  const normalizedFull = nextCommittedNorm + volatileSource.map(normalizeSegment).join('')
  const stableNormLen = nextCommittedNorm.length

  // Level 2 — block split on the normalized text. Re-parse from the last frozen
  // block boundary and freeze further top-level nodes, but only those lying
  // entirely within the stable normalized prefix (bytes past it can still change)
  // and before any node a later append could merge into.
  const normTailSegments = parseSegments(normalizedFull.slice(committedNormLen))
  const blockCommitCount = committableSegmentCount(normTailSegments)
  const newlyCommittedBlocks: Block[] = []
  let advanced = 0
  for (let i = 0; i < blockCommitCount; i++) {
    const segment = normTailSegments[i]
    if (committedNormLen + advanced + segment.raw.length > stableNormLen) {
      break
    }
    if (!segment.isGap) {
      newlyCommittedBlocks.push({ content: segment.raw, isCode: segment.type === 'code' })
    }
    advanced += segment.raw.length
  }
  const nextCommittedNormLen = committedNormLen + advanced
  const nextCommittedBlocks = committedBlocks.concat(newlyCommittedBlocks)
  const blocks = nextCommittedBlocks.concat(sliceTopLevelBlocks(normalizedFull.slice(nextCommittedNormLen)))

  return {
    source,
    blocks,
    committedSourceLen: nextCommittedSourceLen,
    committedNorm: nextCommittedNorm,
    committedNormLen: nextCommittedNormLen,
    committedBlocks: nextCommittedBlocks,
  }
}

/**
 * Incremental {@link parseMarkdownIntoBlocks} for the streaming-append case.
 *
 * When `markdown` extends the previously-parsed `source` (a growing streamed
 * message), the committed prefix is reused and only the volatile tail is
 * re-parsed and re-normalized, turning the per-token cost from O(message length)
 * into O(last block + appended tail). For any other input (first call, edit,
 * non-prefix change) it does a full parse.
 *
 * The result is block-for-block identical to {@link parseMarkdownIntoBlocks}; see
 * markdown-blocks.test.ts for the property test proving equivalence across every
 * streaming prefix of realistic documents.
 *
 * @param markdown - Current full markdown content.
 * @param prev - State returned by the previous call for the same stream, or null.
 * @returns The blocks plus the state to thread into the next call.
 */
export const parseMarkdownIntoBlocksIncremental = (
  markdown: string,
  prev: IncrementalMarkdownState | null,
): { blocks: Block[]; state: IncrementalMarkdownState } => {
  if (prev && prev.source === markdown) {
    return { blocks: prev.blocks, state: prev }
  }

  const canReuse = prev !== null && prev.source.length > 0 && markdown.startsWith(prev.source)
  const state = buildState(markdown, canReuse ? prev : null)

  return { blocks: state.blocks, state }
}

/**
 * Whether a block contains math remark-math would render. Uses the same spans
 * `escapeCurrencyDollars` uses, so detection agrees with what gets rendered.
 *
 * `.test()` on a global regex advances (and leaks) `lastIndex`, and `matchAll`
 * reads that `lastIndex` at creation — so a leftover value would corrupt the
 * currency-escaping spans on the next block. Reset both before and after probing
 * to keep the shared regexes clean and detection stable.
 */
export const blockHasMath = (content: string): boolean => {
  displayMathSpan.lastIndex = 0
  inlineMathSpan.lastIndex = 0
  const hasMath = displayMathSpan.test(content) || inlineMathSpan.test(content)
  displayMathSpan.lastIndex = 0
  inlineMathSpan.lastIndex = 0
  return hasMath
}
