/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { Slot } from '@radix-ui/react-slot'
import { MessageCirclePlus, Pin, PinOff, SquarePen, Trash2 } from 'lucide-react'
import type { ReactElement, ReactNode } from 'react'
import { useProjectActionsState } from './use-project-actions-state'
import { DetailActionsMenu } from '@/components/settings/detail-actions-menu'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { ResponsiveActionMenu } from '@/components/ui/responsive-action-menu'
import type { Project } from '@/types'
import { ProjectActionMenuItems, type ProjectActionHandlers } from './project-action-menu-items'

type ProjectActionsProps = {
  project: Project
  actions: ProjectActionHandlers
  triggerClassName?: string
  children: (menu: ReactNode) => ReactElement
}

/** Project navigation and management from the sidebar row. */
export const ProjectActions = ({
  project,
  actions: projectActions,
  triggerClassName,
  children,
}: ProjectActionsProps) => {
  const { t } = useLingui()
  const {
    isMobile,
    mobileMenuOpen,
    longPressFired,
    longPressHandlers,
    actions,
    handleCloseAutoFocus,
    handleMobileOpenChange,
  } = useProjectActionsState(projectActions)
  const pinned = project.pinnedOrder !== null
  const menu = (
    <DetailActionsMenu
      side="right"
      align="start"
      triggerClassName={triggerClassName}
      onCloseAutoFocus={handleCloseAutoFocus}
    >
      <ProjectActionMenuItems pinned={pinned} {...actions} />
    </DetailActionsMenu>
  )

  return (
    <>
      {isMobile ? (
        <ResponsiveActionMenu
          open={mobileMenuOpen}
          onOpenChange={handleMobileOpenChange}
          title={project.name}
          openOnTriggerClickMobile={false}
          trigger={
            <Slot
              {...longPressHandlers}
              data-long-press=""
              data-state={mobileMenuOpen ? 'open' : 'closed'}
              onClickCapture={(event) => {
                if (longPressFired.current) {
                  longPressFired.current = false
                  event.stopPropagation()
                  event.preventDefault()
                }
              }}
            >
              {children(null)}
            </Slot>
          }
          actions={[
            { label: t`New chat`, icon: <MessageCirclePlus className="size-4" />, onSelect: actions.onNewChat },
            {
              label: pinned ? t`Unpin` : t`Pin`,
              icon: pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />,
              onSelect: actions.onTogglePin,
            },
            { label: t`Edit`, icon: <SquarePen className="size-4" />, onSelect: actions.onEdit },
            { label: t`Delete`, icon: <Trash2 className="size-4" />, onSelect: actions.onDelete },
          ]}
        />
      ) : (
        <ContextMenu>
          <ContextMenuTrigger asChild>{children(menu)}</ContextMenuTrigger>
          <ContextMenuContent className="min-w-56" onCloseAutoFocus={handleCloseAutoFocus}>
            <ProjectActionMenuItems context pinned={pinned} {...actions} />
          </ContextMenuContent>
        </ContextMenu>
      )}
    </>
  )
}
