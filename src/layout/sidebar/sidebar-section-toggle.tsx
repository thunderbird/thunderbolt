/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { ChevronRight, MoreVertical } from 'lucide-react'
import { useRef } from 'react'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { ResponsiveActionMenu, type ResponsiveActionMenuAction } from '@/components/ui/responsive-action-menu'
import { SidebarGroupLabel } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { useIsMobile } from '@/hooks/use-mobile'
import { useSidebarSectionToggleState } from './use-sidebar-section-toggle-state'

/** A disclosure control that keeps the sidebar section label's typography. */
export const SidebarSectionToggle = ({
  expanded,
  onToggle,
  controls,
  label,
  actions,
}: {
  expanded: boolean
  onToggle: () => void
  controls: string
  label: string
  actions: ResponsiveActionMenuAction[]
}) => {
  const { t } = useLingui()
  const { isMobile } = useIsMobile()
  const openingAction = useRef(false)
  const { menuOpen, setMenuOpen, longPressHandlers, handleClick, handleKeyDown } =
    useSidebarSectionToggleState(onToggle)
  const menuActions = actions.map((action) => ({
    ...action,
    onSelect: () => {
      openingAction.current = true
      action.onSelect()
    },
  }))
  const handleCloseAutoFocus = (event: Event) => {
    if (openingAction.current) {
      event.preventDefault()
      openingAction.current = false
    }
  }

  const trigger = (
    <SidebarGroupLabel
      asChild
      className="h-[var(--touch-height-default)] min-w-0 flex-1 cursor-pointer gap-1.5 text-left md:h-8"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={controls}
        aria-haspopup={isMobile ? 'dialog' : 'menu'}
        data-long-press={isMobile ? '' : undefined}
        {...(isMobile ? longPressHandlers : {})}
        onClick={isMobile ? handleClick : onToggle}
        onKeyDown={isMobile ? handleKeyDown : undefined}
      >
        {label}
        <span aria-hidden="true">
          <ChevronRight className={cn('size-3 transition-transform', expanded && 'rotate-90')} />
        </span>
      </button>
    </SidebarGroupLabel>
  )

  const row = (
    <div
      className={cn(
        'group/section relative flex w-full items-center rounded-xl hover:bg-sidebar-accent has-[:focus-visible]:bg-sidebar-accent data-[state=open]:bg-sidebar-accent',
        expanded && 'mb-2',
        menuOpen && 'bg-sidebar-accent',
      )}
    >
      {trigger}
      <ResponsiveActionMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        title={label}
        actions={menuActions}
        desktopMenu={{ side: 'right', align: 'start', sideOffset: 8, onCloseAutoFocus: handleCloseAutoFocus }}
        trigger={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t`${label} options`}
            className="hidden md:inline-flex size-[var(--touch-height-default)] shrink-0 bg-transparent text-muted-foreground transition-opacity hover:bg-transparent dark:hover:bg-transparent active:bg-transparent data-[state=open]:bg-transparent md:size-8 md:opacity-0 md:group-hover/section:opacity-100 md:group-has-[:focus-visible]/section:opacity-100 md:data-[state=open]:opacity-100 md:group-data-[state=open]/section:opacity-100"
          >
            <MoreVertical className="size-4" />
          </Button>
        }
      />
    </div>
  )

  if (isMobile) {
    return row
  }

  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={handleCloseAutoFocus}>
        {menuActions.map((action) => (
          <ContextMenuItem key={action.label} disabled={action.disabled} onSelect={action.onSelect}>
            {action.icon}
            {action.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}
