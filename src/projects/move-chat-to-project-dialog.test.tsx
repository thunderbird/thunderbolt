/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { Project } from '@/types'
import { MoveChatToProjectDialog } from './move-chat-to-project-dialog'

afterEach(cleanup)

const projects = [
  { id: 'p1', name: 'Q3 Planning', icon: '📊' },
  { id: 'p2', name: 'Cabin build', icon: null },
] as unknown as Project[]

let projectList = projects

/** Spread over the real module: bun installs module mocks worker-wide, so a bare
 *  object would strip every other export for sibling tests in this worker. */
const realDal = await import('@/dal/projects')

mock.module('@/dal/projects', () => ({ ...realDal, useProjects: () => projectList }))

beforeEach(() => {
  projectList = projects
})

const renderDialog = (currentProjectId: string | null = null) => {
  const onSelect = mock((_projectId: string | null) => {})
  const onOpenChange = mock((_open: boolean) => {})
  render(
    <MoveChatToProjectDialog
      open
      currentProjectId={currentProjectId}
      onOpenChange={onOpenChange}
      onSelect={onSelect}
    />,
  )
  return { onSelect, onOpenChange }
}

describe('MoveChatToProjectDialog', () => {
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
