/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getAllAgents, useAllAgents } from '@/dal'
import { getDb } from '@/db/database'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { CreateAgentDetailPanel } from './create-agent-detail-panel'

const AgentOptionsProbe = () => {
  const agents = useAllAgents()
  return <div data-testid="agent-options">{agents.map((agent) => agent.name).join('|')}</div>
}

describe('CreateAgentDetailPanel', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  afterEach(async () => {
    cleanup()
    await resetTestDatabase()
  })

  it('refreshes agent options before closing after creation', async () => {
    const onClose = mock(() => {})
    const authClient = createMockAuthClient({
      session: { user: { id: 'user-1', email: 'user@example.com', name: 'User', isAnonymous: false } },
    })
    const TestProvider = createTestProvider({ authClient })

    render(
      <>
        <CreateAgentDetailPanel
          onClose={onClose}
          loadAppNodeId={async () => 'b'.repeat(52)}
          enrollIroh={async () => {}}
        />
        <AgentOptionsProbe />
      </>,
      { wrapper: TestProvider },
    )

    fireEvent.change(screen.getByPlaceholderText('My Agent'), { target: { value: 'New Chat Agent' } })
    fireEvent.change(screen.getByPlaceholderText(/paste an iroh ticket/i), {
      target: { value: 'a'.repeat(52) },
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add Agent' }))
      await getClock().runAllAsync()
    })

    expect(screen.getByTestId('agent-options')).toHaveTextContent('New Chat Agent')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('creates a local agent without a session or cloud enrollment', async () => {
    const onClose = mock(() => {})
    const enrollIroh = mock(async () => {})
    const TestProvider = createTestProvider({ authClient: createMockAuthClient() })
    render(
      <CreateAgentDetailPanel onClose={onClose} loadAppNodeId={async () => 'b'.repeat(52)} enrollIroh={enrollIroh} />,
      { wrapper: TestProvider },
    )

    fireEvent.change(screen.getByPlaceholderText('My Agent'), { target: { value: 'Local Agent' } })
    fireEvent.change(screen.getByPlaceholderText(/paste an iroh ticket/i), {
      target: { value: 'a'.repeat(52) },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add Agent' }))
      await getClock().runAllAsync()
    })

    expect(await getAllAgents(getDb())).toMatchObject([{ name: 'Local Agent', userId: null }])
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(enrollIroh).not.toHaveBeenCalled()
  })
})
