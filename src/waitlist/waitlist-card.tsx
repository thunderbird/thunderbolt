import type { ReactNode } from 'react'

type WaitlistCardProps = {
  children: ReactNode
}

/**
 * Shared card container for waitlist pages.
 * Renders a fixed-size, rounded, bordered card with backdrop blur.
 */
export const WaitlistCard = ({ children }: WaitlistCardProps) => (
  <div className="flex h-[600px] w-[430px] flex-col items-center justify-center overflow-clip rounded-[16px] border border-[#475467] p-8 backdrop-blur-[5px]">
    {children}
  </div>
)
