/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getQuotes } from '@/lib/quotes'
import type { ThunderboltUIMessage } from '@/types'
import type { I18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { defaultChatTitle } from './constants'

/**
 * Generates a title from a chat message by extracting key words
 *
 * @param message - The chat message to generate a title from
 * @param options - Optional configuration object
 * @param options.words - Number of words to include in the title (default: 6)
 * @returns A formatted title with capitalized words or "New Chat" if no words are found
 */

/**
 * The text a thread's title should be derived from, taken from its first user
 * message.
 *
 * Typed text and quoted passages both count. Quotes are their own part type
 * rather than text, so a message that is *only* a quoted selection used to
 * yield nothing and leave the thread called "New Chat" permanently. That was an
 * edge case until "Ask about this" existed on artifacts and Mini Apps, where
 * quoting *is* how a conversation starts.
 *
 * The raw passage, not a rendered blockquote: the `> ` markers that help a
 * model read quoted context are noise in a title.
 */
export const titleSourceText = (message: ThunderboltUIMessage): string => {
  const typed = message.parts
    .filter((part) => part.type === 'text')
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join(' ')
  const quoted = getQuotes(message)
    .map((quote) => quote.text)
    .join(' ')
  return [typed, quoted].filter(Boolean).join(' ').trim()
}

export const generateTitle = (message: string, options?: { words?: number }): string => {
  // Clean and extract key words
  const cleaned = message
    .replace(/^(hey|hi|hello|please|can you|could you|help me|what|how|why)/i, '')
    .replace(/[\n\r]+/g, ' ')
    .trim()

  const words = cleaned.split(' ').filter((w) => w.length > 2)

  // Use the specified number of words or default to 6
  const maxWords = options?.words ?? 6
  const selectedWords = words.slice(0, maxWords)
  const title = selectedWords.join(' ')

  // If the title is longer than 50 characters, truncate at word boundary
  const maxLength = 50
  let finalTitle = title
  if (title.length > maxLength) {
    // Find the last space before the character limit
    const truncated = title.slice(0, maxLength)
    const lastSpaceIndex = truncated.lastIndexOf(' ')
    finalTitle = lastSpaceIndex > 0 ? truncated.slice(0, lastSpaceIndex) : truncated
  }

  // Remove punctuation from the final title
  finalTitle = finalTitle.replace(/[.,!?;:'"()[\]{}]/g, '')

  return (
    finalTitle
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ') || defaultChatTitle
  )
}

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
