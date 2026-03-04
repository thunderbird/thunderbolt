import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { type MouseEvent, useCallback, type ComponentProps } from 'react'

import { useHaptics } from '@/hooks/use-haptics'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-[var(--gap-lg)] whitespace-nowrap rounded-md text-[length:var(--font-size-body)] font-medium transition-all cursor-pointer disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
        destructive:
          'bg-destructive text-white shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60',
        outline:
          'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50',
        secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default:
          'h-[var(--touch-height-default)] px-[var(--spacing-x-default)] py-[var(--spacing-y-default)] has-[>svg]:px-[var(--spacing-x-md)]',
        sm: 'h-[var(--touch-height-sm)] rounded-md gap-[var(--gap-default)] px-[var(--spacing-x-md)] has-[>svg]:px-[var(--spacing-x-sm)]',
        lg: 'h-[var(--touch-height-lg)] rounded-md px-[var(--spacing-x-lg)] has-[>svg]:px-[var(--spacing-x-default)]',
        icon: 'size-[var(--touch-height-default)]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

const Button = ({
  className,
  variant,
  size,
  asChild = false,
  onClick,
  ...props
}: ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) => {
  const Comp = asChild ? Slot : 'button'
  const { triggerSelection } = useHaptics()

  const handleClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      triggerSelection()
      onClick?.(e)
    },
    [onClick, triggerSelection],
  )

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      onClick={handleClick}
      {...props}
    />
  )
}

export { Button, buttonVariants }
