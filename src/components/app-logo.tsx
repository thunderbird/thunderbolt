import { cn } from '@/lib/utils'
import { Zap } from 'lucide-react'

type AppLogoProps = {
  /**
   * Size of the icon in pixels. Defaults to 16 (size-4 in Tailwind).
   */
  size?: number
  className?: string
}

/**
 * Reusable Thunderbolt app logo component.
 * Uses the Zap icon with yellow fill to match the sidebar header.
 */
export const AppLogo = ({ size = 16, className }: AppLogoProps) => {
  return <Zap className={cn('fill-yellow-500 shrink-0', className)} style={{ width: size, height: size }} />
}
