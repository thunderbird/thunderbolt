import { getToolMetadataSync } from '@/lib/tool-metadata'
import { splitPartType } from '@/lib/utils'
import type { ToolUIPart } from 'ai'
import { Loader2 } from 'lucide-react'
import { memo } from 'react'
import { Avatar, AvatarFallback } from '../ui/avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { motion } from 'framer-motion'
import { toolCallDetailsRef } from './tool-call-details'

type ToolGroupProps = {
  tools: ToolUIPart[]
}

export const ToolGroup = memo(({ tools }: ToolGroupProps) => {
  return (
    <div className="*:data-[slot=avatar]:ring-background flex -space-x-2 *:data-[slot=avatar]:ring-2 *:data-[slot=avatar]:grayscale p-1 my-4">
      {tools.map((tool, index) => {
        const [, toolName] = splitPartType(tool.type)
        const metadata = getToolMetadataSync(toolName, tool.input)
        const Icon = metadata.icon
        const isLoading = tool.state !== 'output-available' || !tool.output
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
                  className="border-2 border-background size-11 cursor-pointer"
                  onClick={() => toolCallDetailsRef.current?.open(tool)}
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
                        <Loader2 className="h-5 w-5 animate-spin text-blue-600 dark:text-blue-400" />
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
                        <Icon className="size-5" />
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
})
