/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { selectMinimalMode, useConfigStore } from '@/api/config-store'
import { LayoutGrid } from 'lucide-react'
import { Navigate, useNavigate, useParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { useProjectArtifactsState, useProjectsState } from '@/dal/projects'
import { PageFallback } from '@/loading'
import { ProjectArtifactWorkspace } from './project-artifact-workspace'

const ProjectArtifactsView = () => {
  const { t } = useLingui()
  const { projectId, artifactId } = useParams()
  const navigate = useNavigate()
  const { projects, isLoading } = useProjectsState()
  const { artifacts, isLoading: artifactsLoading } = useProjectArtifactsState(projectId)
  const project = projects.find((item) => item.id === projectId)
  const artifact = artifacts.find((item) => item.id === artifactId)
  if (!artifactId && projectId) {
    const params = new URLSearchParams({ projectId, artifacts: projectId })
    return <Navigate replace to={`/chats/new?${params}`} />
  }
  if (isLoading || artifactsLoading) {
    return <PageFallback />
  }
  if (!project || !artifact) {
    return (
      <div className="h-full pt-[var(--header-inset)]">
        <EmptyState
          icon={LayoutGrid}
          title={project ? t`Artifact unavailable` : t`Project unavailable`}
          description={project ? t`Its source chat may have been moved or deleted.` : undefined}
          action={
            <Button
              variant="outline"
              onClick={() => navigate(project ? `/projects/${project.id}/artifacts` : '/chats/new')}
            >
              <Trans>Go back</Trans>
            </Button>
          }
        />
      </div>
    )
  }
  return <ProjectArtifactWorkspace key={artifact.id} project={project} artifact={artifact} artifacts={artifacts} />
}

const ProjectArtifactsPage = () => {
  const minimalMode = useConfigStore((state) => selectMinimalMode(state.config))
  return minimalMode ? <Navigate replace to="/chats/new" /> : <ProjectArtifactsView />
}

export default ProjectArtifactsPage
