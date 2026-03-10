import { getToolMetadata, getToolMetadataSync } from '@/lib/tool-metadata'
import { formatToolOutput, splitPartType } from '@/lib/utils'
import { useQuery } from '@tanstack/react-query'
import type { ToolUIPart } from 'ai'
import { Check, Loader2, X } from 'lucide-react'
import { memo } from 'react'
import { Expandable } from '../ui/expandable'

export type ToolPartProps = {
  part: ToolUIPart
}

const getToolIcon = (state: ToolUIPart['state']) => {
  const baseClass = 'h-4 w-4 flex-shrink-0'

  switch (state) {
    default:
    case 'input-streaming':
    case 'input-available':
      return <Loader2 className={`${baseClass} animate-spin text-blue-600 dark:text-blue-400`} />
    case 'output-available':
      return <Check className={`${baseClass} text-green-600 dark:text-green-400`} />
    case 'output-error':
      return <X className={`${baseClass} text-red-600 dark:text-red-400`} />
  }
}

export const ToolPart = memo(({ part }: ToolPartProps) => {
  const { type, input, state } = part
  const [, toolName] = splitPartType(type)

  // Use react-query to fetch metadata with proper caching
  const { data: metadata } = useQuery({
    queryKey: ['tool-metadata', toolName, JSON.stringify(input)],
    queryFn: async () => {
      const result = await getToolMetadata(toolName, input)
      return result
    },
    // Use sync version as placeholder data for immediate rendering
    placeholderData: () => getToolMetadataSync(toolName, input),
    staleTime: Infinity, // Tool metadata doesn't change during runtime
  })

  const titleNode = metadata ? (
    <span className="flex items-center gap-2 overflow-hidden">
      <span className="flex-shrink-0">{metadata.displayName}</span>
      {state === 'input-streaming' && (
        <span className="text-xs text-blue-600 dark:text-blue-400 italic animate-pulse truncate min-w-0">
          {metadata.loadingMessage}
        </span>
      )}
    </span>
  ) : (
    'Loading...'
  )

  return (
    <Expandable
      className="shadow-none tool-invocation-card rounded-[var(--radius-lg)] overflow-hidden transition-colors"
      icon={getToolIcon(state)}
      defaultOpen={false}
      title={titleNode}
    >
      <div className="tool-result w-full">
        <div className="rounded-[var(--radius-default)]">
          <p className="text-gray-700 dark:text-gray-300 text-sm whitespace-pre-wrap">
            {formatToolOutput(part.output)}
          </p>
        </div>
      </div>
    </Expandable>
  )
})
