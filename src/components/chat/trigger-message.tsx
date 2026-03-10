import { cn } from '@/lib/utils'
import { Zap } from 'lucide-react'
import { Expandable } from '../ui/expandable'
import TimelineMessage from './timeline-message'
import { MemoizedMarkdown } from './memoized-markdown'
import { memo } from 'react'

type TriggerMessageProps = {
  chatThreadId: string
  /** The title of the automation that triggered the chat */
  title?: string
  /** The full prompt that was used to start the chat */
  prompt?: string
  /** Whether the automation has been deleted */
  isDeleted?: boolean
  /** Optional additional class names */
  className?: string
}

/**
 * A special message shown at the top of a chat that was started by an automation.
 * Renders a timeline-style bullet with a "Triggered by automation" label and an
 * accordion that reveals the full automation prompt when expanded.
 */
export const TriggerMessage = memo(
  ({ chatThreadId, title, prompt, isDeleted = false, className }: TriggerMessageProps) => (
    <div className={cn('flex flex-col items-center w-full', className)}>
      <TimelineMessage>Triggered by automation</TimelineMessage>
      {/* Automation title & prompt */}
      {prompt ? (
        <Expandable
          title={
            <span className="text-muted-foreground text-sm font-medium whitespace-pre-wrap">
              {title}
              {isDeleted && <span className="italic text-muted-foreground/70 ml-1">Deleted Automation</span>}
            </span>
          }
          className="shadow-none w-full max-w-[696px]"
          icon={<Zap className="h-4 w-4 text-muted-foreground" />}
          defaultOpen={false}
        >
          <MemoizedMarkdown id={chatThreadId} content={prompt} />
        </Expandable>
      ) : (
        <div className="shadow-none w-full max-w-[696px] rounded-[var(--radius-lg)] border border-transparent px-4 py-2">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground text-sm font-medium whitespace-pre-wrap">
              {title || 'Automation'}
              {isDeleted && <span className="italic text-muted-foreground/70 ml-1">(Deleted Automation)</span>}
            </span>
          </div>
        </div>
      )}
    </div>
  ),
)

export default TriggerMessage
