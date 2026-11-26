/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { DetailActionsMenu } from '@/components/settings/detail-actions-menu'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'

/** One thing an admin can do to an item, offered alike in its row's right-click menu and its panel's ⋯ menu. */
export type ItemAction = {
  id: string
  label: ReactNode
  icon: LucideIcon
  onSelect: () => void
  disabled?: boolean
}

/** The item's actions as a panel's ⋯ menu, or nothing when it has none. */
export const ItemActionsMenu = ({ actions }: { actions: ItemAction[] }) =>
  actions.length === 0 ? null : (
    <DetailActionsMenu>
      {/* Plain items, as Skills' Edit and Delete: the confirm that follows carries the warning. */}
      {actions.map(({ id, label, icon: Icon, onSelect, disabled }) => (
        <DropdownMenuItem key={id} disabled={disabled} onClick={onSelect} className="cursor-pointer">
          <Icon />
          {label}
        </DropdownMenuItem>
      ))}
    </DetailActionsMenu>
  )

/** The item's actions as the items of its row's right-click menu, or undefined when it has none. */
export const itemContextMenuItems = (actions: ItemAction[]) =>
  actions.length === 0
    ? undefined
    : actions.map(({ id, label, icon: Icon, onSelect, disabled }) => (
        <ContextMenuItem key={id} disabled={disabled} onClick={onSelect} className="cursor-pointer">
          <Icon className="size-4" />
          {label}
        </ContextMenuItem>
      ))
