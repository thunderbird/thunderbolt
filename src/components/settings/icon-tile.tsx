/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/** The square icon box that leads settings list rows and detail headers. */
export const IconTile = ({ className, children }: { className?: string; children: ReactNode }) => (
  <div
    className={cn(
      'flex aspect-square size-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-foreground',
      className,
    )}
  >
    {children}
  </div>
)
