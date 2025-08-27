import { estimateTokensForMessages, estimateTokensForText, isModelSupported } from '@/ai/tokenizers'
import type { Model, ThunderboltUIMessage } from '@/types'
import { useCallback, useEffect, useMemo, useState } from 'react'

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

const SLACK_TOKENS = 150

/**
 * Hook to track context usage and detect overflow conditions
 * Uses simple character-based estimation, not real tokenization
 */
export const useContextTracking = ({
  model,
  messages,
  currentInput,
}: UseContextTrackingProps): UseContextTrackingReturn => {
  const [inputTokens, setInputTokens] = useState(0)

  // Derive context window information from model
  const maxTokens = model?.contextWindow ?? undefined
  const tokenizerName = model?.tokenizer ?? undefined
  const isModelSupportedForTracking = model ? isModelSupported(model) : false
  const isContextKnown = Boolean(maxTokens && tokenizerName && isModelSupportedForTracking)

  // Memoize message token count to avoid recalculating during streaming
  // Only recalculates when the messages array reference changes (not during streaming)
  const messageTokens = useMemo(() => {
    if (!isContextKnown) {
      return 0
    }

    console.log('Calculating tokens for', messages.length, 'messages')
    return estimateTokensForMessages(messages)
  }, [messages, isContextKnown])

  // Update input tokens when current input changes
  useEffect(() => {
    if (!isContextKnown || !currentInput.trim()) {
      setInputTokens(0)
      return
    }

    const tokens = estimateTokensForText(currentInput)
    setInputTokens(tokens)
  }, [currentInput, isContextKnown])

  // Calculate total tokens and overflow status
  const totalTokens = messageTokens + inputTokens + SLACK_TOKENS
  const isOverflowing = isContextKnown && maxTokens ? totalTokens > maxTokens : false

  // Function to estimate tokens for arbitrary input
  const estimateTokensForInput = useCallback((input: string): number => {
    if (!input.trim()) {
      return 0
    }
    return estimateTokensForText(input)
  }, [])

  return {
    usedTokens: totalTokens,
    maxTokens,
    isContextKnown,
    isOverflowing,
    isLoading: false, // No async loading anymore
    estimateTokensForInput,
  }
}
