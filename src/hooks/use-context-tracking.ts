/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { estimateTokensForText } from '@/ai/tokenizers'
import { useDatabase } from '@/contexts'
import { getContextSizeForThread } from '@/dal'
import type { Model } from '@/types'
import { useQuery } from '@powersync/tanstack-react-query'
import { toCompilableQuery } from '@powersync/drizzle-driver'

type UseContextTrackingProps = {
  model: Model
  chatThreadId?: string
  currentInput: string
  onOverflow?: () => void
}

type UseContextTrackingReturn = {
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
  const db = useDatabase()

  // Derive context window information from model
  const maxTokens = model.contextWindow

  // Fetch context size from chat thread using React Query
  const { data = [], isLoading } = useQuery({
    queryKey: ['contextSize', chatThreadId],
    query: toCompilableQuery(getContextSizeForThread(db, chatThreadId ?? '')),
    enabled: Boolean(chatThreadId),
  })

  const contextSize = data[0]?.contextSize ?? null

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
