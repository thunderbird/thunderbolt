import { getToolMetadataSync } from '@/lib/tool-metadata'
import { Clock, Zap } from 'lucide-react'
import { Expandable } from '../ui/expandable'

export type ToolInfo = {
  name: string
  args?: any
  startTime: number
  endTime: number
}

export type ToolsSummaryPartProps = {
  toolCount: number
  duration: number // in milliseconds
  tools?: ToolInfo[]
}

const formatDuration = (ms: number): string => {
  const seconds = ms / 1000
  if (seconds < 1) {
    return `${Math.round(ms)}ms`
  }
  return `${seconds.toFixed(1)}s`
}

export const ToolsSummaryPart = ({ toolCount, duration, tools = [] }: ToolsSummaryPartProps) => {
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
      <div className="space-y-3">
        {tools.length > 0 ? (
          <div className="relative">
            {tools.map((tool, index) => {
              const toolDuration = tool.endTime - tool.startTime
              const metadata = getToolMetadataSync(tool.name, tool.args)
              const displayName = metadata?.displayName || tool.name
              
              return (
                <div key={index} className="relative flex items-start gap-3 text-sm mb-6 last:mb-0">
                  <div className="relative flex flex-col items-center">
                    <div className="h-2 w-2 rounded-full bg-blue-600 dark:bg-blue-400 flex-shrink-0 mt-1 z-10 bg-background" />
                    {index < tools.length - 1 && (
                      <div className="w-px bg-border absolute top-3 h-8" />
                    )}
                  </div>
                  <div className="flex-1 pt-0.5">
                    <div className="font-medium text-foreground">{displayName}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatDuration(toolDuration)}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
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
        )}
      </div>
    </Expandable>
  )
}