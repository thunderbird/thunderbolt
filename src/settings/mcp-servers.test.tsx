/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMcpServer } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import { MCPProvider, type MCPClient } from '@/lib/mcp-provider'
import '@testing-library/jest-dom'
import { act, cleanup, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { createElement, type ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { v7 as uuidv7 } from 'uuid'
import McpServersPage, { generateServerName } from './mcp-servers'

// Wrap the page in a real MCPProvider with an injected createClient so the page
// reads live (empty) connection state via useMCP — no need to mock the shared
// useMcpSync hook. The fake client never resolves tools, keeping the test
// focused on the DB-driven server list rendering. A MemoryRouter satisfies the
// page's useLocation/useNavigate (the OAuth callback handler).
const neverResolves = (() => new Promise<MCPClient>(() => {})) as (
  id: string,
  url: string,
  type: 'http' | 'sse',
) => Promise<MCPClient>

const McpProviderWrapper = ({ children }: { children: ReactNode }) =>
  createElement(MemoryRouter, { children: createElement(MCPProvider, { createClient: neverResolves, children }) })

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
      wrapper: McpProviderWrapper,
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

describe('generateServerName', () => {
  const cases: Array<[string, string]> = [
    ['http://192.168.1.100', '192.168.1.100'],
    ['http://10.0.1.1', '10.0.1.1'],
    ['https://api.github.com', 'github'],
    ['https://render.com', 'render'],
    ['http://localhost:3000', 'localhost-3000'],
    ['https://example.com.', 'example'],
    ['http://[::1]:8080', 'localhost-8080'],
    ['http://[2001:db8::1]', '2001:db8::1'],
  ]

  it.each(cases)('derives %p → %p', (url, expected) => {
    expect(generateServerName(url)).toBe(expected)
  })
})
