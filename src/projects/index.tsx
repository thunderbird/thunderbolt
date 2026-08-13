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

import { FolderOpen, Plus } from 'lucide-react'
import { useReducer } from 'react'
import { useNavigate } from 'react-router'

import { DetailPanelSurface } from '@/components/detail-panel'
import { IconTile } from '@/components/settings/icon-tile'
import {
  SettingsListBody,
  SettingsListPane,
  SettingsSelectableRow,
  settingsListBodyRowsClass,
} from '@/components/settings/settings-list'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PageCreateAction } from '@/components/ui/page-create-action'
import { PageHeader } from '@/components/ui/page-header'
import { PageSearch } from '@/components/ui/page-search'
import { useDatabase } from '@/contexts'
import { softDeleteProject, useProjectChatCounts, useProjectChats, useProjects } from '@/dal/projects'
import { CreateProjectPanel } from './create-project-panel'
import { ProjectDetailPanel } from './project-detail-panel'
import { ProjectIcon } from './project-icon'

/**
 * The list page's view state. A reducer rather than three `useState` calls
 * because the panel is one slot: opening create must clear any selection and
 * vice versa. As separate setters that invariant lives in every call site; here
 * it lives once, in the transitions.
 */
type ProjectsViewState = {
  search: string
  isCreating: boolean
  selectedId: string | null
}

type ProjectsViewAction =
  | { type: 'SEARCH_CHANGED'; value: string }
  | { type: 'CREATE_STARTED' }
  | { type: 'PROJECT_SELECTED'; id: string }
  | { type: 'PANEL_CLOSED' }

const initialViewState: ProjectsViewState = { search: '', isCreating: false, selectedId: null }

const projectsViewReducer = (state: ProjectsViewState, action: ProjectsViewAction): ProjectsViewState => {
  switch (action.type) {
    case 'SEARCH_CHANGED':
      return { ...state, search: action.value }
    case 'CREATE_STARTED':
      return { ...state, isCreating: true, selectedId: null }
    case 'PROJECT_SELECTED':
      return { ...state, isCreating: false, selectedId: action.id }
    case 'PANEL_CLOSED':
      return { ...state, isCreating: false, selectedId: null }
  }
}

const ProjectsPage = () => {
  const db = useDatabase()
  const navigate = useNavigate()
  const projects = useProjects()
  const [{ search, isCreating, selectedId }, dispatch] = useReducer(projectsViewReducer, initialViewState)

  // Selection is resolved against the live list, so a rename or an emoji change
  // reaches the open panel, and a deleted project closes it on its own.
  const selected = selectedId ? projects.find((project) => project.id === selectedId) : undefined
  const selectedChats = useProjectChats(selected?.id)

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
                  <PageCreateAction label="New project" onClick={() => dispatch({ type: 'CREATE_STARTED' })} />
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
                    : 'A project keeps instructions and reference documents in one place, so every chat inside it starts with the same context.'
                }
                action={
                  term ? undefined : (
                    <Button variant="outline" onClick={() => dispatch({ type: 'CREATE_STARTED' })} className="gap-2">
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
                  isSelected={project.id === selectedId}
                  onSelect={() => dispatch({ type: 'PROJECT_SELECTED', id: project.id })}
                  ariaLabel={`Open ${project.name}`}
                />
              ))
            )}
          </SettingsListBody>
        </SettingsListPane>
      </div>

      {/* One surface for both panels: create and detail are mutually exclusive,
          and sharing it keeps a single slide-in animation. */}
      <DetailPanelSurface
        open={isCreating || selected !== undefined}
        onClose={() => dispatch({ type: 'PANEL_CLOSED' })}
      >
        {isCreating ? (
          <CreateProjectPanel
            onClose={() => dispatch({ type: 'PANEL_CLOSED' })}
            onCreated={(projectId) => {
              dispatch({ type: 'PANEL_CLOSED' })
              navigate(`/projects/${projectId}`)
            }}
          />
        ) : selected ? (
          <ProjectDetailPanel
            project={selected}
            chats={selectedChats}
            onEdit={() => navigate(`/projects/${selected.id}`)}
            onDelete={async () => {
              await softDeleteProject(db, selected.id)
              dispatch({ type: 'PANEL_CLOSED' })
            }}
            onClose={() => dispatch({ type: 'PANEL_CLOSED' })}
            onOpenChat={(chatThreadId) => navigate(`/chats/${chatThreadId}`)}
          />
        ) : null}
      </DetailPanelSurface>
    </div>
  )
}

export default ProjectsPage
