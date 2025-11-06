import { useAutoScroll } from '@/hooks/use-auto-scroll'
import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'

type ReasoningDisplayProps = {
  text: string
  isStreaming: boolean
  instanceKey: string // Unique key to identify different reasoning instances
}

/**
 * Displays reasoning text below the accordion with smart fade-out logic:
 * - Always displays for minimum 3 seconds
 * - Fades out 3 seconds after the reasoning step finishes
 * - Instantly replaced by the next reasoning step if it appears before fade-out
 * - Cleans up timers properly
 */
export const ReasoningDisplay = ({ text, isStreaming, instanceKey }: ReasoningDisplayProps) => {
  const [displayText, setDisplayText] = useState(text)
  const [shouldShow, setShouldShow] = useState(true)
  const [currentKey, setCurrentKey] = useState(instanceKey)
  const displayStartTimeRef = useRef(Date.now())
  const fadeTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Update display text and reset timers when text or key changes
  useEffect(() => {
    // New reasoning instance or text changed
    if (text !== displayText || instanceKey !== currentKey) {
      setDisplayText(text)
      setCurrentKey(instanceKey)
      setShouldShow(true)
      displayStartTimeRef.current = Date.now()

      // Clear any pending fade timeout
      if (fadeTimeoutRef.current) {
        clearTimeout(fadeTimeoutRef.current)
        fadeTimeoutRef.current = null
      }
    }
  }, [text, displayText, instanceKey, currentKey])

  // Handle fade-out logic when streaming stops
  useEffect(() => {
    if (!isStreaming && shouldShow) {
      // Clear any existing timeout
      if (fadeTimeoutRef.current) {
        clearTimeout(fadeTimeoutRef.current)
      }

      const timeDisplayed = Date.now() - displayStartTimeRef.current
      const MIN_DISPLAY_TIME = 3000 // 3 seconds minimum
      const FADE_DELAY = 3000 // 3 seconds after stopping

      // Calculate how long to wait before fading
      const remainingMinTime = Math.max(0, MIN_DISPLAY_TIME - timeDisplayed)
      const totalWaitTime = remainingMinTime + FADE_DELAY

      fadeTimeoutRef.current = setTimeout(() => {
        setShouldShow(false)
        fadeTimeoutRef.current = null
      }, totalWaitTime)
    }

    // Cleanup on unmount or when dependencies change
    return () => {
      if (fadeTimeoutRef.current) {
        clearTimeout(fadeTimeoutRef.current)
        fadeTimeoutRef.current = null
      }
    }
  }, [isStreaming, shouldShow])

  // Reset shouldShow when streaming starts again
  useEffect(() => {
    if (isStreaming && !shouldShow) {
      setShouldShow(true)
      displayStartTimeRef.current = Date.now()
    }
  }, [isStreaming, shouldShow])

  const { scrollContainerRef, scrollTargetRef } = useAutoScroll({
    dependencies: [displayText.length],
    smooth: true,
    isStreaming: false,
    rootMargin: '0px',
  })

  return (
    <AnimatePresence mode="wait">
      {shouldShow && displayText && (
        <motion.div
          key={instanceKey}
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.3 }}
          className="relative text-muted-foreground leading-relaxed text-sm mt-1"
          ref={(el) => {
            scrollContainerRef.current = el
          }}
        >
          <div className="absolute top-0 w-full h-6 bg-gradient-to-b from-background to-transparent" />
          <div className="max-h-[200px] overflow-y-auto px-4  py-3">
            {displayText}
            <div ref={scrollTargetRef} />
          </div>
          <div className="absolute bottom-0 w-full h-6 bg-gradient-to-b from-transparent to-background" />
        </motion.div>
      )}
    </AnimatePresence>
  )
}
