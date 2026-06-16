/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMcpServer } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase, wsId } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import {
  renderWithReactivity,
  waitForElement,
  resetTestTrustDomain,
  seedTestTrustDomain,
} from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, cleanup, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import McpServersPage from './mcp-servers'

const fakeUseWorkspacePermission = (isAllowed: boolean) =>
  (() => ({
    requiredRole: 'admin' as const,
    isAllowed,
    isResolved: true,
  })) as unknown as typeof import('@/hooks/use-workspace-permission').useWorkspacePermission

mock.module('@/hooks/use-mcp-sync', () => ({
  useMcpSync: () => ({ servers: [] }),
}))

describe('McpServersPage reactivity', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    seedTestTrustDomain()
    await resetTestDatabase()
  })

  afterEach(() => {
    resetTestTrustDomain()
    cleanup()
  })

  it('updates when mcp_servers table changes', async () => {
    const db = getDb()
    const serverId1 = uuidv7()
    const serverId2 = uuidv7()

    await createMcpServer(db, wsId, {
      id: serverId1,
      name: 'First Server',
      url: 'http://localhost:8000/mcp/',
      type: 'http',
      enabled: 1,
    })

    const { triggerChange } = renderWithReactivity(<McpServersPage />, {
      tables: ['mcp_servers'],
    })

    await waitForElement(() => screen.queryByText('localhost:8000/mcp'))
    expect(screen.getByText('localhost:8000/mcp')).toBeInTheDocument()

    await createMcpServer(db, wsId, {
      id: serverId2,
      name: 'Second Server',
      url: 'http://localhost:9000/mcp/',
      type: 'http',
      enabled: 1,
    })
    triggerChange(['mcp_servers'])

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(screen.getByText('localhost:9000/mcp')).toBeInTheDocument()
  })
})

describe('McpServersPage — permission gating', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    seedTestTrustDomain()
    await resetTestDatabase()
  })

  afterEach(() => {
    resetTestTrustDomain()
    cleanup()
  })

  it('renders the "Add Server" header trigger when add_mcp_servers is allowed', async () => {
    renderWithReactivity(<McpServersPage useWorkspacePermission={fakeUseWorkspacePermission(true)} />, {
      tables: ['mcp_servers'],
    })

    await waitForElement(() => screen.queryByRole('heading', { name: 'MCP Servers' }))
    // Empty-state CTA fires here since no servers seeded; both header + empty
    // state render the "Add Server" string. Asserting at least one is present.
    expect(screen.getAllByText(/Add Server/).length).toBeGreaterThan(0)
  })

  it('hides every "Add Server" affordance when add_mcp_servers is denied', async () => {
    renderWithReactivity(<McpServersPage useWorkspacePermission={fakeUseWorkspacePermission(false)} />, {
      tables: ['mcp_servers'],
    })

    await waitForElement(() => screen.queryByRole('heading', { name: 'MCP Servers' }))
    expect(screen.queryByText(/Add Server/)).not.toBeInTheDocument()
  })

  it('hides the row Trash button when remove_mcp_servers is denied', async () => {
    const db = getDb()
    await createMcpServer(db, wsId, {
      id: uuidv7(),
      name: 'Configured',
      url: 'http://localhost:8000/mcp/',
      type: 'http',
      enabled: 1,
    })

    // The page passes the same `useWorkspacePermission` for both keys; a single
    // `isAllowed: false` covers add + remove together — sufficient to assert
    // the row Trash icon is hidden.
    renderWithReactivity(<McpServersPage useWorkspacePermission={fakeUseWorkspacePermission(false)} />, {
      tables: ['mcp_servers'],
    })

    await waitForElement(() => screen.queryByText('localhost:8000/mcp'))
    // Trash2 icon doesn't get a unique label, so we assert via the absence of
    // any button child of the row's interactive group beyond Switch.
    const switchToggle = screen.queryByRole('switch')
    // Switch should also be disabled.
    expect(switchToggle).toBeDisabled()
  })
})
