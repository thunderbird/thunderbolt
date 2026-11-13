/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { updateSettings } from '@/dal/settings'
import { createMcpServer, createMcpServerWithCredentials, getAllMcpServers, getMcpServerCredentials } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { HttpClientProvider } from '@/contexts'
import { createMockHttpClient } from '@/test-utils/http-client'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import { MCPProvider, useMCP, type MCPClient } from '@/lib/mcp-provider'
import type { MCPTransportType } from '@/lib/mcp-transport'
import type { ConnectionsPageDeps } from '.'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { v7 as uuidv7 } from 'uuid'
import ConnectionsPage from '.'
import {
  getProviderConnection,
  saveProviderConnection,
  saveProviderConnectionInTransaction,
  disconnectProviderConnection,
} from '@/dal/provider-connections'
import { addProviderModels } from '@/providers/models'
import { getModel, getAvailableModels } from '@/dal/models'
import { clearAuthToken, setAuthToken } from '@/lib/auth-token'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { clearOAuthState, setOAuthState } from '@/lib/oauth-state'
import { clearMcpOAuthState } from '@/lib/mcp-auth/mcp-oauth-state'
import { getProviderConnectionAttempt } from '@/lib/provider-connection-attempt'
import {
  startProviderBrowserConnection,
  captureProviderBrowserReturn,
  cancelProviderBrowserConnection,
} from '@/lib/provider-browser-auth'
import { cancelTinfoilMobileConnection } from '@/lib/tinfoil-mobile-auth'
import { CreateItemProvider } from '@/components/create-item/context'
import { LazyCreateItemHost } from '@/components/create-item/lazy-create-item-host'
import * as otariBrowser from '@/lib/otari-browser-auth'
import * as platform from '@/lib/platform'
import * as chatgptAuth from '@/providers/chatgpt-auth'
import * as openrouterAuth from '@/lib/openrouter-auth'
import * as opener from '@tauri-apps/plugin-opener'
import { ChatModelSetup } from '@/components/chat/chat-model-setup'

/** A 401 shaped like the real transport error `isUnauthorizedError` recognizes. */
const unauthorized = () => Object.assign(new Error('Unauthorized'), { code: 401 })

// Wrap the page in a real MCPProvider with an injected createClient so the page
// reads live (empty) connection state via useMCP — no need to mock the shared
// useMcpSync hook. The fake client never resolves tools, keeping the test
// focused on the DB-driven server list rendering. A MemoryRouter satisfies the
// page's useLocation/useNavigate (the OAuth callback handler), and the mock
// HttpClient satisfies useOAuthConnect (the integrations connect flow).
const neverResolves = (_id: string, _url: string, _type: MCPTransportType): Promise<MCPClient> =>
  new Promise<MCPClient>(() => {})

// A real HttpClientProvider (DI, no module mock) so the page's useHttpClient() resolves.
// The default mock client 200s every request — the enrollment-specific tests inject their
// own `enrollIroh` seam instead of asserting on this client.
const McpProviderWrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter>
    <HttpClientProvider httpClient={createMockHttpClient()}>
      <MCPProvider createClient={neverResolves}>{children}</MCPProvider>
    </HttpClientProvider>
  </MemoryRouter>
)

/** Opens a server row's detail panel by its display name. */
const openServerDetail = async (name: string) => {
  const row = await waitForElement(() => screen.queryByRole('button', { name: `Open ${name}` }))
  fireEvent.click(row)
}

/** Opens the detail panel's ⋯ actions menu and clicks an item (Radix opens on pointerdown). */
const clickDetailMenuItem = async (label: string) => {
  const more = await waitForElement(() => screen.queryByRole('button', { name: 'More' }))
  await act(async () => {
    fireEvent.pointerDown(more, { button: 0 })
  })
  const item = await waitForElement(() => screen.queryByText(label))
  fireEvent.click(item)
  await act(async () => {
    await getClock().runAllAsync()
  })
}

