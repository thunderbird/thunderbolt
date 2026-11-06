/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cn } from '@/lib/utils'

/**
 * Hairline section separator for the collapsed icon rail, where group labels
 * are hidden and spacing alone can't mark section boundaries.
 */
export const RailDivider = ({ className }: { className?: string }) => (
  <div aria-hidden className={cn('mx-auto h-px w-6 bg-sidebar-border', className)} />
)
