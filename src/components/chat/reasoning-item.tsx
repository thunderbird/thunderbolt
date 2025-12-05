import { type ReasoningGroupItem } from '@/lib/assistant-message'
import { Brain, DotIcon, Loader2 } from 'lucide-react'
import { formatDuration, splitPartType } from '@/lib/utils'
import { getToolMetadataSync } from '@/lib/tool-metadata'
import { type ReasoningUIPart, type ToolUIPart } from 'ai'

type ReasoningItemProps = {
  part: ReasoningGroupItem
  onClick: () => void
  reasoningTime?: { startedAt?: number; finishedAt?: number }
}

const getItemData = (part: ReasoningGroupItem) => {
  switch (part.type) {
    case 'reasoning': {
      const reasoningPart = part.content as ReasoningUIPart

      return {
        Icon: Brain,
        displayName: 'Thinking',
        isLoading: reasoningPart.state === 'streaming',
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
        isLoading: toolPart.state !== 'output-available' && toolPart.state !== 'output-error',
        duration: (toolPart as any).metadata?.duration,
      }
    }

    default:
      return null
  }
}

export const ReasoningItem = ({ part, onClick, reasoningTime }: ReasoningItemProps) => {
  const itemData = getItemData(part)

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
        {reasoningTime?.finishedAt && reasoningTime?.startedAt
          ? formatDuration(reasoningTime.finishedAt - reasoningTime.startedAt)
          : itemData.isLoading
            ? '...'
            : '—'}
      </span>
    </button>
  )
}
