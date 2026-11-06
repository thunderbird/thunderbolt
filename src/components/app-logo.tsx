/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cn } from '@/lib/utils'
import logoSrc from '@/assets/logo.svg'
import { useBrandingLogo } from '@/lib/branding-logo'
import { useAppName } from '@/lib/branding-selectors'
import type { ComponentPropsWithoutRef } from 'react'

type AppLogoProps = Omit<ComponentPropsWithoutRef<'img'>, 'src' | 'width' | 'height'> & {
  size?: number
}

export const AppLogo = ({ size = 16, className, ...props }: AppLogoProps) => {
  const appName = useAppName()
  const logo = useBrandingLogo()

  // A configured logo still downloading holds its space blank, so the default mark never flashes in first.
  if (logo.kind === 'loading') {
    return (
      <span
        aria-hidden="true"
        style={{ width: size, height: size }}
        className={cn('inline-block shrink-0', className)}
      />
    )
  }

  return (
    <img
      src={logo.kind === 'branded' ? logo.src : logoSrc}
      width={size}
      height={size}
      alt={appName}
      draggable={false}
      // object-contain fits a non-square operator logo inside the square slot.
      className={cn('shrink-0 object-contain', className)}
      {...props}
    />
  )
}
