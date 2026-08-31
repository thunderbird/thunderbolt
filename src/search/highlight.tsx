/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Fragment, type ReactNode } from 'react'
import { foldForMatch } from './fold'
import { planQueryTerms } from './query-plan'

/** A matched range of the original text, as `[start, end)`. */
type Span = { start: number; end: number }

/** A run of text, either marked as a hit or not. */
type Segment = { value: string; marked: boolean }

/**
 * The terms to mark: exactly the terms the query matched on, folded the same
 * way the index folds them.
 *
 * Both halves have to come from the search layer or highlighting drifts out of
 * agreement with matching. {@link planQueryTerms} because a re-segmented query
 * (`東京天気` matching a row that reads `東京の天気`) has no literal form to
 * find; {@link foldForMatch} because the index matches `sao` against `São`.
 */
const tokenize = (query: string): string[] =>
  planQueryTerms(query)
    .map((term) => foldForMatch(term).folded)
    .filter(Boolean)

/** Every start index of `needle` in `haystack`, non-overlapping. */
const indexesOf = (haystack: string, needle: string): number[] => {
  const found: number[] = []
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    found.push(at)
    at = haystack.indexOf(needle, at + needle.length)
  }
  return found
}

/** Sorts spans by start and merges any that touch or overlap. */
const mergeSpans = (spans: Span[]): Span[] =>
  [...spans]
    .sort((left, right) => left.start - right.start)
    .reduce<Span[]>((merged, span) => {
      const previous = merged[merged.length - 1]
      if (previous && span.start <= previous.end) {
        return [...merged.slice(0, -1), { start: previous.start, end: Math.max(previous.end, span.end) }]
      }
      return [...merged, span]
    }, [])

/**
 * Finds every token occurrence in `text`, matching on the folded form and
 * returning ranges into the *original* string. Substring rather than
 * token-boundary matching, which is also what makes unsegmented scripts
 * highlight correctly — `天気` marks inside `東京の天気`.
 */
const findSpans = (text: string, tokens: string[]): Span[] => {
  const { folded, offsets } = foldForMatch(text)
  return mergeSpans(
    tokens.flatMap((token) =>
      indexesOf(folded, token).map((at) => ({ start: offsets[at], end: offsets[at + token.length] })),
    ),
  )
}

/**
 * Splits `text` into marked and unmarked runs along `spans`, which must be
 * sorted, non-overlapping, and non-empty — what {@link findSpans} returns.
 */
const toSegments = (text: string, spans: Span[]): Segment[] => {
  const matched = spans.flatMap((span, index) => {
    const lead = text.slice(index === 0 ? 0 : spans[index - 1].end, span.start)
    const hit = { value: text.slice(span.start, span.end), marked: true }
    return lead ? [{ value: lead, marked: false }, hit] : [hit]
  })
  const tail = text.slice(spans[spans.length - 1].end)
  return tail ? [...matched, { value: tail, marked: false }] : matched
}

/**
 * Renders `text` with every occurrence of a `query` token wrapped in `<mark>`.
 *
 * Marks the terms the search layer matched on, not the raw query — see
 * {@link tokenize} — so highlights line up with what actually matched.
 * Purely presentational and safe: it builds React nodes rather than injecting
 * HTML, which is why the SQL `snippet()` markers are empty strings.
 */
export const HighlightMatch = ({ text, query }: { text: string; query: string }): ReactNode => {
  const tokens = tokenize(query)
  if (tokens.length === 0) {
    return text
  }

  const spans = findSpans(text, tokens)
  if (spans.length === 0) {
    return text
  }

  return toSegments(text, spans).map((segment, index) =>
    segment.marked ? (
      <mark
        key={index}
        // Reuse the app's amber→raspberry brand gradient (also on the primary
        // Button / Switch) as a text fill: bg-transparent kills <mark>'s default
        // yellow, and clipping the gradient to the glyphs makes the matched
        // substring itself gradient-colored — legible at both the body title and
        // xs snippet sizes without a heavy background block. Theme-aware via the
        // brand tokens. Same recipe as PrivateBadge.
        className="bg-transparent bg-clip-text font-semibold text-transparent [background-image:var(--gradient-brand)]"
      >
        {segment.value}
      </mark>
    ) : (
      <Fragment key={index}>{segment.value}</Fragment>
    ),
  )
}
