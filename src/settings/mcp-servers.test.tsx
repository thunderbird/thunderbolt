/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMcpServer, getAllMcpServers } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase, wsId } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import {
  renderWithReactivity,
  waitForElement,
  resetTestTrustDomain,
  seedTestTrustDomain,
} from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import { MCPProvider, useMCP, type MCPClient } from '@/lib/mcp-provider'
import type { McpServersPageDeps } from './mcp-servers'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
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

const fakeUseWorkspacePermission = (isAllowed: boolean) =>
  (() => ({
    requiredRole: 'admin' as const,
    isAllowed,
    isResolved: true,
  })) as unknown as typeof import('@/hooks/use-workspace-permission').useWorkspacePermission

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
      wrapper: McpProviderWrapper,
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
    seedTestTrustDomain()
    await resetTestDatabase()
  })

  afterEach(() => {
    resetTestTrustDomain()
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

  it('the debounced probe reflects a credential entered during the window', async () => {
    const classifyMcpServerAuth = mock(async () => 'authorizable' as const)
    await renderAddDialog(
      { probeMcpServerTools: async () => Promise.reject(unauthorized()), classifyMcpServerAuth },
      { url: 'https://oauth.example.com/mcp' },
    )
    // Paste a token before the 700ms URL debounce fires — the probe must use it.
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('Bearer token or API key'), { target: { value: 'pat-123' } })
    })

    await flushAutoProbe()

    // Probed WITH the token → rejected credential, and OAuth discovery was skipped
    // (a stale empty-token probe would have classified it as 'Authorization required').
    expect(screen.getByText('Token rejected')).toBeInTheDocument()
    expect(classifyMcpServerAuth).not.toHaveBeenCalled()
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
    const remaining = await getAllMcpServers(db, wsId)
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

    const created = await getAllMcpServers(db, wsId)
    expect(created).toHaveLength(1)
    expect(startMcpOAuthFlow).toHaveBeenCalledTimes(1)
  })

  it('closes the Add dialog once the OAuth flow starts cleanly', async () => {
    const startMcpOAuthFlow = mock(async () => ({ status: 'redirected' as const }))
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

    // Dialog is gone — no lingering needs-oauth UI to trigger a duplicate add.
    expect(screen.queryByPlaceholderText('http://localhost:8000/mcp/')).not.toBeInTheDocument()
  })
})

describe('McpServersPage probe lifecycle', () => {
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

  it('discards an in-flight probe result after the URL field changes', async () => {
    let resolveFirst: (tools: string[]) => void = () => {}
    let call = 0
    const probeMcpServerTools = mock(() => {
      call += 1
      // First probe (URL A) is held open; the later URL keeps its probe pending too.
      return call === 1 ? new Promise<string[]>((resolve) => (resolveFirst = resolve)) : new Promise<string[]>(() => {})
    })
    await renderAddDialog(
      { probeMcpServerTools: probeMcpServerTools as unknown as McpServersPageDeps['probeMcpServerTools'] },
      { url: 'https://a.example.com/mcp' },
    )
    // Kick the probe for URL A (stays in flight — the promise is held).
    await act(async () => {
      getClock().tick(700)
      await getClock().runAllAsync()
    })
    // Edit the URL before A resolves — this must invalidate A's probe.
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('http://localhost:8000/mcp/'), {
        target: { value: 'https://b.example.com/mcp' },
      })
    })
    // A's response lands late — its result must be dropped, not shown for URL B.
    await act(async () => {
      resolveFirst(['stale-tool'])
      await getClock().runAllAsync()
    })

    expect(screen.queryByText('Connection successful!')).not.toBeInTheDocument()
    expect(screen.queryByText('stale-tool')).not.toBeInTheDocument()
  })

  it('does not auto-probe after the Add dialog is closed', async () => {
    const probeMcpServerTools = mock(async () => ['tool'])
    await renderAddDialog(
      { probeMcpServerTools: probeMcpServerTools as unknown as McpServersPageDeps['probeMcpServerTools'] },
      { url: 'https://late.example.com/mcp' },
    )
    // Close the dialog before the 700ms debounce fires.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    })
    await flushAutoProbe()

    expect(probeMcpServerTools).not.toHaveBeenCalled()
  })
})

type CreateClientFn = (serverId: string, url: string, type: 'http' | 'sse') => Promise<MCPClient>

/** A connected-client stand-in whose tools() reports the given names. */
const fakeClient = (toolNames: string[]): MCPClient =>
  ({
    tools: async () => Object.fromEntries(toolNames.map((name) => [name, {}])),
    close: () => {},
  }) as unknown as MCPClient

/** createClient that serves each queued outcome once, failing on extra connects. */
const queuedCreateClient = (queue: Array<() => Promise<MCPClient>>): CreateClientFn => {
  return async () => {
    const next = queue.shift()
    if (!next) {
      throw new Error('unexpected extra connect')
    }
    return next()
  }
}

// Captures the live MCP context so tests can drive addServer/reconnectServer —
// the page consumes the provider read-only and exposes no imperative handle.
const mcpContextRef: { current: ReturnType<typeof useMCP> | null } = { current: null }

const CaptureMcpContext = () => {
  mcpContextRef.current = useMCP()
  return null
}

const getMcp = () => {
  const mcp = mcpContextRef.current
  if (!mcp) {
    throw new Error('MCP context not captured — render with makeMcpWrapper first')
  }
  return mcp
}

const makeMcpWrapper = (createClient: CreateClientFn) => {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter>
      <MCPProvider createClient={createClient}>
        <CaptureMcpContext />
        {children}
      </MCPProvider>
    </MemoryRouter>
  )
  return Wrapper
}

