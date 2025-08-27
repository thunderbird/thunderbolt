import { estimateTokensForMessages, isModelSupported } from '@/ai/tokenizers'
import { DatabaseSingleton } from '@/db/singleton'
import { chatMessagesTable } from '@/db/tables'
import type { Model, ThunderboltUIMessage } from '@/types'
import { eq } from 'drizzle-orm'
import { useCallback } from 'react'

/**
 * Hook to handle token estimation and saving for user messages
 */
export const useTokenEstimation = () => {
  const saveEstimatedTokens = useCallback(
    async (messageId: string, model: Model | null, messages: ThunderboltUIMessage[]) => {
      if (!model || !isModelSupported(model)) {
        return // Skip if model doesn't support tokenization
      }

      try {
        const estimatedTokens = estimateTokensForMessages(messages)

        // Update the message with estimated tokens
        const db = DatabaseSingleton.instance.db
        await db
          .update(chatMessagesTable)
          .set({ tokensEstimate: estimatedTokens })
          .where(eq(chatMessagesTable.id, messageId))

        console.log(`Saved estimated tokens: ${estimatedTokens} for user message ${messageId}`)
      } catch (error) {
        console.error('Failed to save estimated tokens:', error)
      }
    },
    [],
  )

  return { saveEstimatedTokens }
}
