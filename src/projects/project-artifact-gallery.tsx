/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { LayoutGrid, Plus } from 'lucide-react'
import { Link, useNavigate } from 'react-router'
import { SettingsEmptyState, SettingsNoResults } from '@/components/settings/settings-empty-state'
import { Button } from '@/components/ui/button'
import { SearchInput } from '@/components/ui/search-input'
import type { Project } from '@/types'
import type { ProjectArtifact } from './project-artifacts-data'
import { ProjectArtifactGrid } from './project-artifact-grid'
import { ProjectIcon } from './project-icon'
import { useProjectArtifactPins } from './use-project-artifact-pins'

export const ProjectArtifactGallery = ({ project, artifacts }: { project: Project; artifacts: ProjectArtifact[] }) => {
  const { t } = useLingui()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const pins = useProjectArtifactPins(project.id, artifacts)
  const term = search.trim().toLowerCase()
  const visible = artifacts.filter((artifact) =>
    [artifact.title, artifact.chatTitle].some((text) => text.toLowerCase().includes(term)),
  )
  return (
    <section className="@container/artifact-gallery flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-col gap-4 border-b p-5 md:px-6 @min-[640px]/artifact-gallery:flex-row @min-[640px]/artifact-gallery:items-end @min-[640px]/artifact-gallery:pr-14">
        <div className="min-w-0 flex-1 pr-10 @min-[640px]/artifact-gallery:pr-0">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <ProjectIcon icon={project.icon} className="size-3.5 shrink-0 text-sm" />
            <Link to={`/chats/new?projectId=${project.id}`} className="truncate hover:text-foreground hover:underline">
              {project.name}
            </Link>
          </div>
          <h2 className="text-2xl font-bold tracking-tight">
            <Trans>Artifacts</Trans>
          </h2>
        </div>
        <SearchInput
          containerClassName="@min-[640px]/artifact-gallery:w-72"
          showIcon
          placeholder={t`Search artifacts`}
          aria-label={t`Search artifacts`}
          debouncedOnChange={setSearch}
        />
      </header>
      <div className="flex min-h-0 flex-col p-5 md:px-6">
        {pins.error && (
          <p role="alert" className="mb-4 text-sm text-destructive">
            {pins.error}
          </p>
        )}
        {visible.length > 0 && (
          <ProjectArtifactGrid
            key={term}
            artifacts={visible}
            projectId={project.id}
            pinnedIds={pins.pinnedIds}
            isSaving={pins.isSaving}
            onTogglePin={(id) => void pins.togglePin(id)}
          />
        )}
        {visible.length === 0 &&
          (term ? (
            <SettingsNoResults>
              <Trans>No matching artifacts</Trans>
            </SettingsNoResults>
          ) : (
            <SettingsEmptyState
              icon={<LayoutGrid className="size-8 text-muted-foreground" />}
              title={t`A home for what you create`}
              description={t`Charts, prototypes, and other artifacts from this project's chats appear here. Pin your favorites to keep them in the sidebar.`}
              action={
                <Button variant="outline" onClick={() => navigate(`/chats/new?projectId=${project.id}`)}>
                  <Plus />
                  <Trans>New chat</Trans>
                </Button>
              }
            />
          ))}
      </div>
    </section>
  )
}
