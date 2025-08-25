import { useMemo } from 'react'
import { wouldExceedTokenLimit, createTokenLimitErrorMessage } from '@/lib/token-counter'
import type { ThunderboltUIMessage } from '@/types'

interface TokenValidationResult {
  isValid: boolean
  tokenCount: number
  limit: number
  errorMessage?: string
  newMessageTokens?: number
}

/**
 * Hook to validate token limits for messages
 */
export function useTokenValidation(
  messages: ThunderboltUIMessage[],
  modelName?: string,
  newMessage?: string
): TokenValidationResult {
  return useMemo(() => {
    if (!modelName) {
      return {
        isValid: true,
        tokenCount: 0,
        limit: 0,
      }
    }

    const validation = wouldExceedTokenLimit(messages, modelName, newMessage)
    
    return {
      isValid: !validation.exceeds,
      tokenCount: validation.tokenCount,
      limit: validation.limit,
      errorMessage: validation.exceeds 
        ? createTokenLimitErrorMessage(validation.tokenCount, validation.limit)
        : undefined,
      newMessageTokens: validation.newMessageTokens,
    }
  }, [messages, modelName, newMessage])
}

/**
 * Hook to get token count and limits for display purposes
 */
export function useTokenCount(
  messages: ThunderboltUIMessage[],
  modelName?: string
) {
  return useMemo(() => {
    if (!modelName) {
      return {
        tokenCount: 0,
        limit: 0,
        percentage: 0,
      }
    }

    const validation = wouldExceedTokenLimit(messages, modelName)
    const percentage = Math.round((validation.tokenCount / validation.limit) * 100)
    
    return {
      tokenCount: validation.tokenCount,
      limit: validation.limit,
      percentage: Math.min(percentage, 100), // Cap at 100%
    }
  }, [messages, modelName])
}