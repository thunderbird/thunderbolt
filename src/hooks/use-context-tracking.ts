import { estimateTokensForText } from '@/ai/tokenizers'
import type { Model, ThunderboltUIMessage, UIMessageMetadata } from '@/types'
import { useCallback, useMemo } from 'react'

interface UseContextTrackingProps {
  model?: Model | null
  messages: ThunderboltUIMessage[]
  currentInput: string
}

interface UseContextTrackingReturn {
  usedTokens: number
  maxTokens: number | undefined
  isContextKnown: boolean
  isOverflowing: boolean
  isLoading: boolean
  estimateTokensForInput: (input: string) => number
}

/**
 * Hook to track context usage using actual token counts from the database
 * Uses the total token count from the most recent message's metadata
 */
export const useContextTracking = ({
  model,
  messages,
  currentInput,
}: UseContextTrackingProps): UseContextTrackingReturn => {
  // Derive context window information from model
  const maxTokens = model?.contextWindow ?? undefined
  const isContextKnown = Boolean(maxTokens)

  // Get actual token count from the most recent message's metadata
  const actualTokensFromLastMessage = useMemo(() => {
    if (!messages.length) {
      return 0
    }

    // Find the most recent message with token usage data
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      const metadata = message.metadata as UIMessageMetadata | undefined
      if (metadata?.usage?.totalTokens) {
        return metadata.usage.totalTokens
      }
    }

    return 0
  }, [messages])

  // Simple estimation for current input (only used for overflow preview)
  const inputTokenEstimate = useMemo(() => {
    if (!currentInput.trim()) {
      return 0
    }
    return estimateTokensForText(currentInput)
  }, [currentInput])

  // The actual tokens already represent the full conversation history
  // Only add input estimate for overflow checking when user is typing
  const totalTokens = actualTokensFromLastMessage + (currentInput.trim() ? inputTokenEstimate : 0)
  const isOverflowing = isContextKnown && maxTokens ? totalTokens > maxTokens : false

  // Function to estimate tokens for arbitrary input (for input preview)
  const estimateTokensForInput = useCallback((input: string): number => {
    if (!input.trim()) {
      return 0
    }
    return estimateTokensForText(input)
  }, [])

  return {
    usedTokens: actualTokensFromLastMessage, // Show actual tokens used (not including current input)
    maxTokens,
    isContextKnown,
    isOverflowing,
    isLoading: false,
    estimateTokensForInput,
  }
}
