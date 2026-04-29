/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMcpServer } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, cleanup, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import McpServersPage from './mcp-servers'

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
    await resetTestDatabase()
  })

  afterEach(() => {
    cleanup()
  })

  it('updates when mcp_servers table changes', async () => {
    const db = getDb()
    const serverId1 = uuidv7()
    const serverId2 = uuidv7()

    await createMcpServer(db, {
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

    await createMcpServer(db, {
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
