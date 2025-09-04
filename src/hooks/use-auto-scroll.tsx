import { useCallback, useEffect, useRef, useState, type RefObject, type WheelEvent } from 'react'

// Constants for scroll behavior thresholds
const SCROLL_THRESHOLD = {
  AWAY_FROM_BOTTOM: 100, // Distance in px to consider user has scrolled away
  BACK_TO_BOTTOM: 10, // Distance in px to consider user is back at bottom
} as const

interface UseAutoScrollOptions {
  /** Dependencies that should trigger a scroll to bottom */
  dependencies?: any[]
  /** Whether to use smooth scrolling */
  smooth?: boolean
  /** Whether content is currently streaming (enables instant scrolling) */
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
 *   isStreaming: true,
 *   dependencies: [messages],
 *   rootMargin: '0px 0px -50px 0px'
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
  // Track the previous scrollTop value to determine scroll direction
  const prevScrollTopRef = useRef(0)

  // Utility to calculate distance from bottom
  const getDistanceFromBottom = useCallback(() => {
    if (!scrollContainerRef.current) return 0
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current
    return scrollHeight - scrollTop - clientHeight
  }, [])

  const scrollToBottom = useCallback(
    (smoothScroll?: boolean) => {
      const target = scrollTargetRef.current
      if (!target) return

      try {
        target.scrollIntoView({
          behavior: (smoothScroll ?? (!isStreaming && smooth)) ? 'smooth' : 'auto',
          block: 'end',
        })
      } catch (_) {
        // Fallback for older browsers
        scrollContainerRef.current?.scrollTo(0, scrollContainerRef.current.scrollHeight)
      }
    },
    [smooth, isStreaming],
  )

  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current) return

    const { scrollTop } = scrollContainerRef.current
    const distanceFromBottom = getDistanceFromBottom()

    // Determine if the user is scrolling up (intentional) or content is pushing down (automatic)
    const isScrollingUp = scrollTop < prevScrollTopRef.current

    // If the user scrolled up beyond the threshold, pause auto-scroll
    if (isScrollingUp && distanceFromBottom > SCROLL_THRESHOLD.AWAY_FROM_BOTTOM) {
      setUserHasScrolled(true)
    }

    // If we were previously paused and returned close enough to the bottom, resume auto-scroll
    if (!isScrollingUp && distanceFromBottom < SCROLL_THRESHOLD.BACK_TO_BOTTOM && userHasScrolled) {
      setUserHasScrolled(false)
    }

    // Update previous scrollTop for next comparison
    prevScrollTopRef.current = scrollTop
  }, [userHasScrolled, getDistanceFromBottom])

  const handleWheel = useCallback((e: WheelEvent) => {
    if (e.deltaY < 0) setUserHasScrolled(true)
  }, [])

  const resetUserScroll = useCallback(() => {
    setUserHasScrolled(false)
  }, [])

  // Set up Intersection Observer for accurate bottom detection
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
    if (!userHasScrolled) {
      scrollToBottom()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies])

  return {
    scrollContainerRef,
    scrollTargetRef,
    userHasScrolled,
    isAtBottom,
    scrollToBottom,
    resetUserScroll,
    scrollHandlers: { onScroll: handleScroll, onWheel: handleWheel },
  }
}
