/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cn } from '@/lib/utils'

type MobileBlurBackdropProps = {
  onClick: () => void
  className?: string
}

/** Full-screen backdrop used on mobile to blur and mute content behind popovers/menus.
 *  Rendered as a button so dismissing works for keyboard and screen-reader users. */
export const MobileBlurBackdrop = ({ onClick, className }: MobileBlurBackdropProps) => (
  <button
    type="button"
    aria-label="Dismiss"
    className={cn(
      'fixed inset-0 z-40 cursor-default bg-white/30 backdrop-blur-md backdrop-saturate-[.25] dark:bg-black/30',
      className,
    )}
    onClick={onClick}
  />
)
