/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { I18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { graphemeSegmenter, wordSegmenterFor } from '@/lib/segmenter'
import { defaultChatTitle } from './constants'

/**
 * Character budget for a generated title — roughly eight words of Latin text,
 * and considerably more content in Japanese or Chinese, which is fine: the
 * sidebar elides whatever doesn't fit either way (`chat-list-item.tsx` renders
 * the title with `truncate`). The budget is a guard against unbounded text
 * reaching the synced `title` column, not a layout measurement, so the exact
 * number carries no meaning beyond "about a sidebar row".
 */
const maxTitleLength = 48

/**
 * Cut for text with no word boundary to cut on — a solid run of emoji, or one
 * very long word.
 *
 * A plain `slice` can land inside a surrogate pair and yield a lone surrogate:
 * an ill-formed string that would be written to the synced `title` column and
 * render as a replacement glyph. Grapheme granularity cuts between characters
 * as a reader counts them, so it also keeps ZWJ sequences (`👨‍👩‍👧‍👦`) and
 * combining marks whole.
 *
 * Without `Intl.Segmenter` only the ill-formed case is worth guarding: a
 * trailing high surrogate is dropped, and a split ZWJ sequence is left as the
 * cosmetic blemish it is.
 */
const cutToGrapheme = (text: string, budget: number): string => {
  const segmenter = graphemeSegmenter()
  if (!segmenter) {
    const cut = text.slice(0, budget)
    return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
  }

  let end = 0
  for (const { index, segment } of segmenter.segment(text)) {
    if (index + segment.length > budget) {
      break
    }
    end = index + segment.length
  }
  return text.slice(0, end)
}

/**
 * Cut point at or before `budget` characters that doesn't split a word.
 *
 * Segments are used to *locate* the cut, never to rebuild the string: the
 * original text is sliced at the boundary so its own spacing and punctuation
 * survive. Joining word-like segments instead would space out Japanese
 * (`同期 ルール を 修正`), which no reader writes.
 *
 * Without `Intl.Segmenter` this degrades to the last space before the budget —
 * which is exactly nothing in an unsegmented script, so the cut falls through
 * to {@link cutToGrapheme}.
 */
const cutAtWordBoundary = (text: string, budget: number): string => {
  if (text.length <= budget) {
    return text
  }

  const segmenter = wordSegmenterFor(text)
  if (!segmenter) {
    const lastSpace = text.slice(0, budget).lastIndexOf(' ')
    return lastSpace > 0 ? text.slice(0, lastSpace) : cutToGrapheme(text, budget)
  }

  // Iterated rather than spread: the loop stops at the budget, so a very long
  // first message is never segmented past its first few dozen characters.
  let wordEnd = 0
  for (const { index, segment, isWordLike } of segmenter.segment(text)) {
    if (index + segment.length > budget) {
      break
    }
    if (isWordLike) {
      wordEnd = index + segment.length
    }
  }

  // `wordEnd` is still 0 when nothing word-like fit: emoji are not word-like,
  // and neither is a 60-character URL.
  return wordEnd > 0 ? text.slice(0, wordEnd) : cutToGrapheme(text, budget)
}

/**
 * Generates a chat title from the first user message.
 *
 * The message *is* the title, cut at a word boundary — deliberately nothing
 * else. Dropping short words, stripping opener phrases and title-casing each
 * word all encode English convention, and each one damaged English too: `CI`
 * and `AI` fell below a `length > 2` filter, `iOS` came back as `Ios`, and
 * languages that title in sentence case got Title Case regardless. Resist
 * adding any of them back per-locale; the user's own words already read right.
 *
 * @param message - The chat message to generate a title from
 * @returns The message cut to a whole word, or the `defaultChatTitle` sentinel
 * when it holds no text at all
 */
export const generateTitle = (message: string): string =>
  cutAtWordBoundary(message.replace(/\s+/g, ' ').trim(), maxTitleLength) || defaultChatTitle

/**
 * The thread title as shown to the user.
 *
 * `defaultChatTitle` is a sentinel, not copy: it is written to the synced
 * `chat_threads` row and compared on hydration to decide whether to auto-title,
 * so storing a localized value would both break that comparison and put a
 * locale-dependent string into synced data. It is translated here, at display,
 * instead.
 */
export const chatTitleLabel = (i18n: I18n, title: string | null | undefined): string => {
  if (!title) {
    return i18n._(msg`Untitled chat`)
  }
  return title === defaultChatTitle ? i18n._(msg`New Chat`) : title
}
