/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { SidebarGroupLabel } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'

/** A disclosure control that keeps the sidebar section label's typography. */
export const SidebarSectionToggle = ({
  expanded,
  onToggle,
  controls,
  children,
}: {
  expanded: boolean
  onToggle: () => void
  controls: string
  children: ReactNode
}) => (
  <SidebarGroupLabel asChild className="min-w-0 flex-1 cursor-pointer gap-1.5 text-left">
    <button type="button" aria-expanded={expanded} aria-controls={controls} onClick={onToggle}>
      {children}
      <span aria-hidden="true">
        <ChevronRight className={cn('size-3 transition-transform', expanded && 'rotate-90')} />
      </span>
    </button>
  </SidebarGroupLabel>
)
