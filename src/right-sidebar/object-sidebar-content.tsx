import { SidebarContent } from '@/components/ui/sidebar'
import { getToolMetadataSync } from '@/lib/tool-metadata'
import { splitPartType } from '@/lib/utils'
import type { ToolUIPart } from 'ai'
import { RightSidebarHeader } from './header'

const getOutput = (part: ToolUIPart) => {
  if (typeof part?.output === 'string') {
    return part?.output
  }
  return JSON.stringify(part?.output, null, 2)
}

type ObjectSidebarContentProps = {
  content: ToolUIPart
  onClose: () => void
}

/**
 * Content for displaying tool call results in the unified right sidebar
 */
export const ObjectSidebarContent = ({ content, onClose }: ObjectSidebarContentProps) => {
  const [, toolName] = splitPartType(content?.type ?? '')
  const metadata = getToolMetadataSync(toolName, content?.input)

  return (
    <div className="flex flex-col h-full">
      <RightSidebarHeader title={metadata.displayName} onClose={onClose} className="bg-card border-b border-border" />
      <SidebarContent className="p-4 overflow-x-hidden">
        <p className="text-gray-700 dark:text-gray-300 text-sm whitespace-pre-wrap">{getOutput(content)}</p>
      </SidebarContent>
    </div>
  )
}
