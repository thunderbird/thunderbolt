/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { artifactPath } from '@/artifacts/artifact'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { RenameArtifactDialog } from '@/projects/rename-artifact-dialog'
import { ArtifactContextMenu } from './artifact-context-menu'
import { useArtifactSectionActions } from './use-artifact-section-actions'
import { ArtifactSectionMenu } from './artifact-section-menu'
import { SidebarListToggle } from './sidebar-list-toggle'
import { SidebarSectionToggle } from './sidebar-section-toggle'
import { useArtifactSectionState } from './use-artifact-section-state'

type ArtifactSectionProps = {
  pathname: string
  isCollapsed: boolean
  onNavigate: (path: string) => void
}

/** Pins use the same sidebar disclosure and preview behavior as projects and recent chats. */
export const ArtifactSection = ({ pathname, isCollapsed, onNavigate }: ArtifactSectionProps) => {
  const { t } = useLingui()
  const actions = useArtifactSectionActions()
  const { artifacts, loading, failed, activeId, preview, expanded, toggle } = useArtifactSectionState(pathname)
  return (
    <>
      {isCollapsed ? (
        <ArtifactSectionMenu preview={preview} activeId={activeId} onNavigate={onNavigate} actions={actions} />
      ) : (
        <div>
          <div className="flex items-center justify-between max-md:mb-2">
            <SidebarSectionToggle
              expanded={expanded}
              onToggle={toggle}
              controls="sidebar-artifacts-section"
              label={t`Artifacts`}
            />
          </div>
          <div id="sidebar-artifacts-section" hidden={!expanded}>
            <SidebarMenu id="sidebar-artifacts">
              {preview.items.map((artifact) => (
                <SidebarMenuItem key={artifact.id}>
                  <ArtifactContextMenu artifact={artifact} actions={actions} onNavigate={onNavigate}>
                    <SidebarMenuButton
                      onClick={() => onNavigate(artifactPath(artifact.id))}
                      tooltip={artifact.title}
                      className="cursor-pointer"
                      isActive={artifact.id === activeId}
                    >
                      <span>{artifact.title}</span>
                    </SidebarMenuButton>
                  </ArtifactContextMenu>
                </SidebarMenuItem>
              ))}
              {preview.hasOverflow && (
                <SidebarMenuItem>
                  <SidebarListToggle
                    showAll={preview.showAll}
                    onToggle={preview.toggle}
                    controls="sidebar-artifacts"
                    label={preview.showAll ? t`Show fewer artifacts` : t`Show more artifacts`}
                  />
                </SidebarMenuItem>
              )}
            </SidebarMenu>
            {!loading && artifacts.length === 0 && (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                {failed ? (
                  <Trans>Couldn't load pinned artifacts.</Trans>
                ) : (
                  <Trans>Pin artifacts to keep them here.</Trans>
                )}
              </p>
            )}
          </div>
        </div>
      )}
      {actions.error && !actions.renaming && (
        <p role="alert" className="px-2 py-1 text-xs text-destructive">
          {actions.error}
        </p>
      )}
      {actions.renaming && (
        <RenameArtifactDialog
          key={actions.renaming.id}
          title={actions.renaming.title}
          error={actions.error}
          isPending={actions.isPending}
          onSave={actions.rename}
          onClose={actions.closeRename}
        />
      )}
    </>
  )
}
