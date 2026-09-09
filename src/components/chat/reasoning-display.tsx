/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useSmoothText } from '@/hooks/use-smooth-text'
import { useAutoScroll } from '@/hooks/use-auto-scroll'
import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useEffectEvent, useRef, useState } from 'react'

type ReasoningDisplayProps = {
  text?: string
  isStreaming: boolean
}

/**
 * Displays reasoning text below the accordion with smart fade-out logic:
 * - Always displays for minimum 3 seconds
 * - Fades out 3 seconds after the reasoning step finishes
 * - Instantly replaced by the next reasoning step if it appears before fade-out
 * - Cleans up timers properly
 */
export const ReasoningDisplay = ({ text, isStreaming }: ReasoningDisplayProps) => {
  const displayedText = useSmoothText(text ?? '', isStreaming)
  const [shouldShow, setShouldShow] = useState(isStreaming)
  const displayStartTimeRef = useRef(Date.now())
  const fadeTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const prevIsStreamingRef = useRef(isStreaming)

  const hasText = Boolean(text && text.trim())

  // Reset shouldShow when streaming starts again
  if (isStreaming && !prevIsStreamingRef.current && !shouldShow) {
    setShouldShow(true)
    displayStartTimeRef.current = Date.now()
  }
  prevIsStreamingRef.current = isStreaming

  const onScheduleFade = useEffectEvent(() => {
    if (!shouldShow || !hasText) {
      return
    }

    if (fadeTimeoutRef.current) {
      clearTimeout(fadeTimeoutRef.current)
    }

    const timeDisplayed = Date.now() - displayStartTimeRef.current
    const minDisplayTime = 3000
    const fadeDelay = 3000

    const remainingMinTime = Math.max(0, minDisplayTime - timeDisplayed)
    const totalWaitTime = remainingMinTime + fadeDelay

    fadeTimeoutRef.current = setTimeout(() => {
      setShouldShow(false)
      fadeTimeoutRef.current = null
    }, totalWaitTime)
  })

  // Handle fade-out logic when streaming stops
  useEffect(() => {
    if (!isStreaming) {
      onScheduleFade()
    }

    return () => {
      if (fadeTimeoutRef.current) {
        clearTimeout(fadeTimeoutRef.current)
        fadeTimeoutRef.current = null
      }
    }
  }, [isStreaming])

  const { scrollContainerRef, scrollTargetRef } = useAutoScroll({
    dependencies: [displayedText.length],
    smooth: true,
    isStreaming: false,
    rootMargin: '0px',
  })

  // Always render the container with min-height, but only show content when there's text
  return (
    <div className="relative mt-1 min-h-[200px]">
      <AnimatePresence mode="wait">
        {shouldShow && hasText && (
          <m.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3 }}
            className="relative text-muted-foreground leading-relaxed text-sm"
            ref={scrollContainerRef}
          >
            <div className="absolute top-0 w-full h-6 bg-gradient-to-b from-background to-transparent" />
            <div className="max-h-[200px] px-4 hide-scrollbar py-3">
              {displayedText}
              <div ref={scrollTargetRef} />
            </div>
            <div className="absolute bottom-0 w-full h-6 bg-gradient-to-b from-transparent to-background" />
          </m.div>
        )}
      </AnimatePresence>
    </div>
  )
}
