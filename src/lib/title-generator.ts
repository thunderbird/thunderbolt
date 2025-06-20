/**
 * Generates a title from a chat message by extracting key words
 *
 * @param message - The chat message to generate a title from
 * @returns A formatted title with capitalized words or "New Chat" if no words are found
 */

function generateTitle(message: string): string {
  // Clean and extract key words
  const cleaned = message
    .replace(/^(hey|hi|hello|please|can you|could you|help me|what|how|why)/i, '')
    .replace(/[\n\r]+/g, ' ')
    .trim()

  const words = cleaned.split(' ').filter((w) => w.length > 2)
  const title = words.slice(0, 4).join(' ').slice(0, 24)

  return (
    title
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ') || 'New Chat'
  )
}