describe('ConnectionsPage list', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    clearOAuthState()
    clearMcpOAuthState()
    cancelProviderBrowserConnection()
    otariBrowser.cancelOtariBrowserConnection()
    cancelTinfoilMobileConnection()
    await resetTestDatabase()
    await updateSettings(getDb(), { experimental_feature_otari: true })
  })

  afterEach(() => {
    cleanup()
    mock.restore()
    clearOAuthState()
    clearMcpOAuthState()
    cancelProviderBrowserConnection()
    otariBrowser.cancelOtariBrowserConnection()
    cancelTinfoilMobileConnection()
  })

  it('shows named connections independently of models and preserves per-model toggles when disabled or disconnected', async () => {
    const id = await saveProviderConnection(getDb(), {
      provider: 'openai',
      name: 'Work account',
      authMethod: 'api_key',
      credentials: { apiKey: 'local-secret' },
    })
    const [modelId] = await addProviderModels(getDb(), id, [{ id: 'work-model' }])
    const { triggerChange } = renderWithReactivity(<ConnectionsPage />, {
      tables: ['provider_connections', 'provider_connection_secrets', 'models'],
      wrapper: McpProviderWrapper,
    })
    fireEvent.click(await waitForElement(() => screen.queryByRole('switch', { name: 'Disable Work account' })))
    expect(await waitForElement(() => screen.queryByRole('alertdialog'))).toHaveTextContent('Disable Work account?')
    expect(await getProviderConnection(getDb(), id)).toMatchObject({ enabled: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(await getProviderConnection(getDb(), id)).toMatchObject({ enabled: 1 })
    fireEvent.click(screen.getByRole('switch', { name: 'Disable Work account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Disable connection' }))
    await act(async () => {
      await getClock().runAllAsync()
    })
    expect(await getProviderConnection(getDb(), id)).toMatchObject({ enabled: 0, connected: true })
    expect(await getModel(getDb(), modelId)).toMatchObject({ enabled: 1, deletedAt: null })
    expect(await getAvailableModels(getDb())).toEqual([])
    triggerChange(['provider_connections'])
    fireEvent.click(await waitForElement(() => screen.queryByRole('button', { name: 'Open Work account' })))
    fireEvent.click(await waitForElement(() => screen.queryByRole('button', { name: 'Disconnect this device' })))
    await act(async () => {
      await getClock().runAllAsync()
    })
    expect(await getProviderConnection(getDb(), id)).toMatchObject({ connected: false })
    expect(await getModel(getDb(), modelId)).toMatchObject({ enabled: 1, deletedAt: null })
    triggerChange(['provider_connections', 'provider_connection_secrets'])
    expect(await waitForElement(() => screen.queryByLabelText('API key'))).toHaveValue('')
  })

  it.each(['add', 'existing'] as const)(
    'opens the same OAuth details through %s and supports editing or another API-key instance',
    async (entry) => {
      await saveProviderConnection(getDb(), {
        provider: 'otari',
        name: 'Team account',
        url: 'https://team.example/api/v1',
        authMethod: 'oauth',
        credentials: { access_token: 'local-token' },
      })
      renderWithReactivity(<ConnectionsPage />, {
        tables: ['provider_connections', 'provider_connection_secrets'],
        wrapper: McpProviderWrapper,
      })
      await waitForElement(() => screen.queryByRole('button', { name: 'Open Team account' }))
      if (entry === 'add') {
        fireEvent.click(screen.getByRole('button', { name: 'New Connection' }))
        fireEvent.click(await waitForElement(() => screen.queryByRole('button', { name: 'Otari Models and search' })))
      } else {
        fireEvent.click(screen.getByRole('button', { name: 'Open Team account' }))
      }
      expect(await waitForElement(() => screen.queryByRole('heading', { name: 'Connected to Otari' }))).toBeVisible()
      expect(screen.getByRole('status')).toHaveTextContent('https://team.example/api/v1')
      expect(screen.getByRole('status')).not.toHaveTextContent('Team account')
      expect(screen.getByRole('button', { name: 'Disconnect this device' })).toBeVisible()
      expect(Boolean(screen.queryByRole('button', { name: 'Continue' }))).toBe(entry === 'add')
      await clickDetailMenuItem('Edit')
      expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
      expect(screen.getByLabelText('Name')).toHaveValue('Team account')
      expect(screen.queryByLabelText('API key')).toBeNull()
      expect(screen.queryByLabelText('Server URL')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      fireEvent.click(screen.getByRole('button', { name: 'Add another instance via API key' }))
      expect(await waitForElement(() => screen.queryByLabelText('API key'))).toBeEnabled()
      expect(screen.getByLabelText('API key')).toHaveValue('')
      fireEvent.click(screen.getByRole('button', { name: 'Use sign-in instead' }))
      expect(await waitForElement(() => screen.queryByRole('heading', { name: 'Connected to Otari' }))).toBeVisible()
      expect(screen.getByRole('button', { name: 'More' })).toBeVisible()
    },
  )

  it.each([
    'Otari Models and search',
    'Tinfoil Models and search',
    'Privatemode Models',
    'OpenRouter Models',
    'OpenAI Models',
    'Google Productivity',
    'Microsoft Productivity',
    'MCP server',
  ])('returns from %s to the connection picker', async (name) => {
    renderWithReactivity(<ConnectionsPage />, { wrapper: McpProviderWrapper })
    fireEvent.click(await waitForElement(() => screen.queryByRole('button', { name: 'New Connection' })))
    fireEvent.click(await waitForElement(() => screen.queryByRole('button', { name })))
    expect(await waitForElement(() => screen.queryByRole('button', { name: 'Go back' }))).toBeVisible()
    if (name !== 'MCP server') {
      expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    }
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }))
    expect(screen.getByRole('heading', { name: 'New Connection' })).toBeVisible()
    expect(await waitForElement(() => screen.queryByRole('button', { name: 'Otari Models and search' }))).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Go back' })).toBeNull()
  })

  it('continues after saving an API key and finishes setup without changing existing-detail navigation', async () => {
    renderWithReactivity(<ConnectionsPage />, {
      tables: ['provider_connections', 'provider_connection_secrets'],
      wrapper: McpProviderWrapper,
    })
    fireEvent.click(await waitForElement(() => screen.queryByRole('button', { name: 'New Connection' })))
    fireEvent.click(screen.getByRole('button', { name: 'OpenAI Models' }))
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'test-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitForElement(() => screen.queryByRole('button', { name: 'Disconnect this device' }))
    expect(screen.getByRole('button', { name: 'Go back' })).toBeVisible()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    })
    expect(Boolean(screen.queryByRole('button', { name: 'Close details' }))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Open OpenAI' }))
    expect(screen.queryByRole('button', { name: 'Go back' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  })

  it('opens a synced connection without device credentials and keeps two API-key accounts distinct', async () => {
    const personal = await saveProviderConnection(getDb(), {
      provider: 'openai',
      name: 'Personal',
      authMethod: 'api_key',
      credentials: { apiKey: 'personal' },
    })
    await saveProviderConnection(getDb(), {
      provider: 'openai',
      name: 'Team',
      authMethod: 'api_key',
      credentials: { apiKey: 'team' },
    })
    await disconnectProviderConnection(getDb(), personal)
    renderWithReactivity(<ConnectionsPage />, {
      tables: ['provider_connections', 'provider_connection_secrets'],
      wrapper: McpProviderWrapper,
    })
    expect(await waitForElement(() => screen.queryByRole('button', { name: 'Open Team' }))).toBeInTheDocument()
    fireEvent.click(await waitForElement(() => screen.queryByRole('button', { name: 'Open Personal' })))
    expect(await waitForElement(() => screen.queryByLabelText('Name'))).toHaveValue('Personal')
    expect(screen.getByLabelText('API key')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Save connection' })).toBeDisabled()
  })

  it('opens the exact connection linked from a model', async () => {
    const id = await saveProviderConnection(getDb(), {
      provider: 'openai',
      name: 'Linked account',
      authMethod: 'api_key',
      credentials: { apiKey: 'one' },
    })
    await saveProviderConnection(getDb(), {
      provider: 'openai',
      name: 'Other account',
      authMethod: 'api_key',
      credentials: { apiKey: 'two' },
    })
    const LinkedConnectionWrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={[{ pathname: '/settings/connections', state: { providerConnectionId: id } }]}>
        <HttpClientProvider httpClient={createMockHttpClient()}>
          <MCPProvider createClient={neverResolves}>{children}</MCPProvider>
        </HttpClientProvider>
      </MemoryRouter>
    )
    renderWithReactivity(<ConnectionsPage />, {
      tables: ['provider_connections', 'provider_connection_secrets'],
      wrapper: LinkedConnectionWrapper,
    })
    expect(await waitForElement(() => screen.queryByRole('heading', { name: 'Linked account' }))).toBeVisible()
    expect(screen.getByRole('button', { name: 'Disconnect this device' })).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Manage models' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Go back' })).toBeNull()
    expect(screen.queryByLabelText('Name')).toBeNull()
    await clickDetailMenuItem('Edit')
    expect(await waitForElement(() => screen.queryByLabelText('Name'))).toHaveValue('Linked account')
  })

  it('finishes a browser return in the chat aside without navigating to settings', async () => {
    const nonce = 'n'.repeat(43)
    const attempt = await getProviderConnectionAttempt(getDb(), 'openrouter')
    const exchange = mock(async () => 'test-provider-key')
    const deps = {
      origin: () => 'https://app.example',
      currentPath: () => '/chats/new?project=work' as const,
      verifier: () => nonce,
      challenge: async () => 'challenge',
      navigate: () => {},
      exchangeOpenRouter: exchange,
    }
    await startProviderBrowserConnection('openrouter', 'connections', attempt, new AbortController().signal, deps)
    captureProviderBrowserReturn(
      new URL(`https://app.example/oauth/openrouter/${nonce}?code=test&state=${nonce}`),
      deps,
    )
    const RouteProbe = () => {
      const location = useLocation()
      return (
        <p data-testid="return-path">
          {location.pathname}
          {location.search}
        </p>
      )
    }
    const ReturnWrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter
        initialEntries={[{ pathname: '/chats/new', search: '?project=work', state: { connectionOAuthReturn: nonce } }]}
      >
        <HttpClientProvider httpClient={createMockHttpClient()}>
          <MCPProvider createClient={neverResolves}>
            <CreateItemProvider>
              <RouteProbe />
              {children}
            </CreateItemProvider>
          </MCPProvider>
        </HttpClientProvider>
      </MemoryRouter>
    )
    await act(async () => {
      renderWithReactivity(<LazyCreateItemHost />, {
        wrapper: ReturnWrapper,
        tables: ['provider_connections', 'provider_connection_secrets'],
      })
    })
    expect(await waitForElement(() => screen.queryByText('Connected to OpenRouter'))).toBeVisible()
    expect(screen.getByTestId('return-path')).toHaveTextContent('/chats/new?project=work')
    expect(exchange).toHaveBeenCalledTimes(1)
    expect(await getProviderConnection(getDb(), 'oauth:openrouter')).toMatchObject({ connected: true })
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    expect(screen.getByTestId('return-path')).toHaveTextContent('/chats/new?project=work')
    expect(screen.queryByText('Connected to OpenRouter')).toBeNull()
  })

  it('consumes callback parameters without closing the restored aside or replaying an error', async () => {
    setOAuthState({ provider: 'google', state: 'return-nonce', returnContext: '/chats/new' })
    const RouteProbe = () => {
      const location = useLocation()
      return <p data-testid="callback-state">{JSON.stringify({ path: location.pathname, ...location.state })}</p>
    }
    const ReturnWrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/chats/new',
            state: {
              connectionOAuthReturn: 'return-nonce',
              oauth: { state: 'return-nonce', error: 'Authorization denied' },
            },
          },
        ]}
      >
        <HttpClientProvider httpClient={createMockHttpClient()}>
          <MCPProvider createClient={neverResolves}>
            <CreateItemProvider>
              <RouteProbe />
              {children}
            </CreateItemProvider>
          </MCPProvider>
        </HttpClientProvider>
      </MemoryRouter>
    )
    await act(async () => {
      renderWithReactivity(<LazyCreateItemHost />, { wrapper: ReturnWrapper })
    })
    expect(await waitForElement(() => screen.queryByText('Authorization denied'))).toBeVisible()
    await act(async () => {
      await getClock().runAllAsync()
    })
    expect(screen.getByRole('heading', { name: 'Google' })).toBeVisible()
    expect(JSON.parse(screen.getByTestId('callback-state').textContent!)).toEqual({
      path: '/chats/new',
      connectionOAuthReturn: 'return-nonce',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    expect(JSON.parse(screen.getByTestId('callback-state').textContent!)).toEqual({ path: '/chats/new' })
  })

  it('opens provider editing and removal confirmation from its context menu', async () => {
    const id = await saveProviderConnection(getDb(), {
      provider: 'exa',
      name: 'Work Exa',
      authMethod: 'api_key',
      credentials: { apiKey: 'test' },
    })
    renderWithReactivity(<ConnectionsPage />, {
      wrapper: McpProviderWrapper,
      tables: ['provider_connections', 'provider_connection_secrets'],
    })
    const row = await waitForElement(() => screen.queryByRole('button', { name: 'Open Work Exa' }))
    fireEvent.click(screen.getByRole('button', { name: 'New Connection' }))
    fireEvent.click(screen.getByRole('button', { name: 'MCP server' }))
    expect(screen.getByRole('heading', { name: 'Add MCP Server' })).toBeVisible()
    fireEvent.contextMenu(row)
    fireEvent.click(await waitForElement(() => screen.queryByRole('menuitem', { name: 'Edit' })))
    expect(await waitForElement(() => screen.queryByLabelText('Name'))).toHaveValue('Work Exa')
    fireEvent.contextMenu(row)
    fireEvent.click(await waitForElement(() => screen.queryByRole('menuitem', { name: 'Remove' })))
    expect(await waitForElement(() => screen.queryByRole('alertdialog'))).toHaveTextContent('Remove Work Exa?')
    expect(await getProviderConnection(getDb(), id)).toMatchObject({ deletedAt: null })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await getProviderConnection(getDb(), id)).toMatchObject({ deletedAt: null })
  })

  it.each(['Edit', 'Remove'] as const)(
    'cancels provider authorization when a context menu chooses %s',
    async (action) => {
      await saveProviderConnection(getDb(), {
        provider: 'exa',
        name: 'Saved search',
        authMethod: 'api_key',
        credentials: { apiKey: 'test' },
      })
      spyOn(platform, 'isTauri').mockReturnValue(false)
      const start = spyOn(otariBrowser, 'startOtariBrowserConnection').mockResolvedValue()
      renderWithReactivity(<ConnectionsPage />, {
        wrapper: McpProviderWrapper,
        tables: ['provider_connections', 'provider_connection_secrets'],
      })
      const row = await waitForElement(() => screen.queryByRole('button', { name: 'Open Saved search' }))
      fireEvent.click(screen.getByRole('button', { name: 'New Connection' }))
      fireEvent.click(screen.getByRole('button', { name: 'Otari Models and search' }))
      fireEvent.click(screen.getByRole('button', { name: 'Connect Otari' }))
      await act(async () => {
        await getClock().runAllAsync()
      })
      expect(start).toHaveBeenCalledTimes(1)
      const signal = start.mock.calls[0][2]
      expect(signal.aborted).toBe(false)
      fireEvent.contextMenu(row)
      fireEvent.click(await waitForElement(() => screen.queryByRole('menuitem', { name: action })))
      expect(signal.aborted).toBe(true)
    },
  )

  it('cancels an account switch when adding a separate API-key connection', async () => {
    await getDb().transaction((tx) =>
      saveProviderConnectionInTransaction(tx, {
        provider: 'openai',
        name: 'ChatGPT',
        authMethod: 'oauth',
        credentials: {
          access_token: 'test',
          oauth: {
            issuer: 'https://auth.openai.com',
            clientId: 'personal',
            tokenEndpoint: 'https://auth.openai.com/oauth/token',
            resource: 'https://api.openai.com/v1',
            subject: 'person',
            scope: 'chatgpt.tokens.use.direct',
          },
        },
      }),
    )
    spyOn(chatgptAuth, 'canConnectChatGPT').mockReturnValue(true)
    const connect = spyOn(chatgptAuth, 'connectChatGPT').mockImplementation(
      async (_db, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )
    renderWithReactivity(<ConnectionsPage />, {
      wrapper: McpProviderWrapper,
      tables: ['provider_connections', 'provider_connection_secrets'],
    })
    fireEvent.click(await waitForElement(() => screen.queryByRole('button', { name: 'Open ChatGPT' })))
    const picker = await waitForElement(() => screen.queryByRole('button', { name: 'Choose ChatGPT account' }))
    await act(async () => {
      fireEvent.pointerDown(picker, { button: 0 })
    })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Use another ChatGPT account' }))
    await waitForElement(() => (connect.mock.calls.length > 0 ? document.body : null))
    expect(connect).toHaveBeenCalledTimes(1)
    const signal = connect.mock.calls[0][1]
    expect(signal.aborted).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Add another instance via API key' }))
    expect(signal.aborted).toBe(true)
    expect(await waitForElement(() => screen.queryByLabelText('API key'))).toBeVisible()
  })

  it.each(['desktop', 'manual'] as const)(
    'shows connected controls after an in-place OAuth reconnect: %s',
    async (flow) => {
      const id = await saveProviderConnection(getDb(), {
        provider: 'openrouter',
        name: 'My OpenRouter',
        authMethod: 'oauth',
        credentials: { access_token: 'old' },
      })
      await disconnectProviderConnection(getDb(), id)
      spyOn(platform, 'isTauri').mockReturnValue(true)
      spyOn(platform, 'isMobile').mockReturnValue(flow === 'manual')
      spyOn(openrouterAuth, 'startOpenRouterConnection').mockResolvedValue('new-token')
      spyOn(openrouterAuth, 'prepareOpenRouterManualConnection').mockResolvedValue({
        authorizationUrl: 'https://openrouter.ai/auth',
        verifier: 'test-verifier',
      })
      spyOn(opener, 'openUrl').mockResolvedValue()
      spyOn(openrouterAuth, 'exchangeOpenRouterCode').mockResolvedValue('new-token')
      renderWithReactivity(<ConnectionsPage />, {
        wrapper: McpProviderWrapper,
        tables: ['provider_connections', 'provider_connection_secrets'],
      })
      fireEvent.click(await waitForElement(() => screen.queryByRole('button', { name: 'Open My OpenRouter' })))
      for (const attempt of [1, 2]) {
        fireEvent.click(await waitForElement(() => screen.queryByRole('button', { name: 'Connect OpenRouter' })))
        if (flow === 'manual') {
          const code = await waitForElement(() => screen.queryByLabelText('Authorization code'))
          fireEvent.change(code, { target: { value: 'test-code' } })
          fireEvent.click(screen.getByRole('button', { name: 'Complete connection' }))
        }
        const disconnect = await waitForElement(() => screen.queryByRole('button', { name: 'Disconnect this device' }))
        expect(Boolean(disconnect)).toBe(true)
        expect(screen.queryByRole('button', { name: 'Connect OpenRouter' })).toBeNull()
        expect(screen.queryByLabelText('Authorization code')).toBeNull()
        expect(screen.getByRole('status')).toHaveTextContent('Connected to OpenRouter')
        if (attempt === 1) {
          fireEvent.click(disconnect)
        }
      }
    },
  )

  it('opens the connection aside directly from empty chat and lets users choose a provider', async () => {
    renderWithReactivity(
      <Routes>
        <Route
          path="/"
          element={
            <CreateItemProvider>
              <ChatModelSetup />
              <LazyCreateItemHost />
            </CreateItemProvider>
          }
        />
        <Route path="/settings/connections" element={<ConnectionsPage />} />
      </Routes>,
      {
        tables: ['provider_connections', 'provider_connection_secrets'],
        wrapper: McpProviderWrapper,
      },
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add connection' }))
      await getClock().runAllAsync()
    })
    expect(await waitForElement(() => screen.queryByRole('heading', { name: 'New Connection' }))).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Otari Models and search' }))
    expect(await waitForElement(() => screen.queryByRole('button', { name: 'Connect Otari' }))).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    expect(screen.queryByRole('button', { name: 'Connect Otari' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'New Connection' })).not.toBeInTheDocument()
  })

  it.each([true, false])(
    'hides cloud connections until sign-in and hides them again on sign-out (local mode: %s)',
    async (localMode) => {
      useLocalSettingsStore.setState({ cloudUrl: 'https://test-api.local/v1', localMode })
      renderWithReactivity(<ConnectionsPage />, { wrapper: McpProviderWrapper })
      expect(await waitForElement(() => screen.queryByRole('heading', { name: 'No connections yet' }))).toBeVisible()
      fireEvent.click(screen.getByRole('button', { name: 'New Connection' }))
      expect(screen.queryByRole('button', { name: 'Thunderbolt Search' })).toBeNull()
      for (const name of ['Google Productivity', 'Microsoft Productivity']) {
        expect(screen.getByRole('button', { name })).toBeVisible()
      }
      expect(
        await waitForElement(() => screen.queryByRole('button', { name: 'Otari Models and search' })),
      ).toBeVisible()
      expect(screen.getByRole('button', { name: 'MCP server' })).toBeVisible()
      await act(async () => {
        setAuthToken('cloud-session')
        await getClock().runAllAsync()
      })
      for (const name of ['Thunderbolt Search', 'Google Productivity', 'Microsoft Productivity']) {
        expect(screen.getByRole('button', { name })).toBeVisible()
      }
      expect(screen.getByRole('button', { name: 'Open Thunderbolt' })).toBeVisible()
      act(() => clearAuthToken())
      expect(screen.queryByRole('button', { name: 'Thunderbolt Search' })).toBeNull()
      for (const name of ['Google Productivity', 'Microsoft Productivity']) {
        expect(screen.getByRole('button', { name })).toBeVisible()
      }
      expect(screen.queryByRole('button', { name: 'Open Thunderbolt' })).toBeNull()
    },
  )

  it('offers disconnected integrations in the create menu and updates MCP servers', async () => {
    setAuthToken('cloud-session')
    const db = getDb()

    await createMcpServer(db, {
      id: uuidv7(),
      name: 'First Server',
      url: 'http://localhost:8000/mcp/',
      type: 'http',
      enabled: 1,
    })

    const { triggerChange } = renderWithReactivity(<ConnectionsPage />, {
      tables: ['mcp_servers'],
      wrapper: McpProviderWrapper,
    })

    expect(screen.queryByText('Google')).not.toBeInTheDocument()
    expect(screen.queryByText('Microsoft')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New Connection' }))
    expect(screen.getByRole('button', { name: 'Google Productivity' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Microsoft Productivity' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Thunderbolt Search' })).toBeInTheDocument()

    await waitForElement(() => screen.queryByText('First Server'))
    expect(screen.getByText('First Server')).toBeInTheDocument()

    await createMcpServer(db, {
      id: uuidv7(),
      name: 'Second Server',
      url: 'http://localhost:9000/mcp/',
      type: 'http',
      enabled: 1,
    })
    triggerChange(['mcp_servers'])

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(screen.getByText('Second Server')).toBeInTheDocument()
  })

  it('falls back to the cleaned URL for a server without a name', async () => {
    const db = getDb()
    await createMcpServer(db, {
      id: uuidv7(),
      name: '',
      url: 'http://localhost:8000/mcp/',
      type: 'http',
      enabled: 1,
    })

    renderWithReactivity(<ConnectionsPage />, {
      tables: ['mcp_servers'],
      wrapper: McpProviderWrapper,
    })

    await waitForElement(() => screen.queryByText('localhost:8000/mcp'))
    expect(screen.getByText('localhost:8000/mcp')).toBeInTheDocument()
  })
})

