import { AppLogo } from '@/components/app-logo'

/**
 * Shared branding header for waitlist pages.
 * Displays the Thunderbolt logo and wordmark.
 */
export const WaitlistHeader = () => (
  <div className="flex w-full items-center justify-center gap-1">
    <AppLogo size={16} className="!fill-[#DCE875]" />
    <span className="font-brand text-xl font-medium leading-7 tracking-[-0.4px] text-[#f2f7fc]">Thunderbolt</span>
  </div>
)
