import { memo } from 'react'

interface ErrorMessageProps {
  message: string | null
}

export const ErrorMessage = memo(({ message }: ErrorMessageProps) => {
  return (
    <div className="p-4 rounded-md bg-destructive/10 border border-destructive/20 mr-auto w-full mt-6">
      <p className="text-destructive font-medium mb-1">Error</p>
      <p className="text-destructive/80 text-sm">{message || 'An unexpected error occurred. Please try again.'}</p>
    </div>
  )
})