// Renders the page with injected probe/flow deps, opens the add form, and
// types the URL (+ optional token). Returns the deps' mocks for assertions.
const renderAddForm = async (deps: ConnectionsPageDeps, { url, token }: { url: string; token?: string }) => {
  const result = renderWithReactivity(<ConnectionsPage deps={deps} />, {
    tables: ['mcp_servers', 'mcp_secrets'],
    wrapper: McpProviderWrapper,
  })
  const openButton = await waitForElement(() => screen.queryByRole('button', { name: 'New Connection' }))
  fireEvent.click(openButton)
  fireEvent.click(await waitForElement(() => screen.queryByRole('button', { name: 'MCP server' })))
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

describe('ConnectionsPage Test Connection classification', () => {
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
    await renderAddForm(
      { probeMcpServerTools: async () => Promise.reject(unauthorized()), classifyMcpServerAuth },
      { url: 'https://oauth.example.com/mcp', token: 'pat-123' },
    )

    await flushAutoProbe()

    expect(screen.getByText('Token rejected')).toBeInTheDocument()
    expect(classifyMcpServerAuth).not.toHaveBeenCalled()
  })

  it('classifies an empty-credential 401 via discovery and offers Add & Authorize', async () => {
    const classifyMcpServerAuth = mock(async () => 'authorizable' as const)
    await renderAddForm(
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
    await renderAddForm(
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
    await renderAddForm(
      { probeMcpServerTools: async () => ['search', 'fetch'] },
      { url: 'https://tools.example.com/mcp' },
    )

    await flushAutoProbe()

    expect(screen.getByText('Connection successful!')).toBeInTheDocument()
    expect(screen.getByText('search')).toBeInTheDocument()
  })
})

describe('ConnectionsPage Add & Authorize', () => {
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

  it('rolls back the created server row and shows the form error when the flow fails to start', async () => {
    const db = getDb()
    const startMcpOAuthFlow: NonNullable<ConnectionsPageDeps['startMcpOAuthFlow']> = mock(async () => {
      throw new Error('Another MCP authorization is already in progress — finish or cancel it first.')
    })
    await renderAddForm(
      {
        probeMcpServerTools: async () => Promise.reject(unauthorized()),
        classifyMcpServerAuth: async () => 'authorizable' as const,
        startMcpOAuthFlow,
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
    const startMcpOAuthFlow: NonNullable<ConnectionsPageDeps['startMcpOAuthFlow']> = mock(
      () => new Promise<never>(() => {}),
    )
    await renderAddForm(
      {
        probeMcpServerTools: async () => Promise.reject(unauthorized()),
        classifyMcpServerAuth: async () => 'authorizable' as const,
        startMcpOAuthFlow,
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

  it('closes the add form once the OAuth flow starts cleanly', async () => {
    const startMcpOAuthFlow: NonNullable<ConnectionsPageDeps['startMcpOAuthFlow']> = mock(async () => ({
      status: 'redirected' as const,
    }))
    await renderAddForm(
      {
        probeMcpServerTools: async () => Promise.reject(unauthorized()),
        classifyMcpServerAuth: async () => 'authorizable' as const,
        startMcpOAuthFlow,
      },
      { url: 'https://oauth.example.com/mcp' },
    )
    await flushAutoProbe()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Add & Authorize/ }))
      await getClock().runAllAsync()
    })

    // The form is gone — no lingering needs-oauth UI to trigger a duplicate add.
    expect(screen.queryByPlaceholderText('http://localhost:8000/mcp/')).not.toBeInTheDocument()
  })
})

describe('ConnectionsPage ordinary add', () => {
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

  it('creates one row when Add Server is activated twice before the first write settles', async () => {
    const db = getDb()
    await renderAddForm({ probeMcpServerTools: async () => ['search'] }, { url: 'https://tools.example.com/mcp' })
    await flushAutoProbe()
    const addButton = screen.getByRole('button', { name: 'Add Server' })

    await act(async () => {
      fireEvent.click(addButton)
      fireEvent.click(addButton)
      await getClock().runAllAsync()
    })

    expect(await getAllMcpServers(db)).toHaveLength(1)
  })
})

describe('ConnectionsPage iroh add flow', () => {
  const irohTarget = 'a'.repeat(52)
  const appNodeId = 'b'.repeat(52)

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

  const openIrohForm = async (extraDeps: Partial<ConnectionsPageDeps> = {}) => {
    const result = renderWithReactivity(
      <ConnectionsPage deps={{ loadAppNodeId: async () => appNodeId, ...extraDeps }} />,
      { tables: ['mcp_servers', 'mcp_secrets'], wrapper: McpProviderWrapper },
    )
    const openButton = await waitForElement(() => screen.queryByRole('button', { name: 'New Connection' }))
    fireEvent.click(openButton)
    fireEvent.click(await waitForElement(() => screen.queryByRole('button', { name: 'MCP server' })))
    const urlInput = await waitForElement(() => screen.queryByPlaceholderText('http://localhost:8000/mcp/'))
    fireEvent.change(screen.getByPlaceholderText('Server name (used to prefix tools)'), {
      target: { value: 'Laptop Bridge' },
    })
    fireEvent.change(urlInput, { target: { value: irohTarget } })
    return result
  }

  it('shows the pairing panel with this app allow command for an iroh target', async () => {
    await openIrohForm()
    const panel = await waitForElement(() => screen.queryByTestId('iroh-pairing-panel'))
    await waitForElement(() => (panel.textContent?.includes(`thunderbolt iroh allow ${appNodeId}`) ? panel : null))
    // The http/sse-only controls are hidden for iroh.
    expect(screen.queryByRole('button', { name: /Test connection/ })).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Bearer token or API key')).not.toBeInTheDocument()
  })

  it('stores the server with type="iroh" and the NodeId as url', async () => {
    const db = getDb()
    await openIrohForm()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add Server' }))
      await getClock().runAllAsync()
    })

    const created = await getAllMcpServers(db)
    expect(created).toHaveLength(1)
    expect(created[0]?.type).toBe('iroh')
    expect(created[0]?.url).toBe(irohTarget)
    expect(created[0]?.name).toBe('Laptop Bridge')
  })

  it('self-enrolls this app when adding an iroh bridge', async () => {
    const enrollIroh = mock(async () => {})
    await openIrohForm({ enrollIroh })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add Server' }))
      await getClock().runAllAsync()
    })

    expect(enrollIroh).toHaveBeenCalledTimes(1)
    expect(enrollIroh).toHaveBeenCalledWith()
  })

  it('still creates the server and keeps the manual pairing panel when enrollment fails', async () => {
    const db = getDb()
    const enrollIroh = mock(async () => {
      throw new Error('no account (standalone)')
    })
    await openIrohForm({ enrollIroh })
    expect(screen.getByTestId('iroh-pairing-panel')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add Server' }))
      await getClock().runAllAsync()
    })

    const created = await getAllMcpServers(db)
    expect(created).toHaveLength(1)
    expect(created[0]?.type).toBe('iroh')
  })

  it('does not block the add on a slow (never-resolving) enrollment', async () => {
    const db = getDb()
    const enrollIroh = mock(() => new Promise<void>(() => {}))
    await openIrohForm({ enrollIroh })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add Server' }))
      await getClock().runAllAsync()
    })

    const created = await getAllMcpServers(db)
    expect(created).toHaveLength(1)
    expect(screen.queryByText('Add MCP Server')).not.toBeInTheDocument()
  })
})

