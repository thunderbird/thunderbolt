/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getClock } from '@/testing-library'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import type { Agent } from '@/types/acp'
import type { DeployStatus } from '@shared/agent-descriptors'
import '@testing-library/jest-dom'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'
import { AgentDeployBadge } from './agent-deploy-badge'

/**
 * Settle the initial status fetch without draining the poller. The pending
 * `refetchInterval` reschedules forever, so `runAllAsync` (waitForElement) would
 * loop — instead `tickAsync` advances a bounded window (firing the fetch and
 * flushing its promise chain) that never reaches the 4000ms poll interval.
 */
const flushInitialFetch = async () => {
  await act(async () => {
    await getClock().tickAsync(100)
  })
}

const managedAgent: Agent = {
  id: 'a1',
  name: 'My deploy',
  type: 'managed-acp',
  transport: 'websocket',
  url: 'wss://h/v1/haystack/ws?pipeline=tb-x',
  description: null,
  icon: null,
  isSystem: 0,
  enabled: 1,
  deletedAt: null,
  userId: 'user-1',
}

const statusBody = (status: DeployStatus) => ({ deploymentId: 'haystack:tb-x', status, connection: null })

const renderBadge = (agent: Agent, mockResponse?: unknown) => {
  const TestProvider = createTestProvider({ authClient: createMockAuthClient(), mockResponse })
  return render(<AgentDeployBadge agent={agent} />, {
    wrapper: ({ children }: { children: ReactNode }) => <TestProvider>{children}</TestProvider>,
  })
}

describe('AgentDeployBadge', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
  })

  afterEach(cleanup)

  it('shows "Deploying…" while the pipeline is pending', async () => {
    renderBadge(managedAgent, statusBody('pending'))
    await flushInitialFetch()
    expect(screen.getByText('Deploying…')).toBeInTheDocument()
  })

  it('shows "Deploy failed" on a terminal failure', async () => {
    renderBadge(managedAgent, statusBody('failed'))
    await flushInitialFetch()
    expect(screen.getByText('Deploy failed')).toBeInTheDocument()
  })

  it('warns "Unavailable" when the pipeline is gone', async () => {
    renderBadge(managedAgent, statusBody('gone'))
    await flushInitialFetch()
    expect(screen.getByText('Unavailable')).toBeInTheDocument()
  })

  it('renders nothing once the pipeline is running', async () => {
    renderBadge(managedAgent, statusBody('running'))
    await flushInitialFetch()
    expect(screen.queryByText('Deploying…')).not.toBeInTheDocument()
    expect(screen.queryByText('Deploy failed')).not.toBeInTheDocument()
  })

  it('renders nothing for an agent that carries no deployment', () => {
    renderBadge({ ...managedAgent, type: 'remote-acp' }, statusBody('pending'))
    expect(screen.queryByText('Deploying…')).not.toBeInTheDocument()
  })
})
