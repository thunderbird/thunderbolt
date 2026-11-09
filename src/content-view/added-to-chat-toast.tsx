/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { AnimatePresence, m, useReducedMotion } from 'framer-motion'
import { Check } from 'lucide-react'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useAddedToChatStore } from './added-to-chat-store'

const toastDurationMs = 3_000

/**
 * Confirms a picked element reached a composer that isn't on screen yet.
 *
 * Wears the Select button's pill, so the flow ends in the shape it started in.
 * Under the header on mobile, because the bottom edge is where the composer and
 * its new chip sit. Purely informational, so it never intercepts a touch.
 */
export const AddedToChatToast = () => {
  const { t } = useLingui()
  const isOpen = useAddedToChatStore((state) => state.isOpen)
  const shownCount = useAddedToChatStore((state) => state.shownCount)
  const dismiss = useAddedToChatStore((state) => state.dismiss)
  const message = t`Added to chat`
  const reducedMotion = useReducedMotion()

  useEffect(() => {
    if (!isOpen) {
      return
    }

    const timeoutId = window.setTimeout(dismiss, toastDurationMs)
    return () => window.clearTimeout(timeoutId)
  }, [isOpen, shownCount, dismiss])

  return createPortal(
    <>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {isOpen ? message : ''}
      </div>
      <div className="pointer-events-none fixed inset-x-0 z-50 flex justify-center px-4 max-md:top-[var(--header-inset)] md:bottom-4 md:justify-end">
        <AnimatePresence>
          {isOpen && (
            <m.div
              aria-hidden
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={reducedMotion ? { duration: 0 } : { type: 'tween', ease: [0.2, 0.9, 0.1, 1], duration: 0.25 }}
              className="flex h-[var(--touch-height-sm)] items-center gap-1.5 rounded-full bg-secondary px-3 text-[length:var(--font-size-sm)] font-medium text-secondary-foreground shadow-lg"
            >
              <Check className="size-[var(--icon-size-sm)] shrink-0" />
              {message}
            </m.div>
          )}
        </AnimatePresence>
      </div>
    </>,
    document.body,
  )
}
