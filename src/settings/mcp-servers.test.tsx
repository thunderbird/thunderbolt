/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMcpServer, getAllMcpServers } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import { MCPProvider, type MCPClient } from '@/lib/mcp-provider'
import type { McpServersPageDeps } from './mcp-servers'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createElement, type ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { v7 as uuidv7 } from 'uuid'
import McpServersPage, { generateServerName } from './mcp-servers'

/** A 401 shaped like the real transport error `isUnauthorizedError` recognizes. */
const unauthorized = () => Object.assign(new Error('Unauthorized'), { code: 401 })

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

// Renders the page with injected probe/flow deps, opens the Add dialog, and
// types the URL (+ optional token). Returns the deps' mocks for assertions.
const renderAddDialog = async (deps: McpServersPageDeps, { url, token }: { url: string; token?: string }) => {
  const result = renderWithReactivity(<McpServersPage deps={deps} />, {
    tables: ['mcp_servers', 'mcp_secrets'],
    wrapper: McpProviderWrapper,
  })
  const openButton = await waitForElement(() => screen.queryByRole('button', { name: 'Add Server' }))
  fireEvent.click(openButton)
  const urlInput = await waitForElement(() => screen.queryByPlaceholderText('http://localhost:8000/mcp/'))
  if (token) {
    fireEvent.change(screen.getByPlaceholderText('Bearer token or API key'), { target: { value: token } })
  }
  fireEvent.change(urlInput, { target: { value: url } })
  return result
}

// Settles the 700ms auto-probe debounce plus the async probe it kicks off.
const flushAutoProbe = async () => {
  await act(async () => {
    getClock().tick(700)
    await getClock().runAllAsync()
  })
}

describe('McpServersPage Test Connection classification', () => {
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

  it('classifies a supplied-credential 401 as a rejected token without consulting OAuth discovery', async () => {
    const classifyMcpServerAuth = mock(async () => 'authorizable' as const)
    await renderAddDialog(
      { probeMcpServerTools: async () => Promise.reject(unauthorized()), classifyMcpServerAuth },
      { url: 'https://oauth.example.com/mcp', token: 'pat-123' },
    )

    await flushAutoProbe()

    expect(screen.getByText('Token rejected')).toBeInTheDocument()
    expect(classifyMcpServerAuth).not.toHaveBeenCalled()
  })

  it('classifies an empty-credential 401 via discovery and offers Add & Authorize', async () => {
    const classifyMcpServerAuth = mock(async () => 'authorizable' as const)
    await renderAddDialog(
      { probeMcpServerTools: async () => Promise.reject(unauthorized()), classifyMcpServerAuth },
      { url: 'https://oauth.example.com/mcp' },
    )

    await flushAutoProbe()

    expect(classifyMcpServerAuth).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Authorization required')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add & Authorize/ })).toBeInTheDocument()
  })

  it('shows a successful probe result with the discovered tools', async () => {
    await renderAddDialog(
      { probeMcpServerTools: async () => ['search', 'fetch'] },
      { url: 'https://tools.example.com/mcp' },
    )

    await flushAutoProbe()

    expect(screen.getByText('Connection successful!')).toBeInTheDocument()
    expect(screen.getByText('search')).toBeInTheDocument()
  })
})

describe('McpServersPage Add & Authorize', () => {
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

  it('rolls back the created server row and shows the dialog error when the flow fails to start', async () => {
    const db = getDb()
    const startMcpOAuthFlow = mock(async () => {
      throw new Error('Another MCP authorization is already in progress — finish or cancel it first.')
    })
    await renderAddDialog(
      {
        probeMcpServerTools: async () => Promise.reject(unauthorized()),
        classifyMcpServerAuth: async () => 'authorizable' as const,
        startMcpOAuthFlow: startMcpOAuthFlow as unknown as McpServersPageDeps['startMcpOAuthFlow'],
      },
      { url: 'https://oauth.example.com/mcp' },
    )
    await flushAutoProbe()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Add & Authorize/ }))
      await getClock().runAllAsync()
    })

    // The row was created then rolled back, leaving no live server.
    const remaining = await getAllMcpServers(db)
    expect(remaining).toHaveLength(0)
    expect(
      screen.getByText('Another MCP authorization is already in progress — finish or cancel it first.'),
    ).toBeInTheDocument()
  })

  it('creates exactly one server row when Add & Authorize is double-clicked', async () => {
    const db = getDb()
    // A flow that never resolves keeps the first call in flight so the re-entry
    // guard has something to block the second click against.
    const startMcpOAuthFlow = mock(() => new Promise<never>(() => {}))
    await renderAddDialog(
      {
        probeMcpServerTools: async () => Promise.reject(unauthorized()),
        classifyMcpServerAuth: async () => 'authorizable' as const,
        startMcpOAuthFlow: startMcpOAuthFlow as unknown as McpServersPageDeps['startMcpOAuthFlow'],
      },
      { url: 'https://oauth.example.com/mcp' },
    )
    await flushAutoProbe()

    const button = screen.getByRole('button', { name: /Add & Authorize/ })
    await act(async () => {
      fireEvent.click(button)
      fireEvent.click(button)
      await getClock().runAllAsync()
    })

    const created = await getAllMcpServers(db)
    expect(created).toHaveLength(1)
    expect(startMcpOAuthFlow).toHaveBeenCalledTimes(1)
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
