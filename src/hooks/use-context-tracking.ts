import { estimateTokensForText } from '@/ai/tokenizers'
import { getContextSizeForThread } from '@/lib/dal'
import type { Model } from '@/types'
import { useQuery } from '@tanstack/react-query'
import { useCallback } from 'react'

interface UseContextTrackingProps {
  model?: Model | null
  chatThreadId?: string
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
 * Hook to track context usage using context size from chat thread
 */
export const useContextTracking = ({
  model,
  chatThreadId,
  currentInput,
}: UseContextTrackingProps): UseContextTrackingReturn => {
  // Derive context window information from model
  const maxTokens = model?.contextWindow ?? undefined
  const isContextKnown = Boolean(maxTokens)

  // Fetch context size from chat thread using React Query
  const { data: contextSizeData, isLoading } = useQuery({
    queryKey: ['contextSize', chatThreadId],
    queryFn: () => getContextSizeForThread(chatThreadId!),
    enabled: Boolean(chatThreadId),
  })

  // Use 0 for calculations when context size is unknown (null)
  const contextSize = contextSizeData ?? 0

  // Simple estimation for current input (only used for overflow preview)
  const inputTokenEstimate = !currentInput.trim() ? 0 : estimateTokensForText(currentInput)

  // Add input estimate for overflow checking when user is typing
  const totalTokens = contextSize + (currentInput.trim() ? inputTokenEstimate : 0)
  const isOverflowing = isContextKnown && maxTokens ? totalTokens > maxTokens : false

  // Function to estimate tokens for arbitrary input (for input preview)
  const estimateTokensForInput = useCallback((input: string): number => {
    if (!input.trim()) {
      return 0
    }
    return estimateTokensForText(input)
  }, [])

  return {
    usedTokens: contextSize, // Show actual context size from thread
    maxTokens,
    isContextKnown,
    isOverflowing,
    isLoading,
    estimateTokensForInput,
  }
}
