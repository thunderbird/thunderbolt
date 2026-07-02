/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { marked } from 'marked'

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

// Normalize a single top-level token's raw text. `code` tokens (fenced *and*
// indented) are left verbatim so a message that shows `$$…$$` / `\(…\)` as source
// keeps its literal text; every other token has its math delimiters rewritten.
const normalizeToken = (token: { type: string; raw: string }): string =>
  token.type === 'code' ? token.raw : normalizeDisplayMath(token.raw)

const lexToBlocks = (input: string): string[] => (input ? marked.lexer(input).map((token) => token.raw) : [])

/**
 * Splits markdown into an array of top-level block strings, promoting model
 * math-delimiter drift (`\[…\]`, `\(…\)`, single-line `$$…$$`) into the fenced
 * forms remark-math understands.
 *
 * Two-pass: lex into top-level tokens, rewrite math per non-code token, then
 * re-lex the rewritten string so a promoted single-line `$$…$$` still splits
 * into its own display-math block.
 *
 * Known limitation: only *top-level* code blocks are skipped for math rewriting.
 * A fenced/indented code block nested inside a blockquote/list lives in the
 * parent token's `raw` (marked strips its container prefixes, so it can't be
 * matched back to the source), and `rewriteMath` still runs on it. Inline code
 * spans (`` `…` ``) are protected at any depth via `normalizeDisplayMath`.
 */
export const parseMarkdownIntoBlocks = (markdown: string): string[] => {
  const normalized = marked
    .lexer(markdown)
    .map((token) => normalizeToken(token))
    .join('')
  return lexToBlocks(normalized)
}

/**
 * Incremental streaming state for {@link parseMarkdownIntoBlocksIncremental}.
 *
 * Two independent caches, because {@link parseMarkdownIntoBlocks} lexes twice —
 * once to normalize math per source token, then again to split the *normalized*
 * string into blocks — and normalization can change block structure (a promoted
 * `$$` fence turns one source paragraph into several normalized blocks). So the
 * block split must run on the normalized text, not the source tokens.
 *
 * Level 1 (`committedSourceLen` / `committedNorm`): the normalization of the
 * committed source prefix. Level 2 (`committedNormLen` / `committedBlocks`): the
 * block split of the committed *normalized* prefix. Both freeze everything except
 * the last content token and any `list`/`blockquote` that a later append could
 * merge back into.
 */
export type IncrementalMarkdownState = {
  /** The full markdown parsed to produce {@link blocks}. */
  source: string
  /** Final block strings, i.e. the return value of a full parse of {@link source}. */
  blocks: string[]
  /** Length (in `source` chars) of the source prefix whose normalization is frozen. */
  committedSourceLen: number
  /** Normalized text of that frozen source prefix (a stable prefix of the full normalized string). */
  committedNorm: string
  /** Length (in normalized chars) of the {@link committedNorm} prefix whose block split is frozen. */
  committedNormLen: number
  /** Blocks for `committedNorm.slice(0, committedNormLen)`. */
  committedBlocks: string[]
}

// Block types whose line(s) are complete on their own — appended text on a later
// line cannot fold into them. Every other block (paragraph, list, blockquote,
// table, html, code, …) can still grow via lazy continuation (`2. x` after a
// paragraph line is not a new list — an ordered marker only interrupts a
// paragraph when it starts at `1`), so is only safe to freeze once a blank line
// seals it.
const nonGrowableBlockTypes = new Set(['heading', 'hr'])

type LexToken = { type: string; raw: string }

/**
 * Whether the concatenated raw of `tokens[0, boundary)` ends with a genuinely
 * empty line (`\n\n`). Only a truly empty line hard-terminates a block against
 * lazy continuation — a marked top-level `space` token is not enough on its own
 * (a whitespace-only line like `\n\t\n`, or a single-newline gap, can dissolve
 * when a later line lazily continues the block).
 */
const endsWithBlankLine = (tokens: LexToken[], boundary: number): boolean => {
  if (boundary <= 0) {
    return false
  }
  const last = tokens[boundary - 1].raw
  if (last.length >= 2) {
    return last.endsWith('\n\n')
  }
  if (last !== '\n') {
    return false
  }
  return boundary - 2 >= 0 && tokens[boundary - 2].raw.endsWith('\n')
}

/**
 * Number of leading tokens safe to freeze against any future append.
 *
 * A block is only stable once a genuinely empty line seals it — before that,
 * appended text on the next line can fold into it via lazy continuation. So the
 * frozen prefix runs through the last blank-line boundary whose every preceding
 * content block is sealed (blank-line-terminated, or an inherently non-growable
 * heading/hr); it stops at the first growable block a following line could still
 * extend, and at any `space` token that is not a real blank-line boundary.
 *
 * Final guard: a `list`/`blockquote` right before the boundary blank line can
 * absorb the volatile block as a loose item / lazy quote line, so it is kept
 * volatile too.
 */
