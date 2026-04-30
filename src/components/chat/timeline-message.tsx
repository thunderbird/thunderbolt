/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cn } from '@/lib/utils'
import { type PropsWithChildren } from 'react'

type TimelineMessageProps = PropsWithChildren<{
  className?: string
}>

export const TimelineMessage = ({ children, className }: TimelineMessageProps) => (
  <div className={cn('flex flex-col items-center select-none', className)}>
    {/* Timeline bullet */}
    <span className="w-3 h-3 rounded-full bg-secondary" />
    {/* Vertical line above the text */}
    <span className="h-6 w-px bg-secondary mb-2" />
    {/* Label */}
    <div className="text-xs text-muted-foreground uppercase tracking-wide mb-2">{children}</div>
    {/* Vertical line that runs directly into the accordion */}
    <span className="h-6 w-px bg-secondary" />
  </div>
)

export default TimelineMessage
