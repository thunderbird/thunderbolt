import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

type WaitlistCardProps = {
  children: ReactNode
}

/**
 * Shared card container for waitlist pages.
 * Responsive: full-screen on mobile, fixed-size card on desktop.
 */
export const WaitlistCard = ({ children }: WaitlistCardProps) => {
  const { isMobile } = useIsMobile()

  return (
    <div
      className={cn(
        'flex flex-col items-center backdrop-blur-[5px]',
        isMobile
          ? 'inset-0 w-full min-h-dvh border-0 rounded-none px-4 py-8 justify-start overflow-y-auto'
          : 'h-[600px] w-[430px] rounded-[16px] border border-border p-8 justify-center overflow-clip',
      )}
    >
      {children}
    </div>
  )
}
