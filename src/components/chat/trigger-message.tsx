import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { cn } from '@/lib/utils'
import { StreamingMarkdown } from './streaming-markdown'

interface TriggerMessageProps {
  /** The title of the automation that triggered the chat */
  title: string
  /** The full prompt that was used to start the chat */
  prompt: string
  /** Optional additional class names */
  className?: string
}

/**
 * A special message shown at the top of a chat that was started by an automation.
 * Renders a timeline-style bullet with a "Triggered by automation" label and an
 * accordion that reveals the full automation prompt when expanded.
 */
export const TriggerMessage = ({ title, prompt, className }: TriggerMessageProps) => (
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

    {/* Accordion with automation title & prompt */}
    <Accordion type="single" collapsible className="w-full max-w-[696px]">
      <AccordionItem value="automation-trigger" className="border-none">
        <AccordionTrigger className="bg-secondary hover:bg-secondary/80 px-4 py-2.5 rounded-md data-[state=open]:rounded-t-md data-[state=open]:rounded-b-none text-left w-full whitespace-pre-wrap">
          {title || 'Automation'}
        </AccordionTrigger>
        <AccordionContent className="bg-secondary rounded-b-md px-4 py-3">
          <StreamingMarkdown content={prompt} className="text-secondary-foreground leading-relaxed" />
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  </div>
)

export default TriggerMessage
