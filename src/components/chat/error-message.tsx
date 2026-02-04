import { maxRetries } from '@/chats/chat-instance'
import { Loader2 } from 'lucide-react'
import { memo } from 'react'

type ErrorMessageProps = {
  retryCount: number
  retriesExhausted: boolean
  onRetry?: () => void
}

export const ErrorMessage = memo(({ retryCount, retriesExhausted, onRetry }: ErrorMessageProps) => {
  // Show spinner only when a retry is actively in progress (retryCount > 0).
  // retryCount === 0 means either stale error (page refresh) or fresh error
  // before onFinish has scheduled a retry — in both cases show the Retry button.
  if (retryCount > 0 && !retriesExhausted) {
    return (
      <div className="px-4 py-3 rounded-md bg-amber-500/10 border border-amber-500/20 mr-auto w-full mt-2">
        <div className="flex items-center gap-2">
          <Loader2 className="size-3.5 text-amber-500 animate-spin" />
          <p className="text-amber-500/80 text-sm">
            Something went wrong. Retrying ({retryCount}/{maxRetries})...
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="px-4 py-3 rounded-md bg-destructive/10 border border-destructive/20 mr-auto w-full mt-2">
      <div className="flex items-center justify-between gap-3 min-h-8">
        <p className="text-destructive/80 text-sm">Something went wrong. Please try again.</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="cursor-pointer shrink-0 text-sm font-medium text-destructive/90 bg-destructive/10 hover:bg-destructive/15 px-3 py-1.5 rounded-md"
          >
            Retry
          </button>
        )}
      </div>
    </div>
  )
})
