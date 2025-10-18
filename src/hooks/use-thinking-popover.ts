import { useState, useEffect, useRef, useMemo } from 'react'
import { useIsMobile } from './use-mobile'
import type { ReasoningUIPart, ToolUIPart } from 'ai'

type UseThinkingPopoverParams = {
  minimumDisplayTime?: number
  parts: (ToolUIPart | ReasoningUIPart)[]
}

/**
 * Hook to manage thinking popover state with minimum display time.
 * Ensures the popover stays open for a minimum duration even when streaming stops,
 * and caches content to prevent empty popovers during the display period.
 */
export const useThinkingPopover = ({ parts, minimumDisplayTime = 3000 }: UseThinkingPopoverParams) => {
  const [isPopoverOpen, setIsPopoverOpen] = useState(false)
  const [cachedReasoningIndex, setCachedReasoningIndex] = useState(-1)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)

  const isMobile = useIsMobile()

  // Memoize the streaming reasoning part to prevent unnecessary re-renders
  const streamingReasoningIndex = useMemo(
    () => parts.findIndex((part) => part.type === 'reasoning' && part.state === 'streaming'),
    [parts],
  )

  const popoverStyle = useMemo(
    () => ({
      marginLeft: isMobile ? '0' : `calc(${cachedReasoningIndex * 32}px + 4px)`,
    }),
    [cachedReasoningIndex, isMobile],
  )

  // Get the reasoning content to display (either streaming or cached)
  const displayReasoningPart = cachedReasoningIndex >= 0 ? (parts[cachedReasoningIndex] as ReasoningUIPart) : null

  // Handle popover state with minimum display time
  useEffect(() => {
    // Clear any existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }

    if (streamingReasoningIndex >= 0) {
      // New thinking task started - open popover immediately and cache index
      setIsPopoverOpen(true)
      setCachedReasoningIndex(streamingReasoningIndex)
    } else {
      // No streaming reasoning - start minimum display time countdown
      if (isPopoverOpen) {
        timeoutRef.current = setTimeout(() => {
          setIsPopoverOpen(false)
          setCachedReasoningIndex(-1)
        }, minimumDisplayTime)
      }
    }

    // Cleanup timeout on unmount
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
    }
  }, [streamingReasoningIndex, isPopoverOpen, minimumDisplayTime])

  return { displayReasoningPart, popoverStyle, isPopoverOpen }
}
