import { Clock, Zap } from 'lucide-react'
import { Expandable } from '../ui/expandable'

export type ToolsSummaryPartProps = {
  toolCount: number
  duration: number // in milliseconds
}

const formatDuration = (ms: number): string => {
  const seconds = ms / 1000
  if (seconds < 1) {
    return `${Math.round(ms)}ms`
  }
  return `${seconds.toFixed(1)}s`
}

export const ToolsSummaryPart = ({ toolCount, duration }: ToolsSummaryPartProps) => {
  const icon = <Zap className="h-4 w-4 text-green-600 dark:text-green-400" />
  
  const title = (
    <span className="flex items-center gap-2 text-green-700 dark:text-green-300">
      <span>Used {toolCount} tool{toolCount !== 1 ? 's' : ''} in {formatDuration(duration)}</span>
    </span>
  )

  return (
    <Expandable
      className="shadow-none tool-summary-card rounded-lg overflow-hidden transition-colors"
      icon={icon}
      defaultOpen={false}
      title={title}
    >
      <div className="space-y-2 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <Clock className="h-3 w-3" />
          <span>Total execution time: {formatDuration(duration)}</span>
        </div>
        <div className="flex items-center gap-2">
          <Zap className="h-3 w-3" />
          <span>{toolCount} tool invocation{toolCount !== 1 ? 's' : ''} completed</span>
        </div>
      </div>
    </Expandable>
  )
}