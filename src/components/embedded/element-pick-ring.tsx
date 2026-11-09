/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cn } from '@/lib/utils'

/**
 * Frames the surface while element picking is on.
 *
 * Stays mounted so it can fade both ways, which the capture overlay can't do:
 * that has to leave the moment picking ends, or it would keep eating clicks.
 * Stacked above the overlay so the overlay's dim can't mute it against the banner.
 *
 * One `box-shadow` rather than Tailwind's ring and inset-shadow utilities, which
 * paint the shadow over the ring and would tint it away from the banner's color.
 * The inner shadow is what defines the edge where the ring meets a similar color.
 */
export const ElementPickRing = ({ active }: { active: boolean }) => (
  <div
    aria-hidden
    className={cn(
      'pointer-events-none absolute inset-0 z-40 shadow-[inset_0_0_0_2px_var(--color-secondary),inset_0_0_12px_2px_var(--elevation-strong)] transition-opacity duration-200 ease-out motion-reduce:transition-none',
      active ? 'opacity-100' : 'opacity-0',
    )}
  />
)
