import type { ReasoningUIPart } from 'ai'
import { Check, Loader2 } from 'lucide-react'
import { Expandable } from '../ui/expandable'

interface ReasoningPartProps {
  part: ReasoningUIPart
}

export const ReasoningPart = ({ part }: ReasoningPartProps) => {
  const state = part.state
  const isStreaming = state === 'streaming'

  return (
    <Expandable
      title={<span className="text-muted-foreground">Thinking</span>}
      className="shadow-none"
      icon={
        isStreaming ? (
          <Loader2 className="h-4 w-4 animate-spin text-blue-600 dark:text-blue-400" data-testid="reasoning-loading" />
        ) : (
          <Check className="h-4 w-4 text-green-600 dark:text-green-400" data-testid="reasoning-completed" />
        )
      }
      defaultOpen={false}
    >
      {null}
    </Expandable>
  )
}
