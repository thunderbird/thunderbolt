import type { ReasoningUIPart } from 'ai'
import { motion } from 'framer-motion'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { ToolIcon } from './tool-icon'
import { BrainIcon } from 'lucide-react'

type ReasoningItemProps = {
  part: ReasoningUIPart
  index: number
  messageId: string
  onOpenDetails: (part: ReasoningUIPart) => void
}

export const ReasoningItem = ({ part, index, messageId, onOpenDetails }: ReasoningItemProps) => {
  const isLoading = part.state === 'streaming'

  return (
    <Tooltip key={`${messageId}_tooltip_reasoning_${index}`}>
      <TooltipTrigger asChild>
        <motion.div
          initial={{ scale: 0 }}
          animate={{
            scale: 1,
          }}
        >
          <ToolIcon
            toolName={`${messageId}_reasoning_${index}`}
            toolOutput={undefined}
            Icon={BrainIcon}
            initials="T"
            isLoading={isLoading}
            isError={false}
            tooltipKey={`${messageId}_reasoning_${index}`}
            onClick={() => onOpenDetails(part)}
          />
        </motion.div>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <p className="font-medium">{isLoading ? 'Thinking' : 'Thought'}</p>
      </TooltipContent>
    </Tooltip>
  )
}
