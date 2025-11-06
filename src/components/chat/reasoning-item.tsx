import { type ReasoningGroupItem } from '@/lib/assistant-message'
import { Brain, DotIcon, Loader2 } from 'lucide-react'
import { formatDuration, splitPartType } from '@/lib/utils'
import { getToolMetadataSync } from '@/lib/tool-metadata'
import { type ReasoningUIPart, type ToolUIPart } from 'ai'
import { useObjectView } from '@/content-view/context'

type ReasoningItemProps = {
  part: ReasoningGroupItem
  onChangeDuration(duration: number): void
}

const getItemData = (part: ReasoningGroupItem) => {
  switch (part.type) {
    case 'reasoning': {
      const reasoningPart = part.content as ReasoningUIPart

      return {
        Icon: Brain,
        displayName: 'Thinking',
        isLoading: reasoningPart.state === 'streaming',
        duration: reasoningPart.metadata?.duration,
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
        duration: toolPart.metadata?.duration,
      }
    }

    default:
      return null
  }
}

export const ReasoningItem = ({ onChangeDuration, part }: ReasoningItemProps) => {
  const itemData = getItemData(part)

  const { openObjectSidebar } = useObjectView()

  if (!itemData) {
    return null
  }

  const Icon = itemData.Icon

  return (
    <button
      onClick={() => openObjectSidebar(part.content as ToolUIPart | ReasoningUIPart)}
      className="flex items-center w-full py-2 px-3 hover:bg-accent/50 rounded-md transition-colors group text-left"
    >
      <div className="flex gap-3 flex-row flex-1 items-center">
        {itemData.isLoading ? (
          <Loader2 className={`h-4 w-4 animate-spin text-blue-600 dark:text-blue-400`} />
        ) : (
          !!Icon && <Icon className="h-4 w-4 text-muted-foreground" />
        )}
        <span className="text-sm font-medium truncate text-foreground">{itemData.displayName}</span>
      </div>
      <span className="text-xs text-muted-foreground flex-shrink-0">
        {itemData.duration ? formatDuration(itemData.duration) : itemData.isLoading ? '...' : '—'}
      </span>
    </button>
  )
}
