/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cn } from '@/lib/utils'

type MobileBlurBackdropProps = {
  onClick: () => void
  className?: string
}

/** Full-screen blurred backdrop used on mobile to dim content behind popovers/menus. */
export const MobileBlurBackdrop = ({ onClick, className }: MobileBlurBackdropProps) => (
  <div
    className={cn('fixed inset-0 z-40 backdrop-blur-sm bg-white/30 dark:bg-black/30', className)}
    onClick={onClick}
  />
)
