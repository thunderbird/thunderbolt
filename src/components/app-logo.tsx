import { cn } from '@/lib/utils'
import logoSrc from '@/assets/logo.svg'

type AppLogoProps = {
  size?: number
  className?: string
}

export const AppLogo = ({ size = 16, className }: AppLogoProps) => {
  return (
    <img
      src={logoSrc}
      width={size}
      height={size}
      alt="Thunderbolt"
      draggable={false}
      className={cn('shrink-0', className)}
    />
  )
}
