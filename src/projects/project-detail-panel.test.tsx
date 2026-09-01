/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { i18n } from '@/i18n'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { Project } from '@/types'
import { ProjectDetailPanel, deleteProjectPrompt } from './project-detail-panel'

afterEach(cleanup)

const project = {
  id: 'p1',
  name: 'Q3 Planning',
  description: 'Quarterly work',
  instructions: 'Reply in bullet points.',
  icon: '📊',
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
    artifacts: [
      {
        id: 'm1-0',
        messageId: 'm1',
        chatThreadId: 'c1',
        chatTitle: 'Kickoff',
        title: 'Budget chart',
        createdAt: new Date('2026-08-01T00:00:00Z'),
      },
    ],
    onEdit: mock(() => {}),
    onDelete: mock(() => {}),
    onClose: mock(() => {}),
    onOpenChat: mock(() => {}),
    onNewChat: mock(() => {}),
    ...overrides,
  }
  render(<ProjectDetailPanel {...props} />)
  return props
}

describe('ProjectDetailPanel', () => {
  it('shows the project’s name and description', () => {
    renderPanel()
    expect(screen.getByText('Q3 Planning')).toBeInTheDocument()
    expect(screen.getByText('Quarterly work')).toBeInTheDocument()
  })

  it('shows what the project contains: chats and artifacts', () => {
    renderPanel()
    expect(screen.getByText('Kickoff')).toBeInTheDocument()
    expect(screen.getByText('Budget chart')).toBeInTheDocument()
  })

  it('opens an artifact’s chat', () => {
    const props = renderPanel()
    fireEvent.click(screen.getByText('Budget chart'))
    expect(props.onOpenChat).toHaveBeenCalledWith('c1')
  })

  it('is read-only — no inputs, textareas, or checkboxes', () => {
    const { container } = render(
      <ProjectDetailPanel
        project={project}
        chats={[]}
        artifacts={[]}
        onEdit={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
        onOpenChat={() => {}}
        onNewChat={() => {}}
      />,
    )
    // The whole reason this panel exists: browsing must not risk an edit.
    expect(container.querySelector('input')).toBeNull()
    expect(container.querySelector('textarea')).toBeNull()
  })

  it('leaves instructions to the edit panel — this one answers “what’s in here?”', () => {
    renderPanel()
    expect(screen.queryByText('Instructions')).not.toBeInTheDocument()
    expect(screen.queryByText('Reply in bullet points.')).not.toBeInTheDocument()
  })

  it('opens a chat from the panel', () => {
    const props = renderPanel()
    fireEvent.click(screen.getByText('Kickoff'))
    expect(props.onOpenChat).toHaveBeenCalledWith('c1')
  })

  it('states empty sections rather than rendering nothing', () => {
    renderPanel({ chats: [], artifacts: [] })
    expect(screen.getByText('No chats yet.')).toBeInTheDocument()
    expect(screen.getByText('No artifacts yet.')).toBeInTheDocument()
  })
})

describe('starting a chat from the panel', () => {
  it('offers a new chat in this project', () => {
    const props = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /New chat in this project/ }))
    expect(props.onNewChat).toHaveBeenCalled()
  })
})

describe('deleteProjectPrompt', () => {
  it('tells the user their chats survive', () => {
    // The one non-obvious consequence: chats are orphaned, not removed.
    expect(i18n._(deleteProjectPrompt.description)).toContain('Chats in the project are kept')
  })

  it('names the action on its confirm button', () => {
    expect(i18n._(deleteProjectPrompt.confirmLabel)).toBe('Delete project')
  })
})
