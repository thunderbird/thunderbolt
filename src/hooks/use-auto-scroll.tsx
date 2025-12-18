import { useCallback, useEffect, useRef, useState, type RefObject, type TouchEvent, type WheelEvent } from 'react'

// Constants for scroll behavior thresholds
const SCROLL_THRESHOLD = {
  AWAY_FROM_BOTTOM: 100, // Distance in px to consider user has scrolled away
  BACK_TO_BOTTOM: 50, // Distance in px to consider user is back at bottom
} as const

// Smooth scroll duration in ms
const smoothScrollDuration = 200

// Easing function for smooth scroll (ease-out quad)
const easeOutQuad = (t: number): number => t * (2 - t)

interface UseAutoScrollOptions {
  /** Dependencies that should trigger a scroll to bottom */
  dependencies?: unknown[]
  /** Whether to use smooth scrolling */
  smooth?: boolean
  /** Whether content is currently streaming (uses instant scroll to keep up) */
  isStreaming?: boolean
  /** Callback when user manually scrolls */
  onUserScroll?: (isAtBottom: boolean) => void
  /** Root margin for intersection observer (default: '0px') */
  rootMargin?: string
}

interface UseAutoScrollReturn {
  /** Ref to attach to the scrollable container */
  scrollContainerRef: RefObject<HTMLDivElement | null>
  /** Ref to attach to the element at the bottom */
  scrollTargetRef: RefObject<HTMLDivElement | null>
  /** Whether the user has manually scrolled away from bottom */
  userHasScrolled: boolean
  /** Whether the scroll position is at the bottom */
  isAtBottom: boolean
  /** Manually scroll to bottom */
  scrollToBottom: (smooth?: boolean) => void
  /** Reset the user scroll state */
  resetUserScroll: () => void
  /** Event handlers to attach to the scrollable container */
  scrollHandlers: {
    onScroll: () => void
    onWheel: (e: WheelEvent) => void
    onTouchStart: (e: TouchEvent) => void
  }
}

/**
 * useAutoScroll - A React hook for managing auto-scroll behavior in chat-like interfaces
 *
 * Features:
 * - Automatically scrolls to bottom when new content is added
 * - Detects user scroll intent and pauses auto-scroll
 * - Re-engages auto-scroll when user returns to bottom
 * - Optimized for streaming content with instant scrolling option
 * - Uses Intersection Observer for performance
 *
 * @param options Configuration options for the hook
 * @returns Refs and handlers to implement auto-scroll behavior
 *
 * @example
 * ```tsx
 * const { scrollContainerRef, scrollTargetRef, scrollHandlers } = useAutoScroll({
 *   dependencies: [messages],
 *   isStreaming: true,
 * })
 *
 * return (
 *   <div ref={scrollContainerRef} {...scrollHandlers}>
 *     {content}
 *     <div ref={scrollTargetRef} />
 *   </div>
 * )
 * ```
 */
export function useAutoScroll({
  dependencies = [],
  smooth = true,
  isStreaming = false,
  onUserScroll,
  rootMargin = '0px',
}: UseAutoScrollOptions = {}): UseAutoScrollReturn {
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const scrollTargetRef = useRef<HTMLDivElement>(null)
  const [userHasScrolled, setUserHasScrolled] = useState(false)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const userHasScrolledRef = useRef(false)
  const animationFrameRef = useRef<number | null>(null)

  const getDistanceFromBottom = useCallback(() => {
    if (!scrollContainerRef.current) return 0
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current
    return scrollHeight - scrollTop - clientHeight
  }, [])

  const scrollToBottom = useCallback(
    (smoothScroll?: boolean) => {
      const container = scrollContainerRef.current
      if (!container) return

      const targetScrollTop = container.scrollHeight - container.clientHeight
      // Use instant scroll during streaming to keep up with rapid content updates
      const shouldSmooth = smoothScroll ?? (!isStreaming && smooth)

      if (shouldSmooth) {
        // Cancel any ongoing animation for THIS instance
        if (animationFrameRef.current !== null) {
          cancelAnimationFrame(animationFrameRef.current)
        }

        const startScrollTop = container.scrollTop
        const distance = targetScrollTop - startScrollTop
        const startTime = performance.now()

        const step = (currentTime: number) => {
          const elapsed = currentTime - startTime
          const progress = Math.min(elapsed / smoothScrollDuration, 1)
          const easedProgress = easeOutQuad(progress)

          container.scrollTop = startScrollTop + distance * easedProgress

          if (progress < 1) {
            animationFrameRef.current = requestAnimationFrame(step)
          } else {
            animationFrameRef.current = null
          }
        }

        animationFrameRef.current = requestAnimationFrame(step)
      } else {
        container.scrollTop = targetScrollTop
      }
    },
    [smooth, isStreaming],
  )

  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current) return

    const distanceFromBottom = getDistanceFromBottom()

    // Simple logic: far from bottom = paused, close to bottom = resume
    // Update both ref (immediate) and state (for UI)
    if (distanceFromBottom > SCROLL_THRESHOLD.AWAY_FROM_BOTTOM) {
      userHasScrolledRef.current = true
      setUserHasScrolled(true)
    } else if (distanceFromBottom < SCROLL_THRESHOLD.BACK_TO_BOTTOM) {
      userHasScrolledRef.current = false
      setUserHasScrolled(false)
    }
  }, [getDistanceFromBottom])

  const handleWheel = useCallback((e: WheelEvent) => {
    // Scrolling up on desktop
    if (e.deltaY < 0) {
      userHasScrolledRef.current = true
      setUserHasScrolled(true)
    }
  }, [])

  // On mobile, touchstart fires BEFORE scroll - mark that user is interacting
  // Only pause if not already at bottom (allows tapping without pausing)
  const handleTouchStart = useCallback(() => {
    const distanceFromBottom = getDistanceFromBottom()
    if (distanceFromBottom > SCROLL_THRESHOLD.BACK_TO_BOTTOM) {
      userHasScrolledRef.current = true
      setUserHasScrolled(true)
    }
  }, [getDistanceFromBottom])

  const resetUserScroll = useCallback(() => {
    userHasScrolledRef.current = false
    setUserHasScrolled(false)
  }, [])

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current
    const scrollTarget = scrollTargetRef.current

    if (!scrollTarget || !scrollContainer) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        const atBottom = entry.isIntersecting
        setIsAtBottom(atBottom)
        onUserScroll?.(atBottom)
      },
      {
        root: scrollContainer,
        rootMargin,
        threshold: 0,
      },
    )

    observer.observe(scrollTarget)

    return () => {
      observer.disconnect()
    }
  }, [rootMargin, onUserScroll])

  // Handle initial mount and dependency-based scrolling
  useEffect(() => {
    // Check ref for immediate/sync value (avoids stale state on mobile)
    if (!userHasScrolledRef.current) {
      scrollToBottom()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies])

  // Cleanup animation frame on unmount
  useEffect(() => {
    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current)
      }
    }
  }, [])

  return {
    scrollContainerRef,
    scrollTargetRef,
    userHasScrolled,
    isAtBottom,
    scrollToBottom,
    resetUserScroll,
    scrollHandlers: { onScroll: handleScroll, onWheel: handleWheel, onTouchStart: handleTouchStart },
  }
}
