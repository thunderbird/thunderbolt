import { getToolMetadataSync } from '@/lib/tool-metadata'
import { cn, splitPartType } from '@/lib/utils'
import type { ToolUIPart } from 'ai'
import { motion } from 'framer-motion'
import { Loader2 } from 'lucide-react'
import { Avatar, AvatarFallback } from '../ui/avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { useObjectView } from './object-view-provider'

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
                <Avatar
                  className="border-2 border-background size-9 cursor-pointer"
                  onClick={() => !isLoading && !isError && openObjectSidebar(tool)}
                >
                  <AvatarFallback>
                    {isLoading ? (
                      <motion.div
                        key={`${tooltipKey}-loading`}
                        initial={{ scale: 0 }}
                        animate={{
                          scale: isLoading ? 1 : 0,
                        }}
                        exit={{ scale: 0 }}
                      >
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      </motion.div>
                    ) : Icon ? (
                      <motion.div
                        key={`${tooltipKey}-icon`}
                        initial={{ scale: 0 }}
                        animate={{
                          scale: isLoading ? 0 : 1,
                        }}
                        exit={{ scale: 0 }}
                      >
                        <Icon className={cn('size-4', isError && 'text-yellow-500')} />
                      </motion.div>
                    ) : (
                      metadata.initials
                    )}
                  </AvatarFallback>
                </Avatar>
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
