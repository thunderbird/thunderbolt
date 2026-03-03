import { useEffect, useRef } from 'react'
import type { ThunderboltUIMessage } from '@/types'
import { useHaptics } from '@/hooks/use-haptics'

const STREAMING_BUMP_INTERVAL_MS = 400
const MIN_CHARS_BETWEEN_BUMP = 30

const getLastAssistantTextLength = (messages: ThunderboltUIMessage[]): number => {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return 0
  return (last.parts ?? []).reduce((acc, part) => acc + (part.type === 'text' ? (part.text?.length ?? 0) : 0), 0)
}

/**
 * Triggers haptic feedback during AI streaming:
 * - Light bumps periodically while content streams (throttled by time + char count)
 * - Medium bump when streaming completes
 */
export const useStreamingHaptics = (messages: ThunderboltUIMessage[], status: string): void => {
  const { triggerLight, triggerMedium, isAvailable } = useHaptics()
  const prevTextLengthRef = useRef(0)
  const lastBumpTimeRef = useRef(0)
  const lastBumpTextLengthRef = useRef(0)
  const prevStreamingRef = useRef(false)

  useEffect(() => {
    if (!isAvailable) return

    const isStreaming = status === 'streaming'
    const textLength = getLastAssistantTextLength(messages)

    if (isStreaming) {
      const lengthIncreased = textLength > prevTextLengthRef.current
      const now = Date.now()
      const timeSinceLastBump = now - lastBumpTimeRef.current
      const charsSinceLastBump = textLength - lastBumpTextLengthRef.current

      if (
        lengthIncreased &&
        (timeSinceLastBump >= STREAMING_BUMP_INTERVAL_MS || charsSinceLastBump >= MIN_CHARS_BETWEEN_BUMP)
      ) {
        triggerLight()
        lastBumpTimeRef.current = now
        lastBumpTextLengthRef.current = textLength
      }
      prevTextLengthRef.current = textLength
    } else {
      if (prevStreamingRef.current) {
        triggerMedium()
      }
      prevTextLengthRef.current = textLength
      lastBumpTextLengthRef.current = 0
    }
    prevStreamingRef.current = isStreaming
  }, [messages, status, isAvailable, triggerLight, triggerMedium])
}
