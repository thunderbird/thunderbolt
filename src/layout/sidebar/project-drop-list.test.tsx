/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { DndContext } from '@dnd-kit/core'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { MemoryRouter } from 'react-router'
import { SidebarProvider } from '@/components/ui/sidebar'
import type { Project } from '@/types'
import { ProjectDropRows } from './project-drop-list'

afterEach(cleanup)

const twoProjects = [
  { id: 'p1', name: 'Q3 Planning', icon: '📊' },
  { id: 'p2', name: 'Cabin build', icon: null },
] as unknown as Project[]

/** Eight projects, `p1`..`p8` — three past the five-row idle cap. */
const manyProjects = Array.from({ length: 8 }, (_unused, index) => ({
  id: `p${index + 1}`,
  name: `Project ${index + 1}`,
  icon: null,
})) as unknown as Project[]

let projectList = twoProjects

beforeEach(() => {
  projectList = twoProjects
})

/**
 * The rows are tested through `ProjectDropRows`, which takes the project list as a
 * prop — deliberately, rather than `mock.module('@/dal/projects', …)` on the
 * live-data `ProjectDropList`. Bun installs module mocks worker-wide, so that
 * override would leak `useProjects` into every sibling test in the worker.
 */
const renderAt = (path: string, { isDragging = false } = {}) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <SidebarProvider>
        <DndContext>
          <ProjectDropRows projects={projectList} isDragging={isDragging} draggingFromProjectId={null} />
        </DndContext>
      </SidebarProvider>
    </MemoryRouter>,
  )

/** Sidebar buttons mark selection with `data-active`. */
const rowFor = (name: string) => screen.getByText(name).closest('[data-active]')

describe('ProjectDropRows active state', () => {
  it('highlights the project whose page is open', () => {
    renderAt('/projects/p1')
    // Italo's report: selecting a project left its sidebar row unhighlighted.
    expect(rowFor('Q3 Planning')).toHaveAttribute('data-active', 'true')
  })

  it('leaves the other projects unhighlighted', () => {
    renderAt('/projects/p1')
    expect(rowFor('Cabin build')).toHaveAttribute('data-active', 'false')
  })

  it('highlights nothing on the projects list route', () => {
    renderAt('/projects')
    expect(rowFor('Q3 Planning')).toHaveAttribute('data-active', 'false')
    expect(rowFor('Cabin build')).toHaveAttribute('data-active', 'false')
  })

  it('highlights nothing from an unrelated route', () => {
    renderAt('/chats/abc')
    expect(rowFor('Q3 Planning')).toHaveAttribute('data-active', 'false')
  })
})

describe('ProjectDropRows row cap', () => {
  beforeEach(() => {
    projectList = manyProjects
  })

  it('shows only the first five projects when idle', () => {
    renderAt('/chats/abc')
    expect(screen.getByText('Project 5')).toBeInTheDocument()
    expect(screen.queryByText('Project 6')).not.toBeInTheDocument()
  })

  it('links the overflow to the projects page with a count', () => {
    renderAt('/chats/abc')
    expect(screen.getByText('3 more')).toBeInTheDocument()
  })

  it('leaves the list uncapped while a chat is being dragged', () => {
    // Every project has to stay droppable, or a chat can't reach it.
    renderAt('/chats/abc', { isDragging: true })
    expect(screen.getByText('Project 8')).toBeInTheDocument()
    expect(screen.queryByText('3 more')).not.toBeInTheDocument()
  })

  it('keeps the open project visible even past the cap', () => {
    renderAt('/projects/p8')
    expect(rowFor('Project 8')).toHaveAttribute('data-active', 'true')
  })

  it('never marks the overflow row as active', () => {
    // The "Projects" nav item above already indicates this route.
    renderAt('/projects')
    expect(rowFor('3 more')).toHaveAttribute('data-active', 'false')
  })

  it('does not cap a list that fits', () => {
    projectList = twoProjects
    renderAt('/chats/abc')
    expect(screen.queryByText(/more$/)).not.toBeInTheDocument()
  })
})
