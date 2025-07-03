import { getToolMetadata } from '@/lib/tool-metadata'
import type { ToolInvocationUIPart } from 'ai'
import { Check, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react'
import { useState } from 'react'
import { ChatMessagePreview } from './message-preview'

export type AgentToolResponseProps = {
  part: ToolInvocationUIPart
}

function getToolIcon(status: 'running' | 'complete' | 'error') {
  const iconClass = 'h-4 w-4 flex-shrink-0'

  switch (status) {
    case 'complete':
      return <Check className={`${iconClass} text-green-600 dark:text-green-400`} />
    case 'error':
      return <X className={`${iconClass} text-red-600 dark:text-red-400`} />
    case 'running':
    default:
      return <Check className={`${iconClass} text-gray-400 dark:text-gray-500`} />
  }
}

function getStatusColor(status: 'running' | 'complete' | 'error') {
  switch (status) {
    case 'running':
      return 'border-blue-200 bg-blue-50 dark:bg-blue-950/30'
    case 'complete':
      return 'border-green-200 bg-green-50 dark:bg-green-950/30'
    case 'error':
      return 'border-red-200 bg-red-50 dark:bg-red-950/30'
    default:
      return 'border-gray-200 bg-gray-50 dark:bg-gray-950/30'
  }
}

export const AgentToolResponse = ({ part }: AgentToolResponseProps) => {
  // Get metadata using function-based approach (synchronous)
  const metadata = getToolMetadata(part.toolInvocation.toolName, part.toolInvocation.args)
  const [isCollapsed, setIsCollapsed] = useState(true)

  // Determine status based on the tool invocation state
  const toolInvocation = part.toolInvocation
  const hasResult = 'result' in toolInvocation
  const hasError = 'error' in toolInvocation
  const status: 'running' | 'complete' | 'error' = hasError ? 'error' : hasResult ? 'complete' : 'running'

  const renderResults = (results: any) => {
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
      if ('error' in results) {
        return (
          <div className="p-3 bg-red-50 dark:bg-red-950/30 rounded-md">
            <p className="text-red-700 dark:text-red-300 text-sm">Error: {results.error}</p>
          </div>
        )
      }

      // Handle success results with data
      if ('success' in results && results.success) {
        return (
          <div className="p-3 bg-green-50 dark:bg-green-950/30 rounded-md">
            <p className="text-green-700 dark:text-green-300 text-sm">✓ Operation completed successfully</p>
          </div>
        )
      }

      // Handle other object results
      return (
        <div className="p-3 bg-gray-50 dark:bg-gray-950/30 rounded-md">
          <pre className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
            {JSON.stringify(results, null, 2)}
          </pre>
        </div>
      )
    }

    // Handle string results
    if (typeof results === 'string') {
      return (
        <div className="p-3 bg-gray-50 dark:bg-gray-950/30 rounded-md">
          <p className="text-gray-700 dark:text-gray-300 text-sm whitespace-pre-wrap">{results}</p>
        </div>
      )
    }

    return null
  }

  // Get the result data based on the tool invocation
  const getResultData = () => {
    if ('result' in toolInvocation) {
      return (toolInvocation as any).result
    }
    if ('error' in toolInvocation) {
      return { error: (toolInvocation as any).error || 'An error occurred' }
    }
    return null
  }

  const resultData = getResultData()

  return (
    <div
      className={`tool-invocation-card border rounded-lg overflow-hidden transition-colors ${getStatusColor(status)}`}
    >
      <div
        className="tool-header p-2.5 flex justify-between items-center cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <div className="tool-info flex items-center gap-3 min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {getToolIcon(status)}
            {status === 'running' && <Loader2 className="h-3 w-3 animate-spin text-blue-600 dark:text-blue-400" />}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm text-gray-900 dark:text-gray-100 truncate">
                {metadata.displayName}
              </span>
            </div>

            {status === 'running' && (
              <div className="text-xs text-blue-600 dark:text-blue-400 italic animate-pulse">
                {metadata.loadingMessage}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {resultData && (
            <button
              className="p-1 hover:bg-black/10 dark:hover:bg-white/10 rounded transition-colors"
              onClick={(e) => {
                e.stopPropagation()
                setIsCollapsed(!isCollapsed)
              }}
            >
              {isCollapsed ? (
                <ChevronRight className="h-4 w-4 text-gray-500" />
              ) : (
                <ChevronDown className="h-4 w-4 text-gray-500" />
              )}
            </button>
          )}
        </div>
      </div>

      {!isCollapsed && resultData && <div className="tool-result p-3">{renderResults(resultData)}</div>}
    </div>
  )
}
