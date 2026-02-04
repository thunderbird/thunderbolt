import { cn } from '@/lib/utils'
import { ArrowLeft } from 'lucide-react'
import type { ButtonHTMLAttributes } from 'react'

type BackButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Button size variant */
  size?: 'sm' | 'md'
}

const sizeClasses = {
  sm: { button: 'size-6', icon: 'size-3' },
  md: { button: 'size-8', icon: 'size-5' },
}

/**
 * Circular back button with arrow icon.
 * Used for navigation in modals, cards, and overlays.
 */
export const BackButton = ({ size = 'md', className, ...props }: BackButtonProps) => {
  const sizes = sizeClasses[size]

  return (
    <button
      type="button"
      aria-label="Go back"
      className={cn(
        'flex cursor-pointer items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted',
        sizes.button,
        className,
      )}
      {...props}
    >
      <ArrowLeft className={sizes.icon} />
    </button>
  )
}
