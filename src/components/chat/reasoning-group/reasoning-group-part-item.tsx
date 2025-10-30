import { Card, CardContent } from '@/components/ui/card'
import { ChainOfThoughtStep } from '@/components/ui/chain-of-thought'
import { useToolMetadata } from '@/hooks/use-tool-metadata'
import { type ReasoningGroupItem } from '@/lib/assistant-message'
import type { ReasoningUIPart, ToolUIPart } from 'ai'
import { AnimatePresence, motion } from 'framer-motion'
import { BrainIcon } from 'lucide-react'

type ReasoningGroupItemProps = {
  item: ReasoningGroupItem
}

type PartRenderProps<T> = {
  part: T
}

const ReasoningPartRender = ({ part }: PartRenderProps<ReasoningUIPart>) => {
  const isLoading = part.state === 'streaming'

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <ChainOfThoughtStep
        // className="cursor-pointer"
        icon={BrainIcon}
        label={isLoading ? 'Thinking' : 'Thought'}
        status={isLoading ? 'pending' : 'complete'}
        // onClick={onClick}
      >
        <AnimatePresence>
          {isLoading && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <Card>
                <CardContent className="max-h-20 overflow-scroll">
                  <p>{part.text}</p>
                </CardContent>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>
      </ChainOfThoughtStep>
    </motion.div>
  )
}
const ToolPartRender = ({ part }: PartRenderProps<ToolUIPart>) => {
  const metadata = useToolMetadata(part.type)

  // if (status === 'pending') {
  //   return <ToolLoader label={metadata?.loadingMessage ?? ''} toolId={part.toolCallId} />
  // }

  const isLoading = part.state !== 'output-available' && part.state !== 'output-error'

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <ChainOfThoughtStep
        // className="cursor-pointer"
        icon={metadata?.icon ?? undefined}
        label={metadata?.displayName ?? ''}
        status={isLoading ? 'pending' : 'complete'}
        // onClick={onClick}
      />
    </motion.div>
  )
}

export const ReasoningGroupPartItem = ({ item }: ReasoningGroupItemProps) => {
  if (item.type === 'tool') {
    return <ToolPartRender part={item.content as ToolUIPart} />
  }

  return <ReasoningPartRender part={item.content as ReasoningUIPart} />
}
