import { cn } from '@/lib/utils'
import { Zap } from 'lucide-react'
import { Expandable } from '../ui/expandable'
import { StreamingMarkdown } from './streaming-markdown'

interface TriggerMessageProps {
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
export const TriggerMessage = ({ title, prompt, isDeleted = false, className }: TriggerMessageProps) => (
  <div className={cn('flex flex-col items-center w-full', className)}>
    {/* Timeline marker and label */}
    <div className="flex flex-col items-center select-none">
      {/* Timeline bullet */}
      <span className="w-3 h-3 rounded-full bg-secondary" />

      {/* Vertical line above the text */}
      <span className="h-6 w-px bg-secondary mb-2" />

      {/* Label */}
      <div className="text-xs text-muted-foreground uppercase tracking-wide mb-2">Triggered by automation</div>

      {/* Vertical line that runs directly into the accordion */}
      <span className="h-6 w-px bg-secondary" />
    </div>

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
        <StreamingMarkdown content={prompt} className="text-secondary-foreground leading-relaxed" />
      </Expandable>
    ) : (
      <div className="shadow-none w-full max-w-[696px] rounded-lg border border-transparent px-4 py-2">
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
)

export default TriggerMessage
