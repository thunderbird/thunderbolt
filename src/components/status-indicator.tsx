import { cn } from '@/lib/utils'
import type { FC } from 'react'

/**
 * Simple status indicator dot used across the application to visualise
 * connectivity state (online/offline/connecting, …).
 *
 * @example
 *   <StatusIndicator status="online" />
 */
export type StatusState = 'online' | 'offline' | 'connected' | 'disconnected' | 'connecting' | 'neutral'

export interface StatusIndicatorProps {
  /**
   * The current state that should be visualised.
   */
  status: StatusState
  /**
   * Visual size variant. `sm` renders a 0.5rem dot, `md` a 0.75rem dot and
   * `lg` a 1rem dot. Defaults to `md`.
   */
  size?: 'sm' | 'md' | 'lg'
  /**
   * Optional additional Tailwind classes.
   */
  className?: string
}

const sizeClasses: Record<NonNullable<StatusIndicatorProps['size']>, string> = {
  sm: 'w-2 h-2',
  md: 'w-3 h-3',
  lg: 'w-4 h-4',
}

const stateClasses: Record<StatusState, string> = {
  online: 'bg-green-500',
  connected: 'bg-green-500',
  offline: 'bg-red-500',
  disconnected: 'bg-red-500',
  connecting: 'bg-yellow-500',
  neutral: 'bg-muted-foreground/30',
}

export const StatusIndicator: FC<StatusIndicatorProps> = ({ status, size = 'md', className }) => {
  return (
    <span
      className={cn('inline-block rounded-full flex-shrink-0', sizeClasses[size], stateClasses[status], className)}
    />
  )
}
