/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { MoreVertical, Pencil, PinOff } from 'lucide-react'
import { Button, mutedIconButtonClass } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { ResponsiveActionMenu } from '@/components/ui/responsive-action-menu'
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { PageIcon } from './page-icon'
import type { SavedPage } from './saved-page'
import { useSavedPageMenuItemState } from './use-saved-page-menu-item-state'

export const SavedPageMenuItem = ({
  page,
  active,
  onOpen,
  onRename,
  onUnpin,
}: {
  page: SavedPage
  active: boolean
  onOpen: () => void
  onRename: () => void
  onUnpin: () => void
}) => {
  const { t } = useLingui()
  const state = useSavedPageMenuItemState(onRename)
  const actions = [
    { label: t`Rename`, icon: <Pencil />, onSelect: state.startRename },
    { label: t`Unpin`, icon: <PinOff />, onSelect: onUnpin },
  ]
  return (
    <SidebarMenuItem data-saved-page-id={page.id}>
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={state.isMobile}>
          <SidebarMenuButton
            {...(state.isMobile ? state.longPressHandlers : {})}
            className="cursor-pointer pr-9"
            tooltip={page.title}
            isActive={active}
            onClick={(event) => {
              if (state.longPressFired.current) {
                state.longPressFired.current = false
                event.preventDefault()
                return
              }
              onOpen()
            }}
          >
            <PageIcon source={page.source} />
            <span>{page.title}</span>
          </SidebarMenuButton>
        </ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={state.handleCloseAutoFocus}>
          {actions.map((action) => (
            <ContextMenuItem key={action.label} onSelect={action.onSelect} className="cursor-pointer">
              {action.icon}
              {action.label}
            </ContextMenuItem>
          ))}
        </ContextMenuContent>
      </ContextMenu>
      <ResponsiveActionMenu
        open={state.menuOpen}
        onOpenChange={state.handleMenuOpenChange}
        title={page.title}
        actions={actions}
        desktopMenu={{ side: 'right', align: 'start', onCloseAutoFocus: state.handleCloseAutoFocus }}
        trigger={
          <Button
            variant="ghost"
            size="icon"
            aria-label={t`More`}
            className={cn(
              mutedIconButtonClass,
              'absolute right-0 top-1/2 -translate-y-1/2 bg-transparent hover:bg-transparent dark:hover:bg-transparent transition-opacity',
              !state.menuOpen &&
                'md:opacity-0 md:group-hover/menu-item:opacity-100 md:group-focus-within/menu-item:opacity-100',
            )}
          >
            <MoreVertical />
          </Button>
        }
      />
    </SidebarMenuItem>
  )
}
