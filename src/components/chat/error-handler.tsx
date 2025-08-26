import { Button } from '@/components/ui/button'
import { AlertCircle, MessageSquare, Scissors } from 'lucide-react'

interface TokenLimitErrorDetails {
  tokens: number
  maxTokens: number
  contextWindow: number
  overhead: number
}

interface ErrorDetails {
  type?: string
  details?: TokenLimitErrorDetails
}

interface ChatErrorProps {
  error: Error & { details?: ErrorDetails }
  onRetry?: () => void
  onStartNewChat?: () => void
  onClearMessages?: () => void
}

function TokenLimitErrorMessage({ details, onStartNewChat, onClearMessages }: {
  details: TokenLimitErrorDetails
  onStartNewChat?: () => void
  onClearMessages?: () => void
}) {
  const overage = details.tokens - details.maxTokens
  const percentageOver = Math.round((overage / details.maxTokens) * 100)
  
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <AlertCircle className="h-5 w-5 text-destructive mt-0.5 flex-shrink-0" />
        <div className="space-y-2">
          <p className="text-destructive font-medium">Message Too Long</p>
          <div className="text-sm text-destructive/80 space-y-1">
            <p>
              Your conversation uses <strong>{details.tokens.toLocaleString()} tokens</strong> but the model can only handle <strong>{details.maxTokens.toLocaleString()} tokens</strong> for the input.
            </p>
            <p>
              That's <strong>{overage.toLocaleString()} tokens</strong> ({percentageOver}%) over the limit.
            </p>
          </div>
          
          <div className="text-xs text-muted-foreground pt-1">
            <p>Context window: {details.contextWindow.toLocaleString()} tokens</p>
            <p>Message overhead: {details.overhead} tokens</p>
          </div>
        </div>
      </div>
      
      <div className="flex flex-wrap gap-2 pt-2">
        {onStartNewChat && (
          <Button
            size="sm"
            onClick={onStartNewChat}
            className="flex items-center gap-2"
          >
            <MessageSquare className="h-4 w-4" />
            Start New Chat
          </Button>
        )}
        {onClearMessages && (
          <Button
            size="sm"
            variant="outline"
            onClick={onClearMessages}
            className="flex items-center gap-2"
          >
            <Scissors className="h-4 w-4" />
            Clear Messages
          </Button>
        )}
      </div>
    </div>
  )
}

function GenericErrorMessage({ error, onRetry }: {
  error: Error
  onRetry?: () => void
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <AlertCircle className="h-5 w-5 text-destructive mt-0.5 flex-shrink-0" />
        <div>
          <p className="text-destructive font-medium">Error</p>
          <p className="text-destructive/80 text-sm">
            {error.message || 'An unexpected error occurred. Please try again.'}
          </p>
        </div>
      </div>
      
      {onRetry && (
        <div className="pt-2">
          <Button size="sm" onClick={onRetry}>
            Try Again
          </Button>
        </div>
      )}
    </div>
  )
}

export function ChatErrorHandler({ error, onRetry, onStartNewChat, onClearMessages }: ChatErrorProps) {
  // Check if this is a token limit error
  if (error.details?.type === 'TOKEN_LIMIT_EXCEEDED' && error.details.details) {
    return (
      <div className="p-4 rounded-md bg-destructive/10 border border-destructive/20 mr-auto w-full">
        <TokenLimitErrorMessage 
          details={error.details.details}
          onStartNewChat={onStartNewChat}
          onClearMessages={onClearMessages}
        />
      </div>
    )
  }
  
  // Generic error handling
  return (
    <div className="p-4 rounded-md bg-destructive/10 border border-destructive/20 mr-auto w-full">
      <GenericErrorMessage error={error} onRetry={onRetry} />
    </div>
  )
}

// Utility function to parse and enhance error objects
export function enhanceError(error: unknown): Error & { details?: ErrorDetails } {
  if (error instanceof Error) {
    // Try to parse error details from the message if it looks like JSON
    if (error.message.startsWith('{')) {
      try {
        const parsed = JSON.parse(error.message)
        return Object.assign(error, { 
          message: parsed.error || error.message,
          details: {
            type: parsed.type,
            details: parsed.details
          }
        })
      } catch {
        // If parsing fails, just return the original error
      }
    }
    return error
  }
  
  // Convert non-Error objects to Error
  return new Error(typeof error === 'string' ? error : 'An unknown error occurred')
}