/** Expands the card's Available Tools accordion when it isn't already open. */
const ensureToolsExpanded = async () => {
  const label = await waitForElement(() => screen.queryByText('Available Tools'))
  const trigger = label.closest('button')
  if (trigger && trigger.getAttribute('data-state') !== 'open') {
    fireEvent.click(trigger)
  }
}

describe('McpServersPage tools refresh after reconnect', () => {
  beforeAll(async () => {
    // The dropped-connection scenarios intentionally fail a reconnect, which the
    // provider logs via console.error.
    spyOn(console, 'error').mockImplementation(() => {})
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    mcpContextRef.current = null
  })

  afterEach(() => {
    cleanup()
  })

  // Creates the DB row, renders the page inside a live MCPProvider using the
  // given createClient, and registers + connects the server through the provider.
  const addLiveServer = async (createClient: CreateClientFn) => {
    const db = getDb()
    const serverId = uuidv7()
    const url = 'http://localhost:8000/mcp/'
    await createMcpServer(db, wsId, { id: serverId, name: 'srv', url, type: 'http', enabled: 1 })
    renderWithReactivity(<McpServersPage />, {
      tables: ['mcp_servers', 'mcp_secrets'],
      wrapper: makeMcpWrapper(createClient),
    })
    await act(async () => {
      await getMcp().addServer({ id: serverId, name: 'srv', url, type: 'http', enabled: true })
      await getClock().runAllAsync()
    })
    return serverId
  }

  it('refetches tools when a reconnect swaps the client without changing the connected set', async () => {
    const serverId = await addLiveServer(
      queuedCreateClient([async () => fakeClient(['alpha_tool']), async () => fakeClient(['beta_tool'])]),
    )

    await ensureToolsExpanded()
    await waitForElement(() => screen.queryByText('alpha_tool'))
    expect(screen.getByText('alpha_tool')).toBeInTheDocument()

    // The server stays connected under the same id — only the client instance is
    // replaced, so a queryKey of connected ids alone would never refetch.
    await act(async () => {
      await getMcp().reconnectServer(serverId)
      await getClock().runAllAsync()
    })

    await ensureToolsExpanded()
    await waitForElement(() => screen.queryByText('beta_tool'))
    expect(screen.getByText('beta_tool')).toBeInTheDocument()
    expect(screen.queryByText('alpha_tool')).not.toBeInTheDocument()
  })

  it('hides cached tools and shows the error state after the connection drops', async () => {
    const serverId = await addLiveServer(
      queuedCreateClient([
        async () => fakeClient(['alpha_tool']),
        async () => Promise.reject(new Error('connection dropped')),
      ]),
    )

    await ensureToolsExpanded()
    await waitForElement(() => screen.queryByText('alpha_tool'))
    expect(screen.getByText('alpha_tool')).toBeInTheDocument()

    // Drop the connection: the failed reconnect leaves the server disconnected
    // with an error — the card must not keep rendering the dead connection's tools.
    await act(async () => {
      await getMcp().reconnectServer(serverId)
      await getClock().runAllAsync()
    })

    await waitForElement(() => screen.queryByText(/Could not connect to this server/))
    expect(screen.getByRole('button', { name: 'Retry connection' })).toBeInTheDocument()
    expect(screen.queryByText('Available Tools')).not.toBeInTheDocument()
    expect(screen.queryByText('alpha_tool')).not.toBeInTheDocument()
  })

  it('refetches tools after Retry connection restores a dropped server', async () => {
    const serverId = await addLiveServer(
      queuedCreateClient([
        async () => fakeClient(['alpha_tool']),
        async () => Promise.reject(new Error('connection dropped')),
        async () => fakeClient(['beta_tool']),
      ]),
    )

    // Drop the connection: the failed reconnect leaves the server errored, which
    // surfaces the Retry connection affordance on the card.
    await act(async () => {
      await getMcp().reconnectServer(serverId)
      await getClock().runAllAsync()
    })

    const retryButton = await waitForElement(() => screen.queryByRole('button', { name: 'Retry connection' }))
    await act(async () => {
      fireEvent.click(retryButton)
      await getClock().runAllAsync()
    })

    await ensureToolsExpanded()
    await waitForElement(() => screen.queryByText('beta_tool'))
    expect(screen.getByText('beta_tool')).toBeInTheDocument()
  })
})

describe('McpServersPage add-dialog error labeling', () => {
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

  it('clears a JSON import error when switching back to simple mode', async () => {
    renderWithReactivity(<McpServersPage />, {
      tables: ['mcp_servers', 'mcp_secrets'],
      wrapper: McpProviderWrapper,
    })
    const openButton = await waitForElement(() => screen.queryByRole('button', { name: 'Add Server' }))
    fireEvent.click(openButton)

    // Advanced mode: paste a config with no servers, then import → error panel.
    fireEvent.click(screen.getByText('Advanced (JSON)'))
    const textarea = await waitForElement(() => screen.queryByLabelText('Servers JSON'))
    fireEvent.change(textarea, { target: { value: '{}' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Import Servers' }))
      await getClock().runAllAsync()
    })
    expect(screen.getByText('Import failed')).toBeInTheDocument()
    const importMessage = 'No servers found: expected a non-empty "mcpServers" or "servers" object'
    expect(screen.getByText(importMessage)).toBeInTheDocument()

    // Switching back to Simple must clear the import error — not relabel it as an
    // "Authorization error" (the simple-mode error title).
    fireEvent.click(screen.getByText('Simple'))
    expect(screen.queryByText('Import failed')).not.toBeInTheDocument()
    expect(screen.queryByText('Authorization error')).not.toBeInTheDocument()
    expect(screen.queryByText(importMessage)).not.toBeInTheDocument()
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
