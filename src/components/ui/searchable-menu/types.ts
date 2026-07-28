/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'

import type { MobileCardMenuSide } from '@/components/ui/mobile-card-menu'

export type SearchableMenuItem<T = unknown> = {
  id: string
  label: string
  description?: string
  icon?: ReactNode
  disabled?: boolean
  data?: T
  /** Additional searchable text (not displayed) */
  searchTerms?: string
}

export type SearchableMenuGroup<T = unknown> = {
  id: string
  label?: string
  subtitle?: string
  items: SearchableMenuItem<T>[]
}

/** Declarative footer action row ("Add Model", "Add Agent"). The menu renders
 *  the row itself and closes synchronously before running the action, so a
 *  surface the action opens (e.g. the quick-create panel) never races the
 *  closing menu. */
export type SearchableMenuFooterAction = {
  label: string
  onAction: () => void
  icon?: ReactNode
}

export type SearchableMenuProps<T = unknown> = {
  /** Items to display - can be flat or grouped */
  items: SearchableMenuItem<T>[] | SearchableMenuGroup<T>[]
  /** Currently selected item ID */
  value?: string
  /** Callback when selection changes */
  onValueChange: (id: string, item: SearchableMenuItem<T>) => void
  /** Enable search functionality */
  searchable?: boolean
  /** Search input placeholder */
  searchPlaceholder?: string
  /** Message when no items match search */
  emptyMessage?: string
  /** Accessible heading shown on the mobile card menu */
  mobileTitle?: string
  /** Screen edge the mobile card menu enters from */
  mobileSide?: MobileCardMenuSide
  /** Custom trigger content - receives selected item */
  trigger?: ReactNode | ((selected: SearchableMenuItem<T> | undefined, isOpen: boolean) => ReactNode)
  /** Custom item renderer */
  renderItem?: (item: SearchableMenuItem<T>, isSelected: boolean) => ReactNode
  /** Footer action row; the menu owns its rendering and close-first behavior. */
  footerAction?: SearchableMenuFooterAction
  /** Popover width */
  width?: string | number
  /** Controlled open state */
  open?: boolean
  /** Controlled open change */
  onOpenChange?: (open: boolean) => void
  /** Additional class for the content */
  contentClassName?: string
  /** Align popover */
  align?: 'start' | 'center' | 'end'
  /** Side of the trigger to open the popover (top opens upward, bottom opens downward) */
  side?: 'top' | 'bottom' | 'left' | 'right'
  /** Max height for the items list */
  maxHeight?: string | number
}

/** Check if items are grouped */
export const isGroupedItems = <T>(
  items: SearchableMenuItem<T>[] | SearchableMenuGroup<T>[],
): items is SearchableMenuGroup<T>[] => {
  return items.length > 0 && 'items' in items[0]
}

/** Flatten grouped items for search */
export const flattenItems = <T>(items: SearchableMenuItem<T>[] | SearchableMenuGroup<T>[]): SearchableMenuItem<T>[] => {
  if (isGroupedItems(items)) {
    return items.flatMap((group) => group.items)
  }
  return items
}

/** Find item by ID in flat or grouped items */
export const findItemById = <T>(
  items: SearchableMenuItem<T>[] | SearchableMenuGroup<T>[],
  id: string,
): SearchableMenuItem<T> | undefined => {
  return flattenItems(items).find((item) => item.id === id)
}
