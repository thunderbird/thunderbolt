/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { Project } from '@/types'
import { ProjectDetailPanel } from './project-detail-panel'

afterEach(cleanup)

const project = {
  id: 'p1',
  name: 'Q3 Planning',
  description: 'Quarterly work',
  instructions: 'Reply in bullet points.',
  icon: '📊',
  agentNotesEnabled: 0,
  pinnedOrder: null,
  createdAt: null,
  updatedAt: null,
  deletedAt: null,
  userId: null,
} as unknown as Project

const renderPanel = (overrides?: Partial<Parameters<typeof ProjectDetailPanel>[0]>) => {
  const props = {
    project,
    chats: [{ id: 'c1', title: 'Kickoff' }],
    onEdit: mock(() => {}),
    onDelete: mock(() => {}),
    onClose: mock(() => {}),
    onOpenChat: mock(() => {}),
    ...overrides,
  }
  render(<ProjectDetailPanel {...props} />)
  return props
}

describe('ProjectDetailPanel', () => {
  it('shows the project’s name, description and instructions', () => {
    renderPanel()
    expect(screen.getByText('Q3 Planning')).toBeInTheDocument()
    expect(screen.getByText('Quarterly work')).toBeInTheDocument()
    expect(screen.getByText('Reply in bullet points.')).toBeInTheDocument()
  })

  it('is read-only — no inputs, textareas, or checkboxes', () => {
    const { container } = render(
      <ProjectDetailPanel
        project={project}
        chats={[]}
        onEdit={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
        onOpenChat={() => {}}
      />,
    )
    // The whole reason this panel exists: browsing must not risk an edit.
    expect(container.querySelector('input')).toBeNull()
    expect(container.querySelector('textarea')).toBeNull()
  })

  it('is a summary: knowledge and assistant memory stay behind ⋯ → Edit', () => {
    renderPanel()
    expect(screen.queryByText('Knowledge')).not.toBeInTheDocument()
    expect(screen.queryByText('Assistant memory')).not.toBeInTheDocument()
    expect(screen.queryByText('Artifacts')).not.toBeInTheDocument()
  })

  it('opens a chat from the panel', () => {
    const props = renderPanel()
    fireEvent.click(screen.getByText('Kickoff'))
    expect(props.onOpenChat).toHaveBeenCalledWith('c1')
  })

  it('states empty sections rather than rendering nothing', () => {
    renderPanel({ chats: [], project: { ...project, instructions: null } as Project })
    expect(screen.getByText('No instructions yet.')).toBeInTheDocument()
    expect(screen.getByText('No chats yet.')).toBeInTheDocument()
  })
})
