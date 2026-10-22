/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { MemoryRouter } from 'react-router'
import { useConfigStore } from '@/api/config-store'
import { useChatStore } from '@/chats/chat-store'
import { getDb } from '@/db/database'
import { projectsTable } from '@/db/tables'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { ProjectBadge } from './project-badge'

afterEach(() => {
  cleanup()
  useConfigStore.setState({ config: {}, configLoaded: false })
})

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)

/** Put a session in the store with (or without) a project, as hydration would. */
const seedSession = (projectId: string | null) => {
  useChatStore.setState({
    currentSessionId: 'chat-1',
    sessions: new Map([['chat-1', { id: 'chat-1', projectId } as never]]),
  })
}

beforeEach(async () => {
  await resetTestDatabase()
  await getDb().insert(projectsTable).values({ id: 'p1', name: 'Q3 Planning', icon: '📊' })
  useConfigStore.setState({ config: {}, configLoaded: false })
  seedSession('p1')
})

const renderBadge = async (props: { iconOnly?: boolean } = {}) => {
  const view = render(
    <MemoryRouter>
      <ProjectBadge chatThreadId="chat-1" {...props} />
    </MemoryRouter>,
    { wrapper: createTestProvider() },
  )
  await act(async () => {
    await getClock().runAllAsync()
  })
  return view
}

describe('ProjectBadge', async () => {
  it('names the project it is in', async () => {
    await renderBadge()
    expect(screen.getByText('Q3 Planning')).toBeInTheDocument()
  })

  it('renders nothing in minimal mode, though the chat keeps its project', async () => {
    useConfigStore.setState({ config: { minimalMode: true }, configLoaded: true })
    const { container } = await renderBadge()

    expect(container).toBeEmptyDOMElement()
    expect(useChatStore.getState().sessions.get('chat-1')?.projectId).toBe('p1')
  })

  it('renders nothing for a chat with no project', async () => {
    seedSession(null)
    const { container } = await renderBadge()
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when the chat has no session yet', async () => {
    useChatStore.setState({ currentSessionId: null, sessions: new Map() })
    const { container } = await renderBadge()
    expect(container).toBeEmptyDOMElement()
  })
})

describe('ProjectBadge iconOnly (mobile)', async () => {
  it('drops the name but stays labelled for screen readers', async () => {
    // The mobile header has no room for a second labelled pill, but the control
    // still has to say what it is.
    await renderBadge({ iconOnly: true })
    expect(screen.queryByText('Q3 Planning')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'In project: Q3 Planning' })).toBeInTheDocument()
  })

  it('shows the project’s emoji', async () => {
    await renderBadge({ iconOnly: true })
    const button = screen.getByRole('button', { name: 'In project: Q3 Planning' })
    expect(button.querySelector('img')).toHaveAttribute('src', '/emoji/1f4ca.svg')
  })

  it('is a circle sized like the agent control beside it', async () => {
    await renderBadge({ iconOnly: true })
    const button = screen.getByRole('button', { name: 'In project: Q3 Planning' })
    expect(button.className).toContain('rounded-full')
    expect(button.className).toContain('size-[var(--touch-height-lg)]')
  })
})
