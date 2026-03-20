import type { ReactNode } from 'react'

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
  /** Show blur backdrop on mobile */
  blurBackdrop?: boolean
  /** Custom trigger content - receives selected item */
  trigger?: ReactNode | ((selected: SearchableMenuItem<T> | undefined, isOpen: boolean) => ReactNode)
  /** Custom item renderer */
  renderItem?: (item: SearchableMenuItem<T>, isSelected: boolean) => ReactNode
  /** Footer content (e.g., "Add Models" button) */
  footer?: ReactNode
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
