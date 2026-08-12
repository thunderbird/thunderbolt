/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Projects list. A project is a workspace: durable instructions plus a text
 * knowledge set that every chat inside it inherits.
 *
 * Layout follows the skills page (`src/skills/skills-view.tsx`): a
 * `SettingsListPane` + `PageSearch` + `SettingsListBody` column beside a
 * `DetailPanelSurface` that slides in for create. That shell is not decoration —
 * `PageHeader` portals into the mobile app-header row and `PageCreateAction`
 * positions itself against the pane, so both misplace themselves in a plain div.
 */

import { FolderOpen } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'

import { DetailPanelSurface } from '@/components/detail-panel'
import { IconTile } from '@/components/settings/icon-tile'
import {
  SettingsListBody,
  SettingsListPane,
  SettingsSelectableRow,
  settingsListBodyRowsClass,
} from '@/components/settings/settings-list'
import { PageCreateAction } from '@/components/ui/page-create-action'
import { PageHeader } from '@/components/ui/page-header'
import { PageSearch } from '@/components/ui/page-search'
import { useProjectChatCounts, useProjects } from '@/dal/projects'
import { CreateProjectPanel } from './create-project-panel'
import { ProjectIcon } from './project-icon'

const ProjectsPage = () => {
  const navigate = useNavigate()
  const projects = useProjects()
  const [search, setSearch] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  // Reactive: a chat moving in or out of a project updates the count immediately.
  const chatCounts = useProjectChatCounts()

  const term = search.trim().toLowerCase()
  const visible = term
    ? projects.filter((project) =>
        [project.name, project.description ?? ''].some((field) => field.toLowerCase().includes(term)),
      )
    : projects

  const countLabel = (id: string): string => {
    const count = chatCounts[id] ?? 0
    return count === 1 ? '1 chat' : `${count} chats`
  }

  return (
    // `md:pt-[var(--header-inset)]` is load-bearing: unlike the settings layout,
    // `main-layout` gives its content area NO top padding — chat is meant to
    // scroll under the floating header's z-20 scrim. A top-level page must clear
    // that band itself or its header renders behind the blur. Mobile is handled
    // by `SettingsListBody`'s own inset (and PageHeader portals into the app bar).
    <div className="relative flex h-full md:pt-[var(--header-inset)]">
      <div className="min-w-0 flex-1 overflow-hidden">
        <SettingsListPane>
          <PageSearch onSearch={setSearch}>
            <PageHeader title="Projects">
              <PageSearch.Button />
              <PageCreateAction label="New project" onClick={() => setIsCreating(true)} />
            </PageHeader>

            <PageSearch.Input placeholder="Search projects" onSearch={setSearch} />
          </PageSearch>

          <SettingsListBody className={settingsListBodyRowsClass}>
            {visible.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                <FolderOpen className="size-8 text-muted-foreground" aria-hidden="true" />
                <p className="text-[length:var(--font-size-body)] font-medium">
                  {term ? 'No matching projects' : 'No projects yet'}
                </p>
                {!term && (
                  <p className="max-w-sm text-[length:var(--font-size-sm)] text-muted-foreground">
                    A project keeps instructions and reference documents in one place, so every chat inside it starts
                    with the same context.
                  </p>
                )}
              </div>
            ) : (
              visible.map((project) => (
                <SettingsSelectableRow
                  key={project.id}
                  title={project.name}
                  subtitle={[project.description, countLabel(project.id)].filter(Boolean).join(' · ')}
                  leading={
                    <IconTile>
                      <ProjectIcon icon={project.icon} className="size-5 text-[1.15rem]" />
                    </IconTile>
                  }
                  onSelect={() => navigate(`/projects/${project.id}`)}
                  ariaLabel={`Open ${project.name}`}
                />
              ))
            )}
          </SettingsListBody>
        </SettingsListPane>
      </div>

      <DetailPanelSurface open={isCreating} onClose={() => setIsCreating(false)}>
        {isCreating && (
          <CreateProjectPanel
            onClose={() => setIsCreating(false)}
            onCreated={(projectId) => {
              setIsCreating(false)
              navigate(`/projects/${projectId}`)
            }}
          />
        )}
      </DetailPanelSurface>
    </div>
  )
}

export default ProjectsPage
