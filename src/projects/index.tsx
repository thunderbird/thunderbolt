/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Projects list. A project is a workspace: durable instructions that every chat
 * inside it inherits.
 *
 * Layout follows the skills page (`src/skills/skills-view.tsx`): a
 * `SettingsListPane` + `PageSearch` + `SettingsListBody` column beside a
 * `DetailPanelSurface` that slides in for create. That shell is not decoration —
 * `PageHeader` portals into the mobile app-header row and `PageCreateAction`
 * positions itself against the pane, so both misplace themselves in a plain div.
 */

import { FolderOpen, Plus } from 'lucide-react'
import { useReducer } from 'react'
import { useNavigate, useParams } from 'react-router'

import { DetailPanel, DetailPanelSurface } from '@/components/detail-panel'
import { IconTile } from '@/components/settings/icon-tile'
import {
  SettingsListBody,
  SettingsListPane,
  SettingsSelectableRow,
  settingsListBodyRowsClass,
} from '@/components/settings/settings-list'
import { Button } from '@/components/ui/button'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { PageCreateAction } from '@/components/ui/page-create-action'
import { PageHeader } from '@/components/ui/page-header'
import { PageSearch } from '@/components/ui/page-search'
import { useDatabase } from '@/contexts'
import {
  softDeleteProject,
  updateProject,
  useProjectArtifacts,
  useProjectChatCounts,
  useProjectChats,
  useProjects,
} from '@/dal/projects'
import { CreateProjectPanel } from './create-project-panel'
import { ProjectDetailPanel, deleteProjectPrompt } from './project-detail-panel'
import { ProjectForm } from './project-form'
import { initialViewState, projectsViewReducer } from './projects-view-state'
import { ProjectIcon } from './project-icon'

const ProjectsPage = () => {
  const db = useDatabase()
  const navigate = useNavigate()
  const projects = useProjects()
  const { projectId } = useParams<{ projectId: string }>()
  const [{ search, overlay, isDeleteRequested }, dispatch] = useReducer(projectsViewReducer, initialViewState)

  // Resolved against the live list, so a rename or an emoji change reaches the
  // open panel — and a project deleted on another device closes it on its own.
  //
  // An id that matches nothing simply shows the list with no panel. Deliberately
  // not a redirect: `projects` is empty on the reactive query's first tick, so
  // redirecting on "not found" would bounce every valid deep link on a cold load.
  const selected = projectId ? projects.find((project) => project.id === projectId) : undefined
  // Creating replaces whatever was selected, so the surface only ever shows one.
  const showCreate = overlay === 'create'
  const selectedChats = useProjectChats(selected?.id)
  const selectedArtifacts = useProjectArtifacts(selected?.id)

  // Reactive: a chat moving in or out of a project updates the count immediately.
  const chatCounts = useProjectChatCounts()

  const term = search.trim().toLowerCase()
  const visible = term
    ? projects.filter((project) =>
        [project.name, project.description ?? ''].some((field) => field.toLowerCase().includes(term)),
      )
    : projects

  // Only the genuinely-empty account hides the header controls. A search that
  // matches nothing must keep the search field, or there's no way to clear it.
  const showEmptyState = projects.length === 0

  /** Closing the panel clears the selection, which lives in the route. */
  const closePanel = () => {
    dispatch({ type: 'OVERLAY_CLOSED' })
    navigate('/projects')
  }

  /** Creating also drops the selection: the surface shows one panel, so leaving a
   *  row highlighted behind the create form would misreport what's open. */
  const startCreate = () => {
    dispatch({ type: 'CREATE_STARTED' })
    navigate('/projects')
  }

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
          <PageSearch onSearch={(value) => dispatch({ type: 'SEARCH_CHANGED', value })}>
            <PageHeader title="Projects">
              {/* Nothing to search or sit beside yet, and the empty state carries
                  its own call to action — same as the tasks page. */}
              {!showEmptyState && (
                <>
                  <PageSearch.Button />
                  <PageCreateAction label="New project" onClick={startCreate} />
                </>
              )}
            </PageHeader>

            <PageSearch.Input
              placeholder="Search projects"
              onSearch={(value) => dispatch({ type: 'SEARCH_CHANGED', value })}
            />
          </PageSearch>

          <SettingsListBody className={settingsListBodyRowsClass}>
            {visible.length === 0 ? (
              <EmptyState
                icon={FolderOpen}
                title={term ? 'No matching projects' : 'No projects yet'}
                description={
                  term
                    ? undefined
                    : 'A project keeps your instructions in one place, so every chat inside it starts with the same context.'
                }
                action={
                  term ? undefined : (
                    <Button variant="outline" onClick={startCreate} className="gap-2">
                      <Plus className="size-[var(--icon-size-sm)]" aria-hidden="true" />
                      Create your first project
                    </Button>
                  )
                }
              />
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
                  isSelected={project.id === projectId}
                  onSelect={() => {
                    dispatch({ type: 'OVERLAY_CLOSED' })
                    navigate(`/projects/${project.id}`)
                  }}
                  ariaLabel={`Open ${project.name}`}
                />
              ))
            )}
          </SettingsListBody>
        </SettingsListPane>
      </div>

      {/* One surface for both panels: create and detail are mutually exclusive,
          and sharing it keeps a single slide-in animation. */}
      <DetailPanelSurface open={showCreate || selected !== undefined} onClose={closePanel}>
        {showCreate ? (
          <CreateProjectPanel
            onClose={closePanel}
            onCreated={(createdId) => {
              dispatch({ type: 'OVERLAY_CLOSED' })
              navigate(`/projects/${createdId}`)
            }}
          />
        ) : selected && overlay === 'edit' ? (
          // Keyed on the project so switching rows mid-edit can't carry one
          // project's typing into another's form.
          <DetailPanel title="Edit project" onClose={() => dispatch({ type: 'OVERLAY_CLOSED' })}>
            <ProjectForm
              key={selected.id}
              mode="edit"
              initialValues={{
                icon: selected.icon,
                name: selected.name,
                description: selected.description ?? '',
                instructions: selected.instructions ?? '',
              }}
              onCancel={() => dispatch({ type: 'OVERLAY_CLOSED' })}
              onSubmit={async ({ icon, name, description, instructions }) => {
                await updateProject(db, selected.id, {
                  icon,
                  name,
                  description: description.trim() || null,
                  instructions: instructions.trim() || null,
                })
                dispatch({ type: 'OVERLAY_CLOSED' })
              }}
            />
          </DetailPanel>
        ) : selected ? (
          <ProjectDetailPanel
            project={selected}
            chats={selectedChats}
            artifacts={selectedArtifacts}
            onEdit={() => dispatch({ type: 'EDIT_STARTED' })}
            onDelete={() => dispatch({ type: 'DELETE_REQUESTED' })}
            onClose={closePanel}
            onOpenChat={(chatThreadId) => navigate(`/chats/${chatThreadId}`)}
            onNewChat={() => navigate(`/chats/new?projectId=${selected.id}`)}
          />
        ) : null}
      </DetailPanelSurface>

      {selected && isDeleteRequested && (
        <ConfirmActionDialog
          open
          {...deleteProjectPrompt}
          onConfirm={async () => {
            closePanel()
            await softDeleteProject(db, selected.id)
          }}
          onCancel={() => dispatch({ type: 'DELETE_DISMISSED' })}
        />
      )}
    </div>
  )
}

export default ProjectsPage
