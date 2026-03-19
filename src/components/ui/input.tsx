import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type InputHTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

const inputVariants = cva(
  'border-input file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground flex min-w-0 rounded-md border bg-transparent px-[var(--spacing-x-md)] py-[var(--spacing-y-sm)] text-[length:var(--font-size-body)] outline-none file:inline-flex file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
        filled:
          'bg-muted/50 focus-visible:bg-transparent focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
        outline: 'border-2 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[2px]',
        ghost: 'border-none focus-visible:bg-accent/50 focus-visible:ring-0',
      },
      inputSize: {
        default: 'h-[var(--touch-height-default)] w-full',
        sm: 'h-[var(--touch-height-sm)] text-xs px-[var(--spacing-x-sm)] py-[var(--spacing-y-sm)] rounded-md',
        lg: 'h-[var(--touch-height-lg)] text-base px-[var(--spacing-x-default)] py-[var(--spacing-y-default)] rounded-md',
        xl: 'h-[var(--touch-height-xl)] text-lg px-[var(--spacing-x-lg)] py-[var(--spacing-y-md)] rounded-lg',
      },
      state: {
        default: '',
        error: 'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
        success: 'border-green-500 focus-visible:border-green-600 focus-visible:ring-green-300/50',
      },
    },
    defaultVariants: {
      variant: 'default',
      inputSize: 'default',
      state: 'default',
    },
  },
)

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & VariantProps<typeof inputVariants>

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, variant, inputSize, state, ...props }, ref) => {
    return (
      <input
        aria-invalid={state === 'error' ? 'true' : undefined}
        type={type}
        data-slot="input"
        className={cn(inputVariants({ variant, inputSize, state, className }))}
        ref={ref}
        {...props}
      />
    )
  },
)
Input.displayName = 'Input'

export { Input, inputVariants }
