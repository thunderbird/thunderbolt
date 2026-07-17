/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { maxRetries } from '@/chats/chat-instance'
import { isContextOverflowError, isRateLimitError } from '@/lib/error-utils'
import { Loader2 } from 'lucide-react'
import { memo } from 'react'

type ErrorMessageProps = {
  retryCount: number
  retriesExhausted: boolean
  error?: Error | null
  onRetry?: () => void
  /** True when the turn failed on an unreadable attachment with no delivery mode
   *  left to try — shows file-specific guidance instead of the generic message. */
  deliveryExhausted?: boolean
}

export const ErrorMessage = memo(
  ({ retryCount, retriesExhausted, error, onRetry, deliveryExhausted }: ErrorMessageProps) => {
    const rateLimited = isRateLimitError(error)

    // Show rate limit message immediately — don't auto-retry since the server told us to slow down
    if (rateLimited) {
      return (
        <div className="px-4 py-3 rounded-2xl bg-amber-500/10 mr-auto w-full mt-2">
          <p className="text-amber-500/80 text-[length:var(--font-size-body)]">
            Too many requests. Please try again in a moment.
          </p>
        </div>
      )
    }

    // Context-window overflow — retrying won't help; guide the user to shrink the
    // request rather than show a generic error.
    if (isContextOverflowError(error)) {
      return (
        <div className="px-4 py-3 rounded-2xl bg-amber-500/10 mr-auto w-full mt-2">
          <p className="text-amber-500/80 text-[length:var(--font-size-body)]">
            This conversation is too large for the model&apos;s context window. Start a new chat, remove some
            attachments, or switch to a model with a larger context window.
          </p>
        </div>
      )
    }

    // Show spinner only when a retry is actively in progress (retryCount > 0).
    // retryCount === 0 means either stale error (page refresh) or fresh error
    // before onFinish has scheduled a retry — in both cases show the Retry button.
    if (retryCount > 0 && !retriesExhausted) {
      return (
        <div className="px-4 py-3 rounded-2xl bg-amber-500/10 mr-auto w-full mt-2">
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
      <div className="px-4 py-3 rounded-2xl bg-destructive/10 mr-auto w-full mt-2">
        <div className="flex items-center justify-between gap-2 min-h-[var(--touch-height-sm)]">
          <p className="text-destructive/80 text-[length:var(--font-size-body)]">
            {deliveryExhausted
              ? "This model couldn't read the attached file. Try a different model."
              : 'Something went wrong. Please try again.'}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {/* No Retry when delivery is exhausted — re-running identical input fails
                identically; the message directs the user to switch models instead. */}
            {onRetry && !deliveryExhausted && (
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
