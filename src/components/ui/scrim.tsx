/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

type ScrimProps = ComponentProps<'div'> & {
  /** Total fade height, e.g. `calc(var(--header-inset) + 2.5rem)`. */
  height: string
  /** Viewport edge the scrim fades away from. */
  edge?: 'top' | 'bottom'
}

/**
 * Edge scrim: a background fade plus a backdrop blur, both faded out by a mask
 * so the blur has no hard boundary. Keeps content legible as it scrolls behind
 * pinned controls (the floating app header, a flush mobile modal's controls,
 * or the mobile sidebar footer). Render it before the controls so they paint
 * on top.
 *
 * The gradient stops, blur radius, and 20%/100% mask stops are one design
 * decision shared with `floatingFormFooterClass` (`form-footer.tsx`), which
 * re-encodes the bottom variant as a pseudo-element because a descendant
 * selector can't render an element; keep the two in sync when tuning.
 */
export const Scrim = ({ height, edge = 'top', className, ...props }: ScrimProps) => {
  const direction = edge === 'top' ? 'bottom' : 'top'

  return (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute inset-x-0 from-background via-background/80 to-transparent backdrop-blur-[4px]',
        edge === 'top' ? 'top-0 bg-gradient-to-b' : 'bottom-0 bg-gradient-to-t',
        className,
      )}
      style={{
        height,
        maskImage: `linear-gradient(to ${direction}, black 20%, transparent 100%)`,
        WebkitMaskImage: `linear-gradient(to ${direction}, black 20%, transparent 100%)`,
      }}
      {...props}
    />
  )
}

/**
 * The mobile sidebar's pinned-edge scrim (header and footer): sidebar tint
 * with a 2.5rem overhang that extends the fade past the pinned controls so
 * rows dissolve before reaching them. One component so the header
 * (chat-list.tsx) and footer (sidebar-footer.tsx) can never drift apart.
 */
export const MobileSidebarScrim = ({
  edge = 'top',
  ...props
}: Omit<ScrimProps, 'height' | 'className'> & { edge?: 'top' | 'bottom' }) => (
  <Scrim edge={edge} height="calc(100% + 2.5rem)" className="from-sidebar via-sidebar/80" {...props} />
)
