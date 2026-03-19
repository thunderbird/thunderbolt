import { cn } from '@/lib/utils'
import * as AccordionPrimitive from '@radix-ui/react-accordion'
import { ChevronRight } from 'lucide-react'
import { useState, type ReactNode } from 'react'

export type ExpandableProps = {
  /** The title displayed in the accordion trigger */
  title: ReactNode
  /** The content to display when expanded */
  children: ReactNode
  /** Background color class for the accordion */
  bgColor?: string
  /** Whether the accordion should be open by default */
  defaultOpen?: boolean
  /** Additional class names for the root container */
  className?: string
  /** Optional click handler for the trigger */
  onToggle?: (isOpen: boolean) => void
  /** Optional custom icon to render instead of the default spinner/completion icon */
  icon?: ReactNode
}

/**
 * A purpose-built accordion component for single-item use cases.
 * Features consistent styling, thinking states, and proper animations.
 */
export const Expandable = ({
  title,
  children,
  bgColor,
  defaultOpen = false,
  className,
  onToggle,
  icon,
}: ExpandableProps) => {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  const handleValueChange = (value: string) => {
    const newIsOpen = value === 'item'
    setIsOpen(newIsOpen)
    onToggle?.(newIsOpen)
  }

  return (
    <AccordionPrimitive.Root
      type="single"
      collapsible
      value={isOpen ? 'item' : ''}
      onValueChange={handleValueChange}
      className={cn(
        'rounded-xl shadow-sm border',
        isOpen ? 'border-border mb-2' : 'border-transparent',
        bgColor,
        className,
      )}
    >
      <AccordionPrimitive.Item value="item" className="border-none">
        <AccordionPrimitive.Header className="flex">
          <AccordionPrimitive.Trigger
            className={cn(
              'flex flex-1 items-center justify-between gap-2 px-4 py-2 text-left transition-all outline-none min-h-[var(--min-touch-height)]',
              'hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              'rounded-md data-[state=open]:rounded-b-none',
              'disabled:pointer-events-none disabled:opacity-50',
            )}
          >
            <div className={cn('flex items-center overflow-hidden', icon ? 'gap-2' : '')}>
              {icon}
              <span className="text-sm font-medium text-muted-foreground overflow-hidden">{title}</span>
            </div>
            <ChevronRight
              className={cn('h-4 w-4 text-gray-500 transition-transform duration-200', isOpen && 'rotate-90')}
            />
          </AccordionPrimitive.Trigger>
        </AccordionPrimitive.Header>
        <AccordionPrimitive.Content
          className={cn(
            'overflow-hidden text-sm transition-all',
            'data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down',
          )}
        >
          <div className="px-4 pt-2 pb-3">{children}</div>
        </AccordionPrimitive.Content>
      </AccordionPrimitive.Item>
    </AccordionPrimitive.Root>
  )
}
