/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppLogo } from '@/components/app-logo'
import { useAppName } from '@/lib/branding-selectors'
import { cn } from '@/lib/utils'

type AppWordmarkProps = {
  className?: string
}

/** The app's logo and name, as the standalone screens show them above their content. */
export const AppWordmark = ({ className }: AppWordmarkProps) => {
  const appName = useAppName()
  return (
    <div className={cn('flex items-center gap-1.5 text-sm text-muted-foreground', className)}>
      {/* The name beside it already says what the logo would. */}
      <AppLogo size={16} alt="" />
      <span>{appName}</span>
    </div>
  )
}
