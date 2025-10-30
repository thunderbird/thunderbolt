import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from '@/components/ui/chain-of-thought'
import { type ReasoningGroupUIPart } from '@/lib/assistant-message'
import { AnimatePresence } from 'framer-motion'
import { ReasoningGroupPartItem } from './reasoning-group-part-item'
import { Loader } from '@/components/ui/loader'

type ReasoningGroupPartProps = {
  isLastPart: boolean
  isStreaming: boolean
  part: ReasoningGroupUIPart
}

export const ReasoningGroupPart = ({ isLastPart, isStreaming, part }: ReasoningGroupPartProps) => {
  return (
    <AnimatePresence>
      <ChainOfThought defaultOpen>
        <ChainOfThoughtHeader>Thought Process</ChainOfThoughtHeader>
        <ChainOfThoughtContent>
          {part.items.map((item) => (
            <ReasoningGroupPartItem item={item} />
          ))}
          {isLastPart && isStreaming && (
            <ChainOfThoughtStep
              // @ts-ignore
              icon={Loader}
              status="pending"
            />
          )}
        </ChainOfThoughtContent>
      </ChainOfThought>
    </AnimatePresence>
  )
}
