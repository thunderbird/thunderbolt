import { useCallback, type ComponentProps } from 'react'
import * as TogglePrimitive from '@radix-ui/react-toggle'
import { cva, type VariantProps } from 'class-variance-authority'

import { useHaptics } from '@/hooks/use-haptics'
import { cn } from '@/lib/utils'

const toggleVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium hover:bg-muted hover:text-muted-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none transition-[color,box-shadow] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive whitespace-nowrap",
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        outline: 'border border-input bg-transparent shadow-xs hover:bg-accent hover:text-accent-foreground',
      },
      size: {
        default: 'h-[var(--touch-height-default)] px-2 min-w-[var(--touch-height-default)]',
        sm: 'h-[var(--touch-height-sm)] px-2 min-w-[var(--touch-height-sm)]',
        lg: 'h-[var(--touch-height-lg)] px-2 min-w-[var(--touch-height-lg)]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

const Toggle = ({
  className,
  variant,
  size,
  onPressedChange,
  ...props
}: ComponentProps<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants>) => {
  const { triggerSelection } = useHaptics()

  const handlePressedChange = useCallback(
    (pressed: boolean) => {
      triggerSelection()
      onPressedChange?.(pressed)
    },
    [onPressedChange, triggerSelection],
  )

  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      onPressedChange={handlePressedChange}
      {...props}
    />
  )
}

export { Toggle, toggleVariants }
