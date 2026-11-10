/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { useDroppable } from '@dnd-kit/core'
import type { ReactNode } from 'react'
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'

type ProjectDropRowProps = {
  dropId: string
  label: string
  icon: ReactNode
}

export const ProjectDropRow = ({ dropId, label, icon }: ProjectDropRowProps) => {
  const { t } = useLingui()
  const { setNodeRef, isOver } = useDroppable({ id: dropId })

  return (
    <SidebarMenuItem ref={setNodeRef}>
      <SidebarMenuButton
        tooltip={label}
        className={cn(
          'cursor-pointer transition-all duration-150',
          isOver && 'bg-accent ring-2 ring-ring ring-offset-1 ring-offset-sidebar',
        )}
      >
        {icon}
        <span className="truncate">{label}</span>
        <span className="ml-auto text-[length:var(--font-size-xs)] text-muted-foreground">{isOver ? t`Drop` : ''}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}
