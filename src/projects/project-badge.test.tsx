/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { MemoryRouter } from 'react-router'
import { useChatStore } from '@/chats/chat-store'
import type { Project } from '@/types'
import { ProjectBadge } from './project-badge'

afterEach(cleanup)

const projects = [{ id: 'p1', name: 'Q3 Planning', icon: '📊' }] as unknown as Project[]

const realDal = await import('@/dal/projects')

/** Only `useProjects` is replaced, spread over the real module: bun installs mocks
 *  worker-wide, so a bare object would strip its other exports for siblings. */
mock.module('@/dal/projects', () => ({ ...realDal, useProjects: () => projects }))

/** Put a session in the store with (or without) a project, as hydration would. */
const seedSession = (projectId: string | null) => {
  useChatStore.setState({
    currentSessionId: 'chat-1',
    sessions: new Map([['chat-1', { id: 'chat-1', projectId } as never]]),
  })
}

beforeEach(() => {
  seedSession('p1')
})

const renderBadge = (props: { iconOnly?: boolean } = {}) =>
  render(
    <MemoryRouter>
      <ProjectBadge chatThreadId="chat-1" {...props} />
    </MemoryRouter>,
  )

describe('ProjectBadge', () => {
  it('names the project it is in', () => {
    renderBadge()
    expect(screen.getByText('Q3 Planning')).toBeInTheDocument()
  })

  it('renders nothing for a chat with no project', () => {
    seedSession(null)
    const { container } = renderBadge()
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when the chat has no session yet', () => {
    useChatStore.setState({ currentSessionId: null, sessions: new Map() })
    const { container } = renderBadge()
    expect(container).toBeEmptyDOMElement()
  })
})

describe('ProjectBadge iconOnly (mobile)', () => {
  it('drops the name but stays labelled for screen readers', () => {
    // The mobile header has no room for a second labelled pill, but the control
    // still has to say what it is.
    renderBadge({ iconOnly: true })
    expect(screen.queryByText('Q3 Planning')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'In project: Q3 Planning' })).toBeInTheDocument()
  })

  it('shows the project’s emoji', () => {
    renderBadge({ iconOnly: true })
    expect(screen.getByText('📊')).toBeInTheDocument()
  })

  it('is a circle sized like the agent control beside it', () => {
    renderBadge({ iconOnly: true })
    const button = screen.getByRole('button', { name: 'In project: Q3 Planning' })
    expect(button.className).toContain('rounded-full')
    expect(button.className).toContain('size-[var(--touch-height-lg)]')
  })
})