describe('ConnectionsPage Edit server', () => {
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

  it('prefills the form from the existing server and persists the patch on Save', async () => {
    const db = getDb()
    const id = uuidv7()
    await createMcpServerWithCredentials(
      db,
      { id, name: 'Original', type: 'http', url: 'https://old.example.com/mcp', enabled: 1 },
      { type: 'bearer', token: 'original-token' },
    )

    renderWithReactivity(<ConnectionsPage deps={{ probeMcpServerTools: async () => ['search'] }} />, {
      tables: ['mcp_servers', 'mcp_secrets'],
      wrapper: McpProviderWrapper,
    })

    // Edit lives in the detail panel's ⋯ menu now.
    await openServerDetail('Original')
    await clickDetailMenuItem('Edit')

    // Panel title flips to Edit and the existing values are surfaced — name in
    // the visible input; the stored token is only hinted at via the masked
    // placeholder, never round-tripped into the DOM.
    expect(await waitForElement(() => screen.queryByText('Edit MCP Server'))).toBeInTheDocument()
    const nameInput = screen.getByPlaceholderText('Server name (used to prefix tools)') as HTMLInputElement
    const urlInput = screen.getByPlaceholderText('http://localhost:8000/mcp/') as HTMLInputElement
    const tokenInput = screen.getByPlaceholderText('••••••••••••••••') as HTMLInputElement
    expect(nameInput.value).toBe('Original')
    expect(urlInput.value).toBe('https://old.example.com/mcp')
    expect(tokenInput.value).toBe('')
    expect(screen.getByRole('button', { name: 'Clear saved credential' })).toBeInTheDocument()
    // Bulk-import toggle is hidden in Edit mode.
    expect(screen.queryByRole('radio', { name: 'Advanced (JSON)' })).not.toBeInTheDocument()

    // Rename and let the auto-probe fire so the success gate unlocks Save.
    fireEvent.change(nameInput, { target: { value: 'Renamed' } })
    await flushAutoProbe()
    expect(screen.getByText('Connection successful!')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
      await getClock().runAllAsync()
    })

    const rows = await getAllMcpServers(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(id)
    expect(rows[0]?.name).toBe('Renamed')
    expect(rows[0]?.url).toBe('https://old.example.com/mcp')
    // The prefilled bearer token survives an edit that doesn't touch it.
    expect(await getMcpServerCredentials(db, id)).toEqual({
      type: 'bearer',
      token: 'original-token',
      approvedUrl: 'https://old.example.com/mcp',
    })
  })

  it('saves a rename of an iroh server without a probe (no http/sse gate applies)', async () => {
    const db = getDb()
    const id = uuidv7()
    const irohTarget = 'a'.repeat(52)
    await createMcpServer(db, { id, name: 'Old Bridge', type: 'iroh', url: irohTarget, enabled: 1 })

    const enrollIroh = mock(async () => {})
    renderWithReactivity(<ConnectionsPage deps={{ loadAppNodeId: async () => 'b'.repeat(52), enrollIroh }} />, {
      tables: ['mcp_servers', 'mcp_secrets'],
      wrapper: McpProviderWrapper,
    })

    await openServerDetail('Old Bridge')
    await clickDetailMenuItem('Edit')

    // The iroh pairing panel (not the http/sse probe UI) is what edit surfaces.
    await waitForElement(() => screen.queryByTestId('iroh-pairing-panel'))
    expect(screen.queryByRole('button', { name: /Test connection/ })).not.toBeInTheDocument()

    const nameInput = screen.getByPlaceholderText('Server name (used to prefix tools)') as HTMLInputElement
    expect(nameInput.value).toBe('Old Bridge')
    fireEvent.change(nameInput, { target: { value: 'New Bridge' } })

    // Save is ready with no probe — an iroh server has none to run.
    const saveButton = screen.getByRole('button', { name: 'Save Changes' }) as HTMLButtonElement
    expect(saveButton.disabled).toBe(false)
    await act(async () => {
      fireEvent.click(saveButton)
      await getClock().runAllAsync()
    })

    const rows = await getAllMcpServers(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('New Bridge')
    expect(rows[0]?.type).toBe('iroh')
    expect(rows[0]?.url).toBe(irohTarget)
    expect(enrollIroh).not.toHaveBeenCalled()
  })
})

describe('ConnectionsPage probe lifecycle', () => {
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
    await renderAddForm({ probeMcpServerTools }, { url: 'https://a.example.com/mcp' })
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

  it('does not auto-probe after the add form is closed', async () => {
    const probeMcpServerTools = mock(async () => ['tool'])
    await renderAddForm({ probeMcpServerTools }, { url: 'https://late.example.com/mcp' })
    // Leave the form before the 700ms debounce fires.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Go back' }))
    })
    await flushAutoProbe()

    expect(probeMcpServerTools).not.toHaveBeenCalled()
  })
})

