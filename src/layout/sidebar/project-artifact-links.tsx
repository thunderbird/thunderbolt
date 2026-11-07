/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Pin } from 'lucide-react'
import { useNavigate, useParams } from 'react-router'
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar'
import { useContentView } from '@/content-view/context'
import { useProjectArtifacts } from '@/dal/projects'
import { useProjectArtifactPins } from '@/projects/use-project-artifact-pins'

/** Query only expanded projects and expose their pinned artifact shortcuts. */
export const ProjectArtifactLinks = ({ projectId, isMobile }: { projectId: string; isMobile: boolean }) => {
  const artifacts = useProjectArtifacts(projectId)
  const { pinnedIds } = useProjectArtifactPins(projectId, artifacts)
  const selected = useParams()
  const navigate = useNavigate()
  const contentView = useContentView()
  const { closeMobileSidebar } = useSidebar()
  const open = async (artifactId: string) => {
    contentView.close()
    if (isMobile) {
      await closeMobileSidebar()
    }
    navigate(`/projects/${projectId}/artifacts/${artifactId}`)
  }
  return (
    <>
      {pinnedIds.map((id) => {
        const artifact = artifacts.find((item) => item.id === id)!
        return (
          <SidebarMenuItem key={id}>
            <SidebarMenuButton
              tooltip={artifact.title}
              isActive={selected.artifactId === id}
              onClick={() => void open(id)}
              className="cursor-pointer gap-2"
            >
              <Pin className="size-[var(--icon-size-default)] shrink-0 text-muted-foreground" />
              <span className="truncate">{artifact.title}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )
      })}
    </>
  )
}
