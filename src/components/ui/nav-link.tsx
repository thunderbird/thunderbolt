import { useSidebar } from '@/components/ui/sidebar'
import { useIsMobile } from '@/hooks/use-mobile'
import { forwardRef, type ComponentProps } from 'react'
import { Link } from 'react-router'

/**
 * Link component that automatically closes the mobile sidebar when clicked
 */
export const NavLink = forwardRef<HTMLAnchorElement, ComponentProps<typeof Link>>(({ onClick, ...props }, ref) => {
  const { setOpenMobile } = useSidebar()
  const isMobile = useIsMobile()

  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (isMobile) {
      setOpenMobile(false)
    }
    onClick?.(event)
  }

  return <Link ref={ref} onClick={handleClick} {...props} />
})
NavLink.displayName = 'NavLink'
