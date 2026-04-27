/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useSidebar } from '@/components/ui/sidebar'
import { useIsMobile } from '@/hooks/use-mobile'
import { forwardRef, type MouseEvent, type ComponentProps } from 'react'
import { Link } from 'react-router'

/**
 * Link component that automatically closes the mobile sidebar when clicked
 */
export const NavLink = forwardRef<HTMLAnchorElement, ComponentProps<typeof Link>>(({ onClick, ...props }, ref) => {
  const { setOpenMobile } = useSidebar()
  const { isMobile } = useIsMobile()

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (isMobile) {
      setOpenMobile(false)
    }
    onClick?.(event)
  }

  return <Link ref={ref} onClick={handleClick} {...props} />
})
NavLink.displayName = 'NavLink'
