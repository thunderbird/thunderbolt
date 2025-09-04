import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type InputHTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

const inputVariants = cva(
  'border-input file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground flex min-w-0 rounded-md border bg-transparent px-3 py-1 text-base outline-none file:inline-flex file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
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
        default: 'h-9 w-full',
        sm: 'h-8 text-xs px-2.5 py-0.5 rounded-md',
        lg: 'h-10 text-base px-4 py-2 rounded-md',
        xl: 'h-12 text-lg px-5 py-2.5 rounded-lg',
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

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>,
    VariantProps<typeof inputVariants> {}

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
