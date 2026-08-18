/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { AnimatePresence, m } from 'framer-motion'
import { CheckCircle2, X } from 'lucide-react'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'

type ShareDebugTranscriptToastProps = {
  open: boolean
  onDismiss: () => void
}

const successToastDurationMs = 4_000

export const ShareDebugTranscriptToast = ({ open, onDismiss }: ShareDebugTranscriptToastProps) => {
  useEffect(() => {
    if (!open) {
      return
    }

    const timeoutId = window.setTimeout(onDismiss, successToastDurationMs)
    return () => window.clearTimeout(timeoutId)
  }, [open, onDismiss])

  return createPortal(
    <>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {open ? 'Debug transcript sent.' : ''}
      </div>
      <AnimatePresence>
        {open && (
          <m.div
            key="share-debug-transcript-toast"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed inset-x-4 bottom-4 z-50 md:right-4 md:left-auto md:max-w-sm"
          >
            <div className="rounded-xl border border-border bg-card p-4 shadow-lg">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="size-5 shrink-0 text-primary" />
                <p className="min-w-0 flex-1 text-[length:var(--font-size-sm)] font-medium text-foreground">
                  Debug transcript sent.
                </p>
                <Button variant="ghost" size="icon-xs" onClick={onDismiss} aria-label="Dismiss notification">
                  <X className="size-4" />
                </Button>
              </div>
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </>,
    document.body,
  )
}
