import { Loader2 } from 'lucide-react'
import { memo } from 'react'

type ErrorMessageProps = {
  retriesExhausted: boolean
  onRetry?: () => void
}

export const ErrorMessage = memo(({ retriesExhausted, onRetry }: ErrorMessageProps) => {
  if (!retriesExhausted) {
    return (
      <div className="p-4 rounded-md bg-amber-500/10 border border-amber-500/20 mr-auto w-full mt-2">
        <div className="flex items-center gap-2">
          <Loader2 className="size-3.5 text-amber-500 animate-spin" />
          <p className="text-amber-500/80 text-sm">Hm, something went wrong. Retrying...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 rounded-md bg-destructive/10 border border-destructive/20 mr-auto w-full mt-2">
      <div className="flex items-center justify-between gap-3">
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
