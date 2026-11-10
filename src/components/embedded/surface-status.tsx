/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Keep rendered content visible while surfacing a page's runtime error. */
export const EmbeddedErrorStrip = ({ message, className }: { message: string; className?: string }) => (
  <div
    className={cn(
      'flex items-center gap-2 border-b border-border bg-destructive/10 px-4 py-1.5 text-[length:var(--font-size-xs)] text-destructive',
      className,
    )}
  >
    <AlertTriangle className="size-3.5 shrink-0" />
    <span className="truncate">{message}</span>
  </div>
)
