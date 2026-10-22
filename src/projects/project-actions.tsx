/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { Slot } from '@radix-ui/react-slot'
import { LayoutGrid, MessageCirclePlus, SquarePen, Trash2 } from 'lucide-react'
import type { ReactElement, ReactNode } from 'react'
import { useProjectActionsState } from './use-project-actions-state'
import { DetailActionsMenu } from '@/components/settings/detail-actions-menu'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { ResponsiveActionMenu } from '@/components/ui/responsive-action-menu'
import type { Project } from '@/types'
import { ProjectEditorDialog } from './project-editor-dialog'
import { ProjectActionMenuItems } from './project-action-menu-items'

type ProjectActionsProps = {
  project: Project
  onNewChat: () => void
  onOpenArtifacts: () => void
  onDeleted: () => void
  triggerClassName?: string
  children: (menu: ReactNode) => ReactElement
}

/** Project navigation and management from the sidebar row. */
export const ProjectActions = ({
  project,
  onNewChat,
  onOpenArtifacts,
  onDeleted,
  triggerClassName,
  children,
}: ProjectActionsProps) => {
  const { t } = useLingui()
  const {
    isMobile,
    dialog,
    error,
    isPending,
    mobileMenuOpen,
    longPressFired,
    longPressHandlers,
    actions,
    handleOpenChange,
    handleCloseAutoFocus,
    handleMobileOpenChange,
    closeDialog,
    deleteProject,
  } = useProjectActionsState({ projectId: project.id, onNewChat, onOpenArtifacts, onDeleted })
  const menu = (
    <DetailActionsMenu
      side="right"
      align="start"
      triggerClassName={triggerClassName}
      onOpenChange={handleOpenChange}
      onCloseAutoFocus={handleCloseAutoFocus}
    >
      <ProjectActionMenuItems {...actions} />
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
            { label: t`Artifacts`, icon: <LayoutGrid className="size-4" />, onSelect: actions.onOpenArtifacts },
            { label: t`Edit`, icon: <SquarePen className="size-4" />, onSelect: actions.onEdit },
            { label: t`Delete`, icon: <Trash2 className="size-4" />, onSelect: actions.onDelete },
          ]}
        />
      ) : (
        <ContextMenu onOpenChange={handleOpenChange}>
          <ContextMenuTrigger asChild>{children(menu)}</ContextMenuTrigger>
          <ContextMenuContent className="min-w-56" onCloseAutoFocus={handleCloseAutoFocus}>
            <ProjectActionMenuItems context {...actions} />
          </ContextMenuContent>
        </ContextMenu>
      )}
      {dialog === 'edit' && <ProjectEditorDialog project={project} onClose={closeDialog} />}
      {dialog === 'delete' && (
        <ConfirmActionDialog
          open
          title={t`Delete this project?`}
          description={
            error ?? t`Its instructions are removed. Chats in the project are kept and become ordinary chats.`
          }
          confirmLabel={t`Delete project`}
          isPending={isPending}
          onCancel={closeDialog}
          onConfirm={deleteProject}
        />
      )}
    </>
  )
}
