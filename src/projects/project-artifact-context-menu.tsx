/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useRef, type ReactNode } from 'react'
import { Trans } from '@lingui/react/macro'
import { ArrowUpRight, Download, MessageCircle, Pin, PinOff, SquarePen, Trash2 } from 'lucide-react'
import { useNavigate } from 'react-router'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import type { ProjectArtifact } from './project-artifacts-data'
import { useProjectArtifactActions } from './project-artifact-actions-provider'
import { projectArtifactPath } from './project-artifact-path'

type ProjectArtifactContextMenuProps = {
  artifact: ProjectArtifact
  projectId: string
  pinned: boolean
  isSaving: boolean
  onTogglePin: () => void
  children: ReactNode
}

/** The card stays uncluttered; right-click or long-press exposes its file actions. */
export const ProjectArtifactContextMenu = ({
  artifact,
  projectId,
  pinned,
  isSaving,
  onTogglePin,
  children,
}: ProjectArtifactContextMenuProps) => {
  const navigate = useNavigate()
  const actions = useProjectArtifactActions()
  const openingDialog = useRef(false)
  const openDialog = (dialog: 'rename' | 'delete') => {
    openingDialog.current = true
    actions.openDialog(artifact, dialog)
  }
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent
          className="min-w-56"
          onCloseAutoFocus={(event) => {
            if (openingDialog.current) {
              event.preventDefault()
              openingDialog.current = false
            }
          }}
        >
          <ContextMenuItem onSelect={() => navigate(projectArtifactPath(projectId, artifact.id))}>
            <ArrowUpRight />
            <Trans>Open artifact</Trans>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => navigate(`/chats/${artifact.chatThreadId}`)}>
            <MessageCircle />
            <Trans>Open source chat</Trans>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={isSaving} onSelect={onTogglePin}>
            {pinned ? <PinOff /> : <Pin />}
            {pinned ? <Trans>Unpin from project</Trans> : <Trans>Pin to project</Trans>}
          </ContextMenuItem>
          <ContextMenuItem disabled={actions.isPending} onSelect={() => openDialog('rename')}>
            <SquarePen />
            <Trans>Rename</Trans>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={actions.isPending} onSelect={() => actions.downloadHtml(artifact)}>
            <Download />
            <Trans>Download HTML</Trans>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" disabled={actions.isPending} onSelect={() => openDialog('delete')}>
            <Trash2 />
            <Trans>Delete</Trans>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </>
  )
}
