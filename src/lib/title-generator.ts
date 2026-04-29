/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Generates a title from a chat message by extracting key words
 *
 * @param message - The chat message to generate a title from
 * @param options - Optional configuration object
 * @param options.words - Number of words to include in the title (default: 6)
 * @returns A formatted title with capitalized words or "New Chat" if no words are found
 */

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
      .join(' ') || 'New Chat'
  )
}
