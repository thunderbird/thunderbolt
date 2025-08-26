import { useState, useCallback } from 'react'
import { ThunderboltUIMessage } from '@/types'
import { 
  wouldExceedTokenLimit, 
  getTokenLimitErrorMessage
} from '@/lib/token-utils'
import { createPrompt } from '@/ai/prompt'
import { getSetting } from '@/lib/dal'

interface TokenValidationState {
  isValid: boolean
  currentTokens: number
  maxTokens: number
  newMessageTokens: number
  errorMessage: string | null
  isLoading: boolean
}

export function useTokenValidation() {
  const [validationState, setValidationState] = useState<TokenValidationState>({
    isValid: true,
    currentTokens: 0,
    maxTokens: 8192,
    newMessageTokens: 0,
    errorMessage: null,
    isLoading: false
  })

  const validateMessage = useCallback(async (
    newMessage: string,
    existingMessages: ThunderboltUIMessage[],
    modelName: string
  ): Promise<boolean> => {
    if (!newMessage.trim()) {
      setValidationState(prev => ({
        ...prev,
        isValid: true,
        errorMessage: null,
        isLoading: false
      }))
      return true
    }

    setValidationState(prev => ({ ...prev, isLoading: true }))

    try {
      // Get system prompt
      const preferredName = await getSetting<string>('preferred_name')
      const locationName = await getSetting<string>('location_name')
      const locationLat = await getSetting<string>('location_lat')
      const locationLng = await getSetting<string>('location_lng')

      const systemPrompt = createPrompt({
        preferredName: preferredName as string,
        location: {
          name: locationName as string,
          lat: locationLat ? parseFloat(locationLat as string) : undefined,
          lng: locationLng ? parseFloat(locationLng as string) : undefined,
        },
      })

      // Convert messages to format expected by token counter
      const messagesForCounting = existingMessages.map(msg => {
        // Extract text content from message parts
        const textParts = msg.parts
          .filter(part => part.type === 'text')
          .map(part => (part as { text?: string }).text || '')
          .join(' ')
        
        return {
          role: msg.role,
          content: textParts
        }
      })

      // Check token limits
      const result = await wouldExceedTokenLimit(
        newMessage,
        messagesForCounting,
        systemPrompt,
        modelName
      )

      const errorMessage = result.wouldExceed 
        ? getTokenLimitErrorMessage(result.currentTokens, result.maxTokens, result.newMessageTokens)
        : null

      setValidationState({
        isValid: !result.wouldExceed,
        currentTokens: result.currentTokens,
        maxTokens: result.maxTokens,
        newMessageTokens: result.newMessageTokens,
        errorMessage,
        isLoading: false
      })

      return !result.wouldExceed
    } catch (error) {
      console.error('Token validation error:', error)
      setValidationState(prev => ({
        ...prev,
        isValid: true, // Allow submission on error to avoid blocking user
        errorMessage: null,
        isLoading: false
      }))
      return true
    }
  }, [])

  const resetValidation = useCallback(() => {
    setValidationState({
      isValid: true,
      currentTokens: 0,
      maxTokens: 8192,
      newMessageTokens: 0,
      errorMessage: null,
      isLoading: false
    })
  }, [])

  return {
    ...validationState,
    validateMessage,
    resetValidation
  }
}