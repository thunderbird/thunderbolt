import { type ReasoningGroupItem } from '@/lib/assistant-message'
import { getToolMetadataSync } from '@/lib/tool-metadata'
import { formatDuration, splitPartType } from '@/lib/utils'
import { type ReasoningUIPart, type ToolUIPart } from 'ai'
import { Brain, DotIcon, Loader2 } from 'lucide-react'

type ReasoningItemProps = {
  part: ReasoningGroupItem
  onClick: () => void
  reasoningTime?: number
  isGroupReasoning: boolean
}

const getItemData = (part: ReasoningGroupItem, isGroupReasoning: boolean) => {
  switch (part.type) {
    case 'reasoning': {
      const reasoningPart = part.content as ReasoningUIPart

      return {
        Icon: Brain,
        displayName: 'Thinking',
        isLoading: isGroupReasoning && reasoningPart.state === 'streaming',
        duration: (reasoningPart as any).metadata?.duration,
      }
    }

    case 'tool': {
      const toolPart = part.content as ToolUIPart
      const [, toolName] = splitPartType(toolPart.type)
      const metadata = getToolMetadataSync(toolName)

      return {
        Icon: metadata.icon || DotIcon,
        displayName: metadata.displayName,
        isLoading: isGroupReasoning && toolPart.state !== 'output-available' && toolPart.state !== 'output-error',
        duration: (toolPart as any).metadata?.duration,
      }
    }

    default:
      return null
  }
}

export const ReasoningItem = ({ part, onClick, reasoningTime, isGroupReasoning }: ReasoningItemProps) => {
  const itemData = getItemData(part, isGroupReasoning)

  if (!itemData) {
    return null
  }

  const Icon = itemData.Icon

  return (
    <button
      onClick={onClick}
      className="flex items-center w-full py-2 px-3 hover:bg-accent/50 rounded-md transition-colors group text-left"
    >
      <div className="flex gap-3 flex-row flex-1 items-center">
        {itemData.isLoading ? (
          <Loader2 className={`h-4 w-4 animate-spin text-muted-foreground`} />
        ) : (
          !!Icon && <Icon className="h-4 w-4 text-muted-foreground" />
        )}
        <span className="text-sm font-medium truncate text-foreground">{itemData.displayName}</span>
      </div>
      <span className="text-xs text-muted-foreground flex-shrink-0">
        {reasoningTime ? formatDuration(reasoningTime) : itemData.isLoading ? '...' : '—'}
      </span>
    </button>
  )
}
