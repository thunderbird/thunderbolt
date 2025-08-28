import type { ThunderboltUIMessage } from '@/types'

/**
 * Simple character-based token estimation for Qwen models
 * Note: This is an approximation based on character count, not exact tokenization
 * Real tokenizers download large models and fail reliably in browser environments
 *
 * @param text - Text to estimate tokens for
 * @returns Estimated token count
 */
export const estimateTokensForText = (text: string): number => {
  if (!text) return 0
  // Qwen models roughly follow ~3.5-4 characters per token for English
  // We'll use 3.5 to be slightly conservative
  return Math.ceil(text.length / 3.5)
}

/**
 * Estimate tokens for a list of messages
 * @param messages - Array of messages to count tokens for
 * @returns Estimated token count including message separators and role indicators
 */
export const estimateTokensForMessages = (messages: ThunderboltUIMessage[]): number => {
  if (!messages.length) {
    return 0
  }

  let totalTokens = 0

  for (const message of messages) {
    // Add tokens for role indicator (e.g., "user:", "assistant:")
    totalTokens += estimateTokensForText(`${message.role}:`)

    // Add tokens for message content from parts
    for (const part of message.parts) {
      if (part.type === 'text' && part.text) {
        totalTokens += estimateTokensForText(part.text)
      } else if (part.type.startsWith('tool-')) {
        // Handle tool-related parts (tool-call, tool-result, etc.)
        const toolText = JSON.stringify(part)
        totalTokens += estimateTokensForText(toolText)
      }
    }

    // Add separator tokens between messages (approximately 2-4 tokens)
    totalTokens += 3
  }

  // Add system prompt overhead (approximately 100-200 tokens)
  totalTokens += 150

  // Add some slack for message formatting and potential variations
  totalTokens += Math.ceil(totalTokens * 0.1) // 10% slack

  return totalTokens
}

/**
 * Format token counts for display
 * @param used Used tokens
 * @param max Max tokens
 * @returns Formatted string like "20K / 256K"
 */
export const formatTokenCount = (used: number, max?: number): string => {
  const formatter = new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  })

  const formattedUsed = formatter.format(used)
  const formattedMax = max !== undefined ? formatter.format(max) : 'unknown'
  return `${formattedUsed} / ${formattedMax}`
}
