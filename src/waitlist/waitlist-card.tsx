import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

type WaitlistCardProps = {
  children: ReactNode
}

/**
 * Shared card container for waitlist pages.
 * Responsive: full-screen on mobile, fixed-size card on desktop.
 * Uses CSS media queries to avoid layout flicker during navigation.
 */
export const WaitlistCard = ({ children }: WaitlistCardProps) => {
  return (
    <div
      className={cn(
        'relative flex flex-col items-center backdrop-blur-[5px]',
        // Mobile styles (default)
        'inset-0 w-full min-h-dvh border-0 rounded-none px-4 py-8 justify-start overflow-y-auto',
        // Desktop styles (md breakpoint = 768px)
        'md:h-[600px] md:w-[430px] md:min-h-0 md:rounded-[16px] md:border md:border-border md:p-8 md:justify-center md:overflow-clip',
      )}
    >
      {children}
    </div>
  )
}
