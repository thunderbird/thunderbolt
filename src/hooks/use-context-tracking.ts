import { estimateTokensForText } from '@/ai/tokenizers'
import { getContextSizeForThread } from '@/lib/dal'
import type { Model } from '@/types'
import { useQuery } from '@tanstack/react-query'

interface UseContextTrackingProps {
  model: Model
  chatThreadId?: string
  currentInput: string
  onOverflow?: () => void
}

interface UseContextTrackingReturn {
  usedTokens: number | null
  maxTokens: number | null
  isContextKnown: boolean
  isOverflowing: boolean | null
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
  const maxTokens = model.contextWindow

  // Fetch context size from chat thread using React Query
  const { data: contextSize, isLoading } = useQuery({
    queryKey: ['contextSize', chatThreadId],
    queryFn: () => getContextSizeForThread(chatThreadId!),
    enabled: Boolean(chatThreadId),
  })

  const usedTokens = contextSize ?? null

  // Simple estimation for current input (only used for overflow preview)
  const inputTokenEstimate = !currentInput.trim() ? 0 : estimateTokensForText(currentInput)

  // Add input estimate for overflow checking when user is typing
  const totalTokens = contextSize ? contextSize + (currentInput.trim() ? inputTokenEstimate : 0) : null
  const isOverflowing = totalTokens && maxTokens ? totalTokens > maxTokens : null

  return {
    isContextKnown: usedTokens !== null && maxTokens !== null,
    usedTokens,
    maxTokens,
    isOverflowing,
    isLoading,
    estimateTokensForInput: estimateTokensForText,
  }
}
