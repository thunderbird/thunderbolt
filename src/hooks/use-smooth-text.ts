/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { messageRenderThrottleMs } from '@/chats/chat-throttle'
import { graphemeSegmenter } from '@/lib/segmenter'
import { advanceTextReveal } from '@/lib/text-reveal'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

/** Subscribe to the browser preference, including changes during a response. */
const subscribeReducedMotion = (callback: () => void) => {
  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  media.addEventListener('change', callback)
  return () => media.removeEventListener('change', callback)
}

/** Read the current OS motion preference. */
const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Create progress for one target, resetting both cursor and fractional time together. */
const createProgress = (target: string, revealed: number) => ({ target, revealed, carryMs: 0 })

/**
 * Pace a raw streaming prefix before parsing. Appends share one animation loop;
 * replacements restart it, and completion/reduced motion return the full source.
 * The SDK's message, persistence and copy text remain untouched.
 */
export const useSmoothText = (text: string, enabled: boolean): string => {
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion)
  const segmenter = graphemeSegmenter()
  const animate = enabled && !reducedMotion && segmenter !== null
  const [displayed, setDisplayed] = useState(() => (animate ? '' : text))
  const progressRef = useRef(createProgress(text, animate ? 0 : text.length))

  if (!text.startsWith(progressRef.current.target) || (!animate && progressRef.current.revealed !== text.length)) {
    progressRef.current = createProgress(text, animate ? 0 : text.length)
    if (displayed !== (animate ? '' : text)) {
      setDisplayed(animate ? '' : text)
    }
  }
  progressRef.current.target = text
  const progress = progressRef.current
  const running = animate && displayed !== text

  useEffect(() => {
    if (!running) {
      return
    }
    const clock = { frame: 0, lastFrameAt: Date.now(), lastCommitAt: Date.now() }
    const step = () => {
      const now = Date.now()
      Object.assign(progress, advanceTextReveal(progress, progress.target.length, now - clock.lastFrameAt))
      clock.lastFrameAt = now
      const caughtUp = progress.revealed === progress.target.length
      if (caughtUp || now - clock.lastCommitAt >= messageRenderThrottleMs) {
        clock.lastCommitAt = now
        const boundary = caughtUp
          ? progress.revealed
          : segmenter!.segment(progress.target).containing(progress.revealed)!.index
        setDisplayed(progress.target.slice(0, boundary))
      }
      if (caughtUp) {
        // Restart even if the final display commit and the next append are batched.
        progressRef.current = createProgress(progress.target, progress.revealed)
      } else {
        clock.frame = requestAnimationFrame(step)
      }
    }
    clock.frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(clock.frame)
  }, [running, progress, segmenter])

  return animate ? displayed : text
}
