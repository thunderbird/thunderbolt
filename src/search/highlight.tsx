/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Fragment, type ReactNode } from 'react'

/** Escapes a string so it can be embedded literally inside a RegExp. */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Splits `query` into the same lowercased tokens the search index uses:
 * whitespace-separated, empties dropped.
 */
const tokenize = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean)

/**
 * Renders `text` with every occurrence of a `query` token wrapped in `<mark>`.
 *
 * Tokenization matches the search layer exactly (whitespace split,
 * case-insensitive) so highlights line up with what actually matched. Purely
 * presentational and safe: it builds React nodes rather than injecting HTML.
 */
export const HighlightMatch = ({ text, query }: { text: string; query: string }): ReactNode => {
  const tokens = tokenize(query)
  if (tokens.length === 0) {
    return text
  }

  const tokenSet = new Set(tokens)
  const pattern = new RegExp(`(${tokens.map(escapeRegExp).join('|')})`, 'gi')
  // Capturing group keeps the delimiters, so matched segments land on odd indices.
  const segments = text.split(pattern)

  return segments.map((segment, index) =>
    tokenSet.has(segment.toLowerCase()) ? (
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
        {segment}
      </mark>
    ) : (
      <Fragment key={index}>{segment}</Fragment>
    ),
  )
}
