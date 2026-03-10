import { type ComponentProps } from 'react'
import { cn } from '@/lib/utils'

const Skeleton = ({ className, ...props }: ComponentProps<'div'>) => {
  return (
    <div
      data-slot="skeleton"
      className={cn('bg-accent animate-pulse rounded-[var(--radius-default)]', className)}
      {...props}
    />
  )
}

export { Skeleton }
