/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
