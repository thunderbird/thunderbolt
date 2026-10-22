/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { AppWindow } from 'lucide-react'
import { artifactPath, type Artifact } from '@/artifacts/artifact'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { ArtifactContextMenu } from './artifact-context-menu'
import type { useArtifactSectionActions } from './use-artifact-section-actions'
import type { useSidebarPreviewState } from './use-sidebar-preview-state'

type ArtifactSectionMenuProps = {
  preview: ReturnType<typeof useSidebarPreviewState<Artifact>>
  activeId?: string
  actions: ReturnType<typeof useArtifactSectionActions>
  onNavigate: (path: string) => void
}

/** Keep pinned artifacts together behind one button when the sidebar is collapsed. */
export const ArtifactSectionMenu = ({ preview, activeId, onNavigate, actions }: ArtifactSectionMenuProps) => {
  const { t } = useLingui()
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton tooltip={t`Artifacts`} aria-label={t`Artifacts`} isActive={activeId !== undefined}>
              <AppWindow />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="right"
            align="start"
            sideOffset={8}
            className="w-72"
            onCloseAutoFocus={(event) => {
              if (actions.renaming) {
                event.preventDefault()
              }
            }}
          >
            <DropdownMenuLabel className="text-muted-foreground">
              <Trans>Artifacts</Trans>
            </DropdownMenuLabel>
            {preview.items.map((artifact) => (
              <ArtifactContextMenu key={artifact.id} artifact={artifact} actions={actions} onNavigate={onNavigate}>
                <DropdownMenuItem
                  aria-current={artifact.id === activeId ? 'page' : undefined}
                  className={cn('cursor-pointer', artifact.id === activeId && 'bg-accent font-medium')}
                  onSelect={() => onNavigate(artifactPath(artifact.id))}
                >
                  <span className="truncate">{artifact.title}</span>
                </DropdownMenuItem>
              </ArtifactContextMenu>
            ))}
            {preview.hasOverflow && (
              <DropdownMenuItem
                className="text-muted-foreground"
                onSelect={(event) => {
                  event.preventDefault()
                  preview.toggle()
                }}
              >
                {preview.showAll ? <Trans>Show less</Trans> : <Trans>Show more</Trans>}
              </DropdownMenuItem>
            )}
            {preview.items.length === 0 && (
              <p className="px-2 py-3 text-sm text-muted-foreground">
                <Trans>Pin artifacts to keep them here.</Trans>
              </p>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
