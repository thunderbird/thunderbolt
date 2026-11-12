/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, type ReactElement, type ComponentProps } from 'react'
import { Menu } from '@tauri-apps/api/menu'
import { LogicalPosition } from '@tauri-apps/api/dpi'
import type { LucideIcon } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

export type PageTabMenuItem =
  | { id: string; label: string; icon: LucideIcon; disabled?: boolean; onSelect: () => void }
  | 'separator'

/** Release menus even when their async creation finishes after the tab closes. */
const closeMenu = async (pending: Promise<Menu> | null) => {
  const menu = await pending
  await menu?.close()
}

/** Native menus can cover sibling webviews without hiding the running page. */
export const PageTabContextMenu = ({
  native,
  items,
  children,
  onCloseAutoFocus,
}: {
  native: boolean
  items: PageTabMenuItem[]
  children: ReactElement
  onCloseAutoFocus: ComponentProps<typeof ContextMenuContent>['onCloseAutoFocus']
}) => {
  const currentMenu = useRef<Promise<Menu> | null>(null)
  useEffect(
    () => () => {
      void closeMenu(currentMenu.current)
      currentMenu.current = null
    },
    [],
  )
  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        disabled={native}
        onContextMenu={async (event) => {
          if (!native) {
            return
          }
          event.preventDefault()
          const bounds = event.currentTarget.getBoundingClientRect()
          const at =
            event.clientX || event.clientY
              ? new LogicalPosition(event.clientX, event.clientY)
              : new LogicalPosition(bounds.left, bounds.bottom)
          void closeMenu(currentMenu.current)
          const pending = Menu.new({
            items: items.map((item) =>
              item === 'separator'
                ? { item: 'Separator' }
                : { text: item.label, enabled: !item.disabled, action: item.onSelect },
            ),
          })
          currentMenu.current = pending
          const menu = await pending
          if (currentMenu.current === pending) {
            await menu.popup(at)
          }
        }}
      >
        {children}
      </ContextMenuTrigger>
      {!native && (
        <ContextMenuContent onCloseAutoFocus={onCloseAutoFocus}>
          {items.map((item, index) =>
            item === 'separator' ? (
              <ContextMenuSeparator key={`separator-${index}`} />
            ) : (
              <ContextMenuItem key={item.id} disabled={item.disabled} onSelect={item.onSelect}>
                <item.icon />
                {item.label}
              </ContextMenuItem>
            ),
          )}
        </ContextMenuContent>
      )}
    </ContextMenu>
  )
}
