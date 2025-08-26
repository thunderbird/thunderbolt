import { useCallback, useState } from 'react'
import { tokenizerService } from '@/services/tokenizer'
import type { Model, ThunderboltUIMessage } from '@/types'
import { createPrompt } from '@/ai/prompt'
import { getSetting } from '@/lib/dal'

interface TokenValidationResult {
  valid: boolean
  tokenCount: number
  limit: number
  message?: string
}

export function useTokenValidation() {
  const [isValidating, setIsValidating] = useState(false)
  const [lastValidation, setLastValidation] = useState<TokenValidationResult | null>(null)

  const validateMessages = useCallback(
    async (
      messages: ThunderboltUIMessage[],
      model: Model | null,
      newMessage?: string,
    ): Promise<TokenValidationResult> => {
      if (!model) {
        return {
          valid: false,
          tokenCount: 0,
          limit: 0,
          message: 'No model selected',
        }
      }

      setIsValidating(true)

      try {
        // Create a copy of messages with the new message if provided
        let messagesToValidate = [...messages]
        if (newMessage) {
          messagesToValidate.push({
            id: 'temp-validation',
            role: 'user',
            parts: [{ type: 'text', text: newMessage }],
          } as ThunderboltUIMessage)
        }

        // Get system prompt parameters
        const [locationName, locationLat, locationLng, preferredName] = await Promise.all([
          getSetting<string>('location_name'),
          getSetting<string>('location_lat'),
          getSetting<string>('location_lng'),
          getSetting<string>('preferred_name'),
        ])

        // Create system prompt
        const systemPrompt = createPrompt({
          preferredName: preferredName as string,
          location: {
            name: locationName as string,
            lat: locationLat ? parseFloat(locationLat as string) : undefined,
            lng: locationLng ? parseFloat(locationLng as string) : undefined,
          },
        })

        // Validate token limit
        const validation = await tokenizerService.validateTokenLimit(
          messagesToValidate,
          model.model,
          model.provider,
          systemPrompt,
          4096, // Reserve tokens for response
        )

        setLastValidation(validation)
        return validation
      } catch (error) {
        console.error('Token validation error:', error)

        // Return a safe default that allows the message to be sent
        // (server will do final validation)
        const result = {
          valid: true,
          tokenCount: 0,
          limit: tokenizerService.getContextLimit(model.model),
          message: undefined,
        }

        setLastValidation(result)
        return result
      } finally {
        setIsValidating(false)
      }
    },
    [],
  )

  const getTokenPercentage = useCallback((tokenCount: number, limit: number): number => {
    if (limit === 0) return 0
    return Math.min(100, Math.round((tokenCount / limit) * 100))
  }, [])

  const getTokenWarningLevel = useCallback((tokenCount: number, limit: number): 'safe' | 'warning' | 'danger' => {
    const percentage = getTokenPercentage(tokenCount, limit)
    if (percentage >= 90) return 'danger'
    if (percentage >= 75) return 'warning'
    return 'safe'
  }, [])

  return {
    validateMessages,
    isValidating,
    lastValidation,
    getTokenPercentage,
    getTokenWarningLevel,
  }
}
