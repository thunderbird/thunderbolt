import { getToolMetadata, getToolMetadataSync } from '@/lib/tool-metadata'
import { useQuery } from '@tanstack/react-query'
import type { ToolInvocationUIPart } from 'ai'
import { Check, Loader2, X } from 'lucide-react'
import { Expandable } from '../ui/expandable'
import { ChatMessagePreview } from './message-preview'

export type ToolInvocationPartProps = {
  part: ToolInvocationUIPart
  isStreaming: boolean
}

function getToolIcon(status: 'running' | 'complete' | 'error') {
  const baseClass = 'h-4 w-4 flex-shrink-0'

  switch (status) {
    case 'running':
      return <Loader2 className={`${baseClass} animate-spin text-blue-600 dark:text-blue-400`} />
    case 'complete':
      return <Check className={`${baseClass} text-green-600 dark:text-green-400`} />
    case 'error':
      return <X className={`${baseClass} text-red-600 dark:text-red-400`} />
    default:
      return null
  }
}

export const ToolInvocationPart = ({ part }: ToolInvocationPartProps) => {
  const { toolName, args } = part.toolInvocation

  // Use react-query to fetch metadata with proper caching
  const { data: metadata } = useQuery({
    queryKey: ['tool-metadata', toolName, JSON.stringify(args)],
    queryFn: async () => {
      const result = await getToolMetadata(toolName, args)
      return result
    },
    // Use sync version as placeholder data for immediate rendering
    placeholderData: () => getToolMetadataSync(toolName, args),
    staleTime: Infinity, // Tool metadata doesn't change during runtime
  })

  // Determine status based on the tool invocation state
  const toolInvocation = part.toolInvocation
  const hasResult = 'result' in toolInvocation
  const hasError = 'error' in toolInvocation
  const status: 'running' | 'complete' | 'error' = hasError ? 'error' : hasResult ? 'complete' : 'running'

  const renderResults = (results: unknown) => {
    if (!results) return null

    // Handle different result types
    if (Array.isArray(results)) {
      return (
        <div className="space-y-3">
          {results.map((result, index) => (
            <ChatMessagePreview key={index} imapId={result} />
          ))}
        </div>
      )
    }

    if (typeof results === 'object') {
      // Handle error results
      if ('error' in results && results.error) {
        return (
          <div className="bg-red-50 dark:bg-red-950/30 rounded-md">
            <p className="text-red-700 dark:text-red-300 text-sm">Error: {String(results.error)}</p>
          </div>
        )
      }

      // Handle success results with data
      if ('success' in results && results.success) {
        return (
          <div className="bg-green-50 dark:bg-green-950/30 rounded-md">
            <p className="text-green-700 dark:text-green-300 text-sm">✓ Operation completed successfully</p>
          </div>
        )
      }

      // Handle other object results
      return (
        <div className="rounded-md">
          <pre className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
            {JSON.stringify(results, null, 2)}
          </pre>
        </div>
      )
    }

    // Handle string results
    if (typeof results === 'string') {
      return (
        <div className="rounded-md">
          <p className="text-gray-700 dark:text-gray-300 text-sm whitespace-pre-wrap">{results}</p>
        </div>
      )
    }

    return null
  }

  // Get the result data based on the tool invocation
  const getResultData = () => {
    if ('result' in toolInvocation) {
      return toolInvocation.result
    }
    if ('error' in toolInvocation) {
      return { error: toolInvocation.error || 'An error occurred' }
    }
    return null
  }

  const resultData = getResultData()

  const titleNode = metadata ? (
    <span className="flex items-center gap-2 overflow-hidden">
      <span className="flex-shrink-0">{metadata.displayName}</span>
      {status === 'running' && (
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
      className="shadow-none tool-invocation-card rounded-lg overflow-hidden transition-colors"
      icon={getToolIcon(status)}
      defaultOpen={false}
      title={titleNode}
    >
      {resultData && <div className="tool-result w-full">{renderResults(resultData)}</div>}
    </Expandable>
  )
}
