/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useRef, type ReactNode } from 'react'
import { Trans } from '@lingui/react/macro'
import { ArrowUpRight, MessageCircle, PinOff, SquarePen } from 'lucide-react'
import { artifactPath, type Artifact } from '@/artifacts/artifact'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import type { useArtifactSectionActions } from './use-artifact-section-actions'

type ArtifactContextMenuProps = {
  artifact: Artifact
  actions: ReturnType<typeof useArtifactSectionActions>
  onNavigate: (path: string) => void
  children: ReactNode
}

/** Shared context actions keep artifact rows title-only in the sidebar and collapsed-rail menu. */
export const ArtifactContextMenu = ({ artifact, actions, onNavigate, children }: ArtifactContextMenuProps) => {
  const openingDialog = useRef(false)
  const chatThreadId = artifact.chatThreadId
  return (
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
        <ContextMenuItem onSelect={() => onNavigate(artifactPath(artifact.id))}>
          <ArrowUpRight />
          <Trans>Open artifact</Trans>
        </ContextMenuItem>
        {chatThreadId && (
          <ContextMenuItem onSelect={() => onNavigate(`/chats/${encodeURIComponent(chatThreadId)}?view=chat`)}>
            <MessageCircle />
            <Trans>Open source chat</Trans>
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={actions.isPending}
          onSelect={() => {
            openingDialog.current = true
            actions.openRename(artifact)
          }}
        >
          <SquarePen />
          <Trans>Rename</Trans>
        </ContextMenuItem>
        <ContextMenuItem disabled={actions.isPending} onSelect={() => actions.unpin(artifact)}>
          <PinOff />
          <Trans>Unpin artifact</Trans>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
