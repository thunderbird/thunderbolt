/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { DndContext } from '@dnd-kit/core'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { MemoryRouter } from 'react-router'
import { SidebarProvider } from '@/components/ui/sidebar'
import type { Project } from '@/types'
import { ProjectDropList } from './project-drop-list'

afterEach(cleanup)

const projects = [
  { id: 'p1', name: 'Q3 Planning', icon: '📊' },
  { id: 'p2', name: 'Cabin build', icon: null },
] as unknown as Project[]

mock.module('@/dal/projects', () => ({ useProjects: () => projects }))

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <SidebarProvider>
        <DndContext>
          <ProjectDropList isDragging={false} draggingFromProjectId={null} />
        </DndContext>
      </SidebarProvider>
    </MemoryRouter>,
  )

/** Sidebar buttons mark selection with `data-active`. */
const rowFor = (name: string) => screen.getByText(name).closest('[data-active]')

describe('ProjectDropList active state', () => {
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
