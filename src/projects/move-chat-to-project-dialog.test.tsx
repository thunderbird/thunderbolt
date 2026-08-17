/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { Project } from '@/types'
import { MoveChatToProjectPicker } from './move-chat-to-project-dialog'

afterEach(cleanup)

const projects = [
  { id: 'p1', name: 'Q3 Planning', icon: '📊' },
  { id: 'p2', name: 'Cabin build', icon: null },
] as unknown as Project[]

/** Twelve projects — past `searchableFrom`, so the picker gains a search field. */
const manyProjects = Array.from({ length: 12 }, (_unused, index) => ({
  id: `p${index + 1}`,
  name: `Project ${index + 1}`,
  icon: null,
})) as unknown as Project[]

let projectList = projects

beforeEach(() => {
  projectList = projects
})

/**
 * Rendered through `MoveChatToProjectPicker`, which takes the project list as a
 * prop — deliberately, rather than `mock.module('@/dal/projects', …)` on the
 * live-data `MoveChatToProjectDialog`. Bun installs module mocks worker-wide, so
 * that override would leak `useProjects` into every sibling test in the worker.
 */
const renderDialog = (currentProjectId: string | null = null) => {
  const onSelect = mock((_projectId: string | null) => {})
  const onOpenChange = mock((_open: boolean) => {})
  render(
    <MoveChatToProjectPicker
      open
      projects={projectList}
      currentProjectId={currentProjectId}
      onOpenChange={onOpenChange}
      onSelect={onSelect}
    />,
  )
  return { onSelect, onOpenChange }
}

describe('MoveChatToProjectPicker', () => {
  it('lists every project as a choice', () => {
    renderDialog()
    expect(screen.getByText('Q3 Planning')).toBeInTheDocument()
    expect(screen.getByText('Cabin build')).toBeInTheDocument()
  })

  it('reports the chosen project', () => {
    const { onSelect } = renderDialog()
    fireEvent.click(screen.getByText('Cabin build'))
    expect(onSelect).toHaveBeenCalledWith('p2')
  })

  it('dismisses itself on a choice, so the caller need not', () => {
    const { onOpenChange } = renderDialog()
    fireEvent.click(screen.getByText('Cabin build'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('offers removal only for a chat that is in a project', () => {
    renderDialog('p1')
    expect(screen.getByText('Remove from project')).toBeInTheDocument()
  })

  it('hides removal for a chat with no project — there is nothing to remove it from', () => {
    renderDialog(null)
    expect(screen.queryByText('Remove from project')).not.toBeInTheDocument()
  })

  it('reports removal as a null project', () => {
    const { onSelect } = renderDialog('p1')
    fireEvent.click(screen.getByText('Remove from project'))
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('marks the project the chat is already in', () => {
    renderDialog('p1')
    expect(screen.getByText('Q3 Planning').closest('button')).toHaveAttribute('aria-current', 'true')
  })

  it('explains itself when there are no projects yet', () => {
    projectList = []
    renderDialog()
    expect(screen.getByText(/No projects yet/)).toBeInTheDocument()
  })
})

describe('MoveChatToProjectPicker on a long list', () => {
  beforeEach(() => {
    projectList = manyProjects
  })

  it('offers a search field, since the sidebar drop zone cannot reach these', () => {
    renderDialog()
    expect(screen.getByLabelText('Search projects')).toBeInTheDocument()
  })

  it('filters to matching projects', () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText('Search projects'), { target: { value: 'Project 1' } })
    // "Project 1", "Project 10", "Project 11", "Project 12" — substring, not exact.
    expect(screen.getByText('Project 12')).toBeInTheDocument()
    expect(screen.queryByText('Project 2')).not.toBeInTheDocument()
  })

  it('says so when nothing matches', () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText('Search projects'), { target: { value: 'zzz' } })
    expect(screen.getByText('No matching projects.')).toBeInTheDocument()
  })

  it('keeps Remove from project reachable through a filter that excludes every name', () => {
    // It isn't a project, so a name filter must not hide the way out of one.
    renderDialog('p3')
    fireEvent.change(screen.getByLabelText('Search projects'), { target: { value: 'zzz' } })
    expect(screen.getByText('Remove from project')).toBeInTheDocument()
  })

  it('shows no search field on a short list, where scanning beats typing', () => {
    projectList = projects
    renderDialog()
    expect(screen.queryByLabelText('Search projects')).not.toBeInTheDocument()
  })
})