const committableTokenCount = (tokens: LexToken[]): number => {
  let boundary = 0
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === 'space') {
      // Freeze through a real blank line already followed by content; a trailing
      // or whitespace-only "space" stays volatile (and anything after it is
      // unstable), so stop there.
      if (i + 1 < tokens.length && endsWithBlankLine(tokens, i + 1)) {
        boundary = i + 1
        continue
      }
      break
    }
    const sealed = tokens[i + 1]?.type === 'space' || nonGrowableBlockTypes.has(tokens[i].type)
    if (!sealed) {
      break
    }
  }
  let prev = boundary - 1
  while (prev >= 0 && tokens[prev].type === 'space') {
    prev--
  }
  if (prev >= 0 && (tokens[prev].type === 'list' || tokens[prev].type === 'blockquote')) {
    boundary = prev
  }
  return boundary
}

const buildState = (source: string, prev: IncrementalMarkdownState | null): IncrementalMarkdownState => {
  const committedSourceLen = prev?.committedSourceLen ?? 0
  const committedNorm = prev?.committedNorm ?? ''
  const committedNormLen = prev?.committedNormLen ?? 0
  const committedBlocks = prev?.committedBlocks ?? []

  // Level 1 — normalization. Re-lex only the source tail (from the last frozen
  // source boundary) and normalize its now-settled tokens, extending the stable
  // normalized prefix. The still-open tail tokens are normalized but not frozen.
  const sourceTail = source.slice(committedSourceLen)
  const sourceTailTokens = marked.lexer(sourceTail)
  const sourceCommitCount = committableTokenCount(sourceTailTokens)
  const newlyCommittedSource = sourceTailTokens.slice(0, sourceCommitCount)
  const volatileSource = sourceTailTokens.slice(sourceCommitCount)

  const nextCommittedNorm = committedNorm + newlyCommittedSource.map(normalizeToken).join('')
  const nextCommittedSourceLen =
    committedSourceLen + newlyCommittedSource.reduce((sum, token) => sum + token.raw.length, 0)
  const normalizedFull = nextCommittedNorm + volatileSource.map(normalizeToken).join('')
  const stableNormLen = nextCommittedNorm.length

  // Level 2 — block split on the normalized text. Re-lex from the last frozen
  // block boundary and freeze further blocks, but only those lying entirely
  // within the stable normalized prefix (bytes past it can still change) and
  // before any block a later append could merge into.
  const normTailTokens = marked.lexer(normalizedFull.slice(committedNormLen))
  const blockCommitCount = committableTokenCount(normTailTokens)
  const newlyCommittedBlocks: string[] = []
  let advanced = 0
  for (let i = 0; i < blockCommitCount; i++) {
    const raw = normTailTokens[i].raw
    if (committedNormLen + advanced + raw.length > stableNormLen) {
      break
    }
    newlyCommittedBlocks.push(raw)
    advanced += raw.length
  }
  const nextCommittedNormLen = committedNormLen + advanced
  const nextCommittedBlocks = committedBlocks.concat(newlyCommittedBlocks)
  const blocks = nextCommittedBlocks.concat(lexToBlocks(normalizedFull.slice(nextCommittedNormLen)))

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
 * message), the committed prefix is reused and only the volatile tail is re-lexed
 * and re-normalized, turning the per-token cost from O(message length) into
 * O(last block + appended tail). For any other input (first call, edit, non-prefix
 * change) it does a full parse.
 *
 * The result is block-for-block identical to {@link parseMarkdownIntoBlocks};
 * see markdown-blocks.test.ts for the property test proving equivalence across
 * every streaming prefix of realistic documents.
 *
 * @param markdown - Current full markdown content.
 * @param prev - State returned by the previous call for the same stream, or null.
 * @returns The blocks plus the state to thread into the next call.
 */
export const parseMarkdownIntoBlocksIncremental = (
  rawMarkdown: string,
  prev: IncrementalMarkdownState | null,
): { blocks: string[]; state: IncrementalMarkdownState } => {
  // Normalize line endings up front: marked strips `\r` from token `raw`, which
  // would break the byte offsets this incremental parse threads through the
  // source. CommonMark treats CRLF/CR/LF identically, so this is output-neutral.
  const markdown = rawMarkdown.includes('\r') ? rawMarkdown.replace(/\r\n?/g, '\n') : rawMarkdown

  if (prev && prev.source === markdown) {
    return { blocks: prev.blocks, state: prev }
  }

  const canReuse = prev !== null && prev.source.length > 0 && markdown.startsWith(prev.source)
  const state = buildState(markdown, canReuse ? prev : null)

  return { blocks: state.blocks, state }
}
