import { Component, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { generateSupportEmail } from '@/lib/utils'
import type { HandleError } from '@/types/handle-errors'

type ErrorBoundaryProps = {
  children: ReactNode
}

type ErrorBoundaryState = {
  hasError: boolean
  error: Error | null
}

/**
 * Error Boundary component to catch errors in React component trees.
 * Handles both lazy loading errors (chunk load failures) and runtime errors.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  render() {
    if (this.state.hasError && this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center w-full h-[100vh] p-4">
          <div className="text-red-500 text-center mb-4">Something went wrong</div>
          <div className="text-sm text-gray-500 text-center mb-6">{this.state.error.message}</div>

          <div className="flex flex-col gap-3">
            <Button
              variant="outline"
              onClick={() => {
                window.location.reload()
              }}
            >
              Reload
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                const error: HandleError = {
                  code: 'UNKNOWN_ERROR',
                  message: this.state.error?.message ?? 'Unknown error',
                  originalError: this.state.error,
                  stackTrace: this.state.error?.stack ?? 'No stack trace available',
                }
                const { subject, body } = generateSupportEmail(error)
                window.open(`mailto:support@thunderbird.net?subject=${subject}&body=${body}`)
              }}
            >
              Contact Support
            </Button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
