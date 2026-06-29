/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { maxRetries } from '@/chats/chat-instance'
import { isRateLimitError } from '@/lib/error-utils'
import { Loader2 } from 'lucide-react'
import { memo } from 'react'

type ErrorMessageProps = {
  retryCount: number
  retriesExhausted: boolean
  error?: Error | null
  onRetry?: () => void
  /** Present when the failed turn has attachment(s) we can re-deliver as extracted
   *  text — renders a "Convert to text & retry" remediation alongside Retry. */
  onRetryAsText?: () => void
  /** Present when the failed turn has attachment(s) we can re-deliver as page
   *  images (e.g. a scanned PDF) — renders a "Send as images & retry" remediation. */
  onRetryAsImages?: () => void
}

export const ErrorMessage = memo(
  ({ retryCount, retriesExhausted, error, onRetry, onRetryAsText, onRetryAsImages }: ErrorMessageProps) => {
    const rateLimited = isRateLimitError(error)

    // Show rate limit message immediately — don't auto-retry since the server told us to slow down
    if (rateLimited) {
      return (
        <div className="px-4 py-3 rounded-2xl bg-amber-500/10 border border-amber-500/20 mr-auto w-full mt-2">
          <p className="text-amber-500/80 text-[length:var(--font-size-body)]">
            Too many requests. Please try again in a moment.
          </p>
        </div>
      )
    }

    // Show spinner only when a retry is actively in progress (retryCount > 0).
    // retryCount === 0 means either stale error (page refresh) or fresh error
    // before onFinish has scheduled a retry — in both cases show the Retry button.
    if (retryCount > 0 && !retriesExhausted) {
      return (
        <div className="px-4 py-3 rounded-2xl bg-amber-500/10 border border-amber-500/20 mr-auto w-full mt-2">
          <div className="flex items-center gap-2">
            <Loader2 className="size-[var(--icon-size-sm)] text-amber-500 animate-spin" />
            <p className="text-amber-500/80 text-[length:var(--font-size-body)]">
              Something went wrong. Retrying ({retryCount}/{maxRetries})...
            </p>
          </div>
        </div>
      )
    }

    return (
      <div className="px-4 py-3 rounded-2xl bg-destructive/10 border border-destructive/20 mr-auto w-full mt-2">
        <div className="flex items-center justify-between gap-2 min-h-[var(--touch-height-sm)]">
          <p className="text-destructive/80 text-[length:var(--font-size-body)]">
            Something went wrong. Please try again.
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {onRetryAsText && (
              <button
                type="button"
                onClick={onRetryAsText}
                className="cursor-pointer text-[length:var(--font-size-body)] font-medium text-destructive/90 bg-destructive/10 hover:bg-destructive/15 px-3 py-1 rounded-xl"
              >
                Convert to text & retry
              </button>
            )}
            {onRetryAsImages && (
              <button
                type="button"
                onClick={onRetryAsImages}
                className="cursor-pointer text-[length:var(--font-size-body)] font-medium text-destructive/90 bg-destructive/10 hover:bg-destructive/15 px-3 py-1 rounded-xl"
              >
                Send as images & retry
              </button>
            )}
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="cursor-pointer text-[length:var(--font-size-body)] font-medium text-destructive/90 bg-destructive/10 hover:bg-destructive/15 px-3 py-1 rounded-xl"
              >
                Retry
              </button>
            )}
          </div>
        </div>
      </div>
    )
  },
)
