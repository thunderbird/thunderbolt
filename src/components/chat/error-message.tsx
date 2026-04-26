import { maxRetries } from '@/chats/constants'
import { isRateLimitError } from '@/lib/error-utils'
import { Loader2 } from 'lucide-react'
import { memo } from 'react'

type ErrorMessageProps = {
  retryCount: number
  retriesExhausted: boolean
  error?: Error | null
  onRetry?: () => void
}

export const ErrorMessage = memo(({ retryCount, retriesExhausted, error, onRetry }: ErrorMessageProps) => {
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
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="cursor-pointer shrink-0 text-[length:var(--font-size-body)] font-medium text-destructive/90 bg-destructive/10 hover:bg-destructive/15 px-3 py-1 rounded-xl"
          >
            Retry
          </button>
        )}
      </div>
    </div>
  )
})
