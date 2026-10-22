/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { LayoutGrid } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { useProjectArtifactsState, useProjectsState } from '@/dal/projects'
import { PageFallback } from '@/loading'
import { ProjectArtifactGallery } from './project-artifact-gallery'

const ProjectArtifactsDialogContent = ({ projectId }: { projectId: string }) => {
  const { t } = useLingui()
  const { projects, isLoading } = useProjectsState()
  const { artifacts, isLoading: artifactsLoading } = useProjectArtifactsState(projectId)
  const project = projects.find((item) => item.id === projectId)
  if (isLoading || artifactsLoading) {
    return <PageFallback />
  }
  if (!project) {
    return <EmptyState icon={LayoutGrid} title={t`Project unavailable`} />
  }
  return <ProjectArtifactGallery project={project} artifacts={artifacts} />
}

export default ProjectArtifactsDialogContent
