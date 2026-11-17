/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'

const toneClasses: Record<StatusTone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-destructive/15 text-destructive',
  info: 'bg-primary/10 text-primary',
}

/** A short status label (Active, Blocked, Pending…), colored by tone. */
export const StatusBadge = ({ tone, children }: { tone: StatusTone; children: ReactNode }) => (
  <span
    data-tone={tone}
    className={cn(
      'inline-flex shrink-0 items-center rounded-lg px-2 py-0.5 text-[length:var(--font-size-xs)] font-medium',
      toneClasses[tone],
    )}
  >
    {children}
  </span>
)
