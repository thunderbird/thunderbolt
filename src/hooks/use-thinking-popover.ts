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
 * and provides smooth animation for popover positioning.
 */
export const useThinkingPopover = ({ parts, minimumDisplayTime = 3000 }: UseThinkingPopoverParams) => {
  const [isPopoverOpen, setIsPopoverOpen] = useState(false)
  const [cachedReasoningIndex, setCachedReasoningIndex] = useState(-1)
  const [animatedIndex, setAnimatedIndex] = useState(-1)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)
  const rafRef = useRef<number | null>(null)

  const isMobile = useIsMobile()

  // Find the currently streaming reasoning part
  const streamingReasoningIndex = useMemo(
    () => parts.findIndex((part) => part.type === 'reasoning' && part.state === 'streaming'),
    [parts],
  )

  // Get the reasoning content to display (either streaming or cached)
  const displayReasoningPart = cachedReasoningIndex >= 0 ? (parts[cachedReasoningIndex] as ReasoningUIPart) : null

  // Smooth animation for popover positioning
  const animateToIndex = (targetIndex: number) => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
    }

    const startIndex = animatedIndex
    const startTime = performance.now()
    const duration = 200

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime
      const progress = Math.min(elapsed / duration, 1)

      const easeOutCubic = 1 - Math.pow(1 - progress, 3)
      const currentIndex = startIndex + (targetIndex - startIndex) * easeOutCubic

      setAnimatedIndex(currentIndex)

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate)
      }
    }

    rafRef.current = requestAnimationFrame(animate)
  }

  // Handle popover state and animation
  useEffect(() => {
    // Clear any existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }

    if (streamingReasoningIndex >= 0) {
      // New thinking task started
      setIsPopoverOpen(true)
      setCachedReasoningIndex(streamingReasoningIndex)
      animateToIndex(streamingReasoningIndex)
    } else {
      // No streaming reasoning - start minimum display time countdown
      if (isPopoverOpen) {
        timeoutRef.current = setTimeout(() => {
          setIsPopoverOpen(false)
          setCachedReasoningIndex(-1)
          setAnimatedIndex(-1)
        }, minimumDisplayTime)
      }
    }

    // Cleanup on unmount
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }
    }
  }, [streamingReasoningIndex, isPopoverOpen, minimumDisplayTime])

  // Calculate popover position
  const popoverStyle = useMemo(
    () => ({
      marginLeft: isMobile ? '0' : `calc(${Math.round(animatedIndex * 32)}px + 4px)`,
    }),
    [animatedIndex, isMobile],
  )

  return {
    displayReasoningPart,
    popoverStyle,
    isPopoverOpen,
  }
}
