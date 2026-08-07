/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCloudExecutionNoticeStore } from '@/acp/cloud-execution-notice'
import { Button } from '@/components/ui/button'
import { AnimatePresence, m } from 'framer-motion'
import { Cloud, X } from 'lucide-react'

export const CloudExecutionNotice = () => {
  const isVisible = useCloudExecutionNoticeStore((state) => state.isVisible)
  const dismiss = useCloudExecutionNoticeStore((state) => state.dismiss)

  return (
    <AnimatePresence>
      {isVisible && (
        <m.div
          key="cloud-execution-notice"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          className="fixed bottom-4 right-4 z-50 max-w-sm"
        >
          <div className="bg-card border border-border rounded-xl shadow-lg p-4">
            <div className="flex items-start gap-3">
              <Cloud className="size-[var(--icon-size-sm)] shrink-0 text-primary" />

              <div className="flex-1 min-w-0">
                <p className="text-[length:var(--font-size-sm)] font-medium text-foreground">
                  This chat runs in the cloud
                </p>
                <p className="text-[length:var(--font-size-xs)] text-muted-foreground mt-1">
                  Eligible chats are processed on Thunderbolt&apos;s servers, so they keep going even when you close the
                  app. Visual artifacts are checked there and verified when this app displays them.
                </p>
                <div className="flex mt-3">
                  <Button size="sm" onClick={dismiss}>
                    Got it
                  </Button>
                </div>
              </div>

              <button
                onClick={dismiss}
                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                aria-label="Dismiss"
              >
                <X className="size-[var(--icon-size-sm)]" />
              </button>
            </div>
          </div>
        </m.div>
      )}
    </AnimatePresence>
  )
}
