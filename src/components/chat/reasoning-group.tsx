import { type ReasoningGroupItem } from '@/lib/assistant-message'
import { Expandable } from '../ui/expandable'
import { Brain, CheckIcon, Loader2 } from 'lucide-react'
import { cn, splitPartType } from '@/lib/utils'
import { getToolMetadataSync } from '@/lib/tool-metadata'
import { tool, type ReasoningUIPart, type ToolUIPart } from 'ai'
import { ReasoningDisplay } from './reasoning-display'
import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { useAutoScroll } from '@/hooks/use-auto-scroll'

type ReasoningGroupProps = {
  parts: ReasoningGroupItem[]
  isStreaming: boolean
  isLastPartInMessage: boolean
  hasTextInMessage: boolean
  messageId: string
}

type ReasoningGroupTitleProps = {
  tools: ToolUIPart[]
}

const ReasoningGroupTitle = ({ tools }: ReasoningGroupTitleProps) => {
  const runningTools = tools.filter((tool) => tool.state === 'output-available')

  const [activeIndex, setActiveIndex] = useState(runningTools.length - 1)

  useEffect(() => {
    setActiveIndex(runningTools.length - 1)
  }, [runningTools.length])

  return (
    <div className="relative">
      <AnimatePresence mode="wait">
        {runningTools.map((tool, index) => {
          const isActive = index === activeIndex
          const isBelow = index < activeIndex

          const [, toolName] = splitPartType(tool.type)
          const metadata = getToolMetadataSync(toolName, tool.input)

          return (
            <motion.div
              key={index}
              initial={{ y: 20, opacity: 0 }}
              animate={{
                y: isActive ? 0 : isBelow ? -10 : 20,
                opacity: isActive ? 1 : 0,
                scale: isActive ? 1 : 0.98,
                zIndex: isActive ? 10 : isBelow ? index : 0,
              }}
              exit={{ y: -20, opacity: 0 }}
              transition={{
                duration: 0.3,
                ease: [0.4, 0, 0.2, 1], // Custom easing function
              }}
              className={cn('w-full', !isActive && 'pointer-events-none absolute inset-0')}
            >
              <span className="text-xs text-blue-600 dark:text-blue-400 italic animate-pulse truncate min-w-0">
                {metadata.loadingMessage}
              </span>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}

export const ReasoningGroup = ({
  parts,
  isStreaming,
  isLastPartInMessage,
  hasTextInMessage,
  messageId,
}: ReasoningGroupProps) => {
  const tools = parts.filter((part) => part.type === 'tool').map((part) => part.content) as ToolUIPart[]

  const isThinking = isLastPartInMessage && isStreaming

  const lastPart = parts[parts.length - 1]

  const currentReasoningPart = lastPart.type === 'reasoning' ? (lastPart as ReasoningGroupItem<ReasoningUIPart>) : null

  // Create unique instance key for reasoning display
  const reasoningInstanceKey = currentReasoningPart
    ? `reasoning-${currentReasoningPart.content.text.substring(0, 50)}-${parts.indexOf(currentReasoningPart)}`
    : ''

  const titleNode = isThinking ? <ReasoningGroupTitle tools={tools} /> : `Used ${tools.length} tools in xx`

  const { scrollContainerRef, scrollTargetRef } = useAutoScroll({
    dependencies: [parts.length],
    smooth: true,
    isStreaming: false,
    rootMargin: '0px',
  })

  return (
    <div className="mt-4">
      <Expandable
        className="shadow-none tool-invocation-card rounded-lg overflow-hidden transition-colors"
        icon={
          isThinking ? (
            <Loader2 className={`h-4 w-4 animate-spin text-blue-600 dark:text-blue-400`} />
          ) : (
            <CheckIcon className="h-4 w-4 text-green-600 dark:text-green-400" />
          )
        }
        defaultOpen={false}
        title={titleNode}
      >
        <div
          className="max-h-[200px] overflow-y-auto"
          ref={(el) => {
            scrollContainerRef.current = el
          }}
        >
          {parts.map((part, index) => {
            let Icon
            let displayName
            let isLoading

            if (part.type === 'tool') {
              const toolPart = part.content as ToolUIPart
              const [, toolName] = splitPartType(toolPart.type)
              const metadata = getToolMetadataSync(toolName)

              Icon = metadata.icon
              displayName = metadata.displayName
            }

            switch (part.type) {
              case 'reasoning': {
                const reasoningPart = part.content as ReasoningUIPart

                Icon = Brain
                displayName = 'Thinking'
                isLoading = reasoningPart.state === 'streaming'
                break
              }

              case 'tool': {
                const toolPart = part.content as ToolUIPart
                const [, toolName] = splitPartType(toolPart.type)
                const metadata = getToolMetadataSync(toolName)

                Icon = metadata.icon
                displayName = metadata.displayName
                isLoading = toolPart.state !== 'output-available' && toolPart.state !== 'output-error'

                break
              }

              default:
                return null
            }

            return (
              <button
                key={index}
                // onClick={() => handleStepClick(step)}
                className="flex items-center w-full py-2 px-3 hover:bg-accent/50 rounded-md transition-colors group text-left"
              >
                <div className="flex gap-3 flex-row flex-1 items-center">
                  {isLoading ? (
                    <Loader2 className={`h-4 w-4 animate-spin text-blue-600 dark:text-blue-400`} />
                  ) : (
                    !!Icon && <Icon className="h-4 w-4 text-muted-foreground" />
                  )}
                  <span className="text-sm font-medium truncate text-foreground">{displayName}</span>
                </div>
                <span className="text-xs text-muted-foreground flex-shrink-0">xx</span>
              </button>
            )
          })}
          <div ref={scrollTargetRef} />
        </div>
      </Expandable>
      {currentReasoningPart && (
        <ReasoningDisplay
          text={currentReasoningPart.content.text}
          isStreaming={currentReasoningPart.content.state === 'streaming'}
          instanceKey={reasoningInstanceKey}
        />
      )}
    </div>
  )
}
