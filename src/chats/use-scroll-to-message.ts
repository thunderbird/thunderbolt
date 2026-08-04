/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConsumeNavState } from '@/hooks/use-consume-nav-state'
import type { ThunderboltUIMessage } from '@/types'
import { useEffect, useState } from 'react'
import { scrollToMessageStateKey } from './scroll-to-message-intent'

/** Class that flashes a message element once (see `@utility animate-message-flash` in index.css). */
const messageFlashClass = 'animate-message-flash'

/**
 * Frames to keep polling for the target element before giving up. The message
 * list is lazy + Suspense-gated, so `[data-message-id]` nodes appear a commit
 * or two after hydration completes; ~2s at 60fps covers a slow chunk load.
 */
const maxRetryFrames = 120

type UseScrollToMessageProps = {
  /** The scroll container element (null until the ref attaches). */
  scrollContainer: HTMLElement | null
  /** Pins the message with the given id near the top; returns false if the container isn't ready. */
  scrollToMessage: (messageId: string) => boolean
  /** Re-run signal: the effect retries the lookup whenever the rendered message set changes. */
  messages: ThunderboltUIMessage[]
}

/**
 * Consumes a `scrollToMessageStateKey` deep link (from the Cmd+K search palette)
 * and, once the target message is actually in the DOM, scrolls to it and flashes
 * it. Waits for the element with a bounded `requestAnimationFrame` retry so the
 * `scrollToMessage` fallback-to-bottom trap (selector miss on a not-yet-mounted
 * message) can't fire. Re-fires cleanly when a new target arrives on an already-
 * open chat (the consume hook fires again on the new router state).
 */
export const useScrollToMessage = ({ scrollContainer, scrollToMessage, messages }: UseScrollToMessageProps): void => {
  // A monotonic token distinguishes "same message id selected again" from "no
  // change", so re-selecting the currently-shown message still re-triggers.
  const [target, setTarget] = useState<{ id: string; token: number } | null>(null)

  useConsumeNavState(scrollToMessageStateKey, (id) => setTarget((prev) => ({ id, token: (prev?.token ?? 0) + 1 })))

  useEffect(() => {
    if (!target || !scrollContainer) {
      return
    }

    const selector = `[data-message-id="${target.id}"]`
    let frameId: number | null = null
    let framesLeft = maxRetryFrames

    const attempt = () => {
      const element = scrollContainer.querySelector(selector)

      if (element) {
        scrollToMessage(target.id)
        element.classList.add(messageFlashClass)
        element.addEventListener('animationend', () => element.classList.remove(messageFlashClass), { once: true })
        setTarget(null)
        return
      }

      if (framesLeft <= 0) {
        // The list isn't virtualized, so exhausting the retries means the message
        // genuinely isn't in this thread (stale/soft-deleted/wrong-thread deep
        // link) — log so a broken jump-to-message link is debuggable.
        console.warn(`[scroll] message "${target.id}" not found after ${maxRetryFrames} frames; skipping scroll`)
        setTarget(null)
        return
      }

      framesLeft -= 1
      frameId = requestAnimationFrame(attempt)
    }

    frameId = requestAnimationFrame(attempt)

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId)
      }
    }
  }, [target, scrollContainer, scrollToMessage, messages])
}
