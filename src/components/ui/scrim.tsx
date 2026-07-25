/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

type ScrimProps = ComponentProps<'div'> & {
  /** Total fade height, e.g. `calc(var(--header-inset) + 2.5rem)`. */
  height: string
}

/**
 * Top-edge scrim: a background fade plus a backdrop blur, both faded out by a
 * mask so the blur has no hard boundary. Keeps content legible as it scrolls
 * behind pinned controls (the floating app header, a flush mobile modal's
 * close/action controls). Render it before the controls so they paint on top.
 *
 * The gradient stops, blur radius, and 20%/100% mask stops are one design
 * decision — `floatingFormFooterClass` (`form-footer.tsx`) re-encodes the
 * inverted, bottom-edge variant as a pseudo-element because a descendant
 * selector can't render an element; keep the two in sync when tuning.
 */
export const Scrim = ({ height, className, ...props }: ScrimProps) => (
  <div
    aria-hidden="true"
    className={cn(
      'pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-background via-background/80 to-transparent backdrop-blur-[4px]',
      className,
    )}
    style={{
      height,
      maskImage: 'linear-gradient(to bottom, black 20%, transparent 100%)',
      WebkitMaskImage: 'linear-gradient(to bottom, black 20%, transparent 100%)',
    }}
    {...props}
  />
)
