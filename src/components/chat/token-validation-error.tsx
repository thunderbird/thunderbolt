import { AlertTriangle, X } from 'lucide-react'
import { Button } from '../ui/button'
import { cn } from '@/lib/utils'

interface TokenValidationErrorProps {
  errorMessage: string
  currentTokens: number
  maxTokens: number
  newMessageTokens: number
  onDismiss?: () => void
  className?: string
}

export function TokenValidationError({
  errorMessage,
  currentTokens,
  maxTokens,
  newMessageTokens,
  onDismiss,
  className
}: TokenValidationErrorProps) {
  const percentage = Math.round(((currentTokens + newMessageTokens) / maxTokens) * 100)
  
  return (
    <div className={cn(
      'p-4 rounded-md bg-destructive/10 border border-destructive/20 w-full',
      className
    )}>
      <div className="flex items-start gap-3">
        <AlertTriangle className="size-5 text-destructive flex-shrink-0 mt-0.5" />
        
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-destructive font-medium">Message Too Long</h4>
            {onDismiss && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onDismiss}
                className="h-6 w-6 p-0 text-destructive/70 hover:text-destructive"
              >
                <X className="size-4" />
              </Button>
            )}
          </div>
          
          <p className="text-destructive/80 text-sm mb-3">
            {errorMessage}
          </p>
          
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Current conversation:</span>
              <span className="font-mono">{currentTokens.toLocaleString()} tokens</span>
            </div>
            
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">New message:</span>
              <span className="font-mono">{newMessageTokens.toLocaleString()} tokens</span>
            </div>
            
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Total:</span>
              <span className="font-mono text-destructive">
                {(currentTokens + newMessageTokens).toLocaleString()} / {maxTokens.toLocaleString()} tokens ({percentage}%)
              </span>
            </div>
            
            <div className="w-full bg-muted rounded-full h-2 mt-2">
              <div 
                className="bg-destructive h-2 rounded-full transition-all duration-300"
                style={{ width: `${Math.min(percentage, 100)}%` }}
              />
            </div>
          </div>
          
          <div className="mt-3 text-xs text-muted-foreground">
            <p className="font-medium mb-1">Suggestions:</p>
            <ul className="space-y-1 list-disc list-inside">
              <li>Start a new conversation to reset the context</li>
              <li>Shorten your message by removing unnecessary details</li>
              <li>Break your request into smaller, focused questions</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}