type CreateClientFn = (serverId: string, url: string, type: MCPTransportType) => Promise<MCPClient>

/** A connected-client stand-in whose tools() reports the given names. */
const fakeClient = (toolNames: string[]): MCPClient => {
  const emptyTools: Awaited<ReturnType<MCPClient['tools']>> = {}
  const tools = new Proxy(emptyTools, {
    ownKeys: () => toolNames,
    getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }),
  })
  return {
    tools: async () => tools,
    close: async () => {},
  }
}

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
      <HttpClientProvider httpClient={createMockHttpClient()}>
        <MCPProvider createClient={createClient}>
          <CaptureMcpContext />
          {children}
        </MCPProvider>
      </HttpClientProvider>
    </MemoryRouter>
  )
  return Wrapper
}

/** Expands the panel's Available Tools accordion when it isn't already open. */
const ensureToolsExpanded = async () => {
  const label = await waitForElement(() => screen.queryByText('Available Tools'))
  const trigger = label.closest('button')
  if (trigger && trigger.getAttribute('data-state') !== 'open') {
    fireEvent.click(trigger)
  }
}

describe('ConnectionsPage tools refresh after reconnect', () => {
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
  // given createClient, registers + connects the server through the provider,
  // and opens the server's detail panel (tools/status live there now).
  const addLiveServer = async (createClient: CreateClientFn) => {
    const db = getDb()
    const serverId = uuidv7()
    const url = 'http://localhost:8000/mcp/'
    await createMcpServer(db, { id: serverId, name: 'srv', url, type: 'http', enabled: 1 })
    renderWithReactivity(<ConnectionsPage />, {
      tables: ['mcp_servers', 'mcp_secrets'],
      wrapper: makeMcpWrapper(createClient),
    })
    await act(async () => {
      await getMcp().addServer({ id: serverId, name: 'srv', url, type: 'http', enabled: true })
      await getClock().runAllAsync()
    })
    await openServerDetail('srv')
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
    // with an error — the panel must not keep rendering the dead connection's tools.
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
    // surfaces the Retry connection affordance in the detail panel.
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

describe('ConnectionsPage add-form error labeling', () => {
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
    renderWithReactivity(<ConnectionsPage />, {
      tables: ['mcp_servers', 'mcp_secrets'],
      wrapper: McpProviderWrapper,
    })
    const openButton = await waitForElement(() => screen.queryByRole('button', { name: 'New Connection' }))
    fireEvent.click(openButton)
    fireEvent.click(await waitForElement(() => screen.queryByRole('button', { name: 'MCP server' })))

    // Advanced mode: paste a config with no servers, then import → error panel.
    fireEvent.click(await waitForElement(() => screen.queryByText('Advanced (JSON)')))
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
