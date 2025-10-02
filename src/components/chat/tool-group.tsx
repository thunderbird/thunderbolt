import { getToolMetadataSync } from '@/lib/tool-metadata'
import { splitPartType } from '@/lib/utils'
import type { ToolUIPart } from 'ai'
import { motion } from 'framer-motion'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { useObjectView } from './object-view-provider'
import { ToolIcon } from './tool-icon'

type ToolGroupProps = {
  tools: ToolUIPart[]
}

export const ToolGroup = ({ tools }: ToolGroupProps) => {
  const { openObjectSidebar } = useObjectView()

  return (
    <div className="*:data-[slot=avatar]:ring-background flex -space-x-2 -space-y-2 *:data-[slot=avatar]:ring-2 *:data-[slot=avatar]:grayscale p-1 my-4 flex-wrap">
      {tools.map((tool, index) => {
        const [, toolName] = splitPartType(tool.type)
        const metadata = getToolMetadataSync(toolName, tool.input)
        const Icon = metadata.icon
        const isError = tool.state === 'output-error'
        const isLoading = (tool.state !== 'output-available' || !tool.output) && !isError
        const tooltipKey = tool.toolCallId ?? `${toolName}-${index}`

        return (
          <Tooltip key={tooltipKey}>
            <TooltipTrigger asChild>
              <motion.div
                initial={{ scale: 0 }}
                animate={{
                  scale: 1,
                }}
              >
                <ToolIcon
                  toolName={toolName}
                  toolOutput={tool.output}
                  Icon={Icon}
                  initials={metadata.initials}
                  isLoading={isLoading}
                  isError={isError}
                  tooltipKey={tooltipKey}
                  onClick={() => !isLoading && !isError && openObjectSidebar(tool)}
                />
              </motion.div>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p className="font-medium">{metadata.displayName}</p>
              {isLoading ? <p className="text-xs text-muted-foreground">{metadata.loadingMessage}</p> : null}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
