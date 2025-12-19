import { useCallback, useEffect, useRef, useState, type RefCallback, type TouchEvent, type WheelEvent } from 'react'

const smoothScrollDuration = 300

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3)

type UseAutoScrollOptions = {
  dependencies?: unknown[]
  smooth?: boolean
  isStreaming?: boolean
  rootMargin?: string
}

type UseAutoScrollReturn = {
  scrollContainerRef: RefCallback<HTMLDivElement>
  scrollTargetRef: RefCallback<HTMLDivElement>
  isAtBottom: boolean
  /** Scrolls to bottom. Returns true if scroll was performed, false if container not ready. */
  scrollToBottom: (smooth?: boolean) => boolean
  resetUserScroll: () => void
  scrollHandlers: {
    onWheel: (e: WheelEvent) => void
    onTouchStart: (e: TouchEvent) => void
  }
}

/**
 * Manages auto-scroll behavior for chat-like interfaces.
 * Uses IntersectionObserver for bottom detection and handles user scroll intent.
 */
export const useAutoScroll = ({
  dependencies = [],
  smooth = true,
  isStreaming = false,
  rootMargin = '0px',
}: UseAutoScrollOptions = {}): UseAutoScrollReturn => {
  // Use state for DOM elements to trigger re-renders when they're attached
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null)
  const [scrollTarget, setScrollTarget] = useState<HTMLDivElement | null>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
  // Ref for sync access in effects - auto-scroll disabled by default
  const userHasScrolledRef = useRef(true)
  const animationFrameRef = useRef<number | null>(null)

  // Callback refs that trigger state updates
  const scrollContainerRef = useCallback((el: HTMLDivElement | null) => setScrollContainer(el), [])
  const scrollTargetRef = useCallback((el: HTMLDivElement | null) => setScrollTarget(el), [])

  const scrollToBottom = useCallback(
    (smoothScroll?: boolean): boolean => {
      if (!scrollContainer) return false

      const targetScrollTop = scrollContainer.scrollHeight - scrollContainer.clientHeight
      const shouldSmooth = smoothScroll ?? (!isStreaming && smooth)

      if (shouldSmooth) {
        if (animationFrameRef.current !== null) {
          cancelAnimationFrame(animationFrameRef.current)
        }

        const startScrollTop = scrollContainer.scrollTop
        const distance = targetScrollTop - startScrollTop
        const startTime = performance.now()

        const step = (currentTime: number) => {
          const elapsed = currentTime - startTime
          const progress = Math.min(elapsed / smoothScrollDuration, 1)
          const easedProgress = easeOutCubic(progress)

          scrollContainer.scrollTop = startScrollTop + distance * easedProgress

          if (progress < 1) {
            animationFrameRef.current = requestAnimationFrame(step)
          } else {
            animationFrameRef.current = null
          }
        }

        animationFrameRef.current = requestAnimationFrame(step)
      } else {
        scrollContainer.scrollTop = targetScrollTop
      }

      return true
    },
    [scrollContainer, smooth, isStreaming],
  )

  const handleWheel = useCallback((e: WheelEvent) => {
    if (e.deltaY < 0) {
      userHasScrolledRef.current = true
    }
  }, [])

  // Any touch interaction disables auto-scroll - user wants control
  const handleTouchStart = useCallback(() => {
    userHasScrolledRef.current = true
  }, [])

  const resetUserScroll = useCallback(() => {
    userHasScrolledRef.current = false
  }, [])

  // IntersectionObserver for bottom detection - runs when elements are available
  useEffect(() => {
    if (!scrollTarget || !scrollContainer) return

    let isFirstObservation = true

    const observer = new IntersectionObserver(
      ([entry]) => {
        const atBottom = entry.isIntersecting
        setIsAtBottom(atBottom)

        // Enable auto-scroll when user scrolls to bottom (not on initial setup)
        if (atBottom && !isFirstObservation) {
          userHasScrolledRef.current = false
        }

        isFirstObservation = false
      },
      {
        root: scrollContainer,
        rootMargin,
        threshold: 0,
      },
    )

    observer.observe(scrollTarget)

    return () => observer.disconnect()
  }, [scrollContainer, scrollTarget, rootMargin, ...dependencies])

  // Scroll when dependencies change (if auto-scroll is enabled)
  useEffect(() => {
    if (!userHasScrolledRef.current && scrollContainer) {
      scrollToBottom()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollContainer, ...dependencies])

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
    isAtBottom,
    scrollToBottom,
    resetUserScroll,
    scrollHandlers: { onWheel: handleWheel, onTouchStart: handleTouchStart },
  }
}
