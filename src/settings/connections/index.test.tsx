/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMcpServer, createMcpServerWithCredentials, getAllMcpServers, getMcpServerCredentials } from '@/dal'
import { tinfoilSession, createTinfoilSession } from '@/lib/tinfoil-session'
import * as tinfoilSessions from '@/lib/tinfoil-session'
import {
  getProviderConnectionAttempt,
  assertProviderConnectionAttemptCurrent,
  invalidateProviderConnectionAttempts,
} from '@/lib/provider-connection-attempt'
import { tinfoilAuth, TinfoilReauthorizationError } from '@/lib/tinfoil-auth'
import * as platform from '@/lib/platform'
import { createModel, getModel, getAvailableModels } from '@/dal/models'
import { getIntegrationCredentials, saveIntegrationCredentials } from '@/dal/integrations'
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
import { MemoryRouter } from 'react-router'
import { v7 as uuidv7 } from 'uuid'
import ConnectionsPage from '.'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { getOtariSearchAvailability } from '@/integrations/otari-search/connection'
import * as otariBrowser from '@/lib/otari-browser-auth'

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
}

describe('ConnectionsPage list', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    useSearchProviderStore.getState().clearSearchProvider()
    const session = createTinfoilSession({ db: getDb, auth: tinfoilAuth, lock: async (work) => work(), now: Date.now })
    spyOn(tinfoilSession, 'setEnabled').mockImplementation(session.setEnabled)
    spyOn(tinfoilSessions, 'withTinfoilSessionLock').mockImplementation(async (work) => work())
  })

  afterEach(() => {
    cleanup()
    mock.restore()
    useSearchProviderStore.getState().clearSearchProvider()
  })

  it('shows disconnected providers as disabled switches in the same list as Google', async () => {
    await invalidateProviderConnectionAttempts(getDb(), 'openrouter')
    renderWithReactivity(<ConnectionsPage />, { tables: ['models'], wrapper: McpProviderWrapper })
    const openrouter = await waitForElement(() => screen.queryByRole('switch', { name: 'Enable OpenRouter' }))
    expect(openrouter).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Enable Tinfoil' })).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Enable Otari' })).toBeDisabled()
    expect(openrouter.closest('ul')).toBe(screen.getByRole('switch', { name: 'Enable Google' }).closest('ul'))
    expect(screen.queryByText('Not connected')).not.toBeInTheDocument()
  })

  it('recognizes Otari independently of search configuration', async () => {
    await createModel(getDb(), {
      id: 'otari-without-search',
      name: 'Otari model',
      model: 'example/model',
      provider: 'otari',
      url: 'https://otari.example/api/v1',
      apiKey: 'delegated-key',
      providerDefault: 1,
      enabled: 1,
    })
    renderWithReactivity(<ConnectionsPage />, {
      tables: ['models', 'models_secrets'],
      wrapper: McpProviderWrapper,
    })
    expect(await waitForElement(() => screen.queryByRole('switch', { name: 'Disable Otari' }))).toBeChecked()
  })

  it('controls Otari models and search together, and disconnects without deleting model history', async () => {
    const connection = {
      modelId: 'otari-model',
      url: 'https://otari.example/api/v1',
      searchStatus: 'available' as const,
    }
    await createModel(getDb(), {
      id: connection.modelId,
      name: 'Deepseek v4.1 Flash',
      model: 'deepseek/deepseek-v4.1-flash',
      provider: 'otari',
      url: connection.url,
      apiKey: 'delegated-key',
      providerDefault: 1,
      enabled: 1,
    })
    await createModel(getDb(), {
      id: 'unrelated',
      name: 'Unrelated',
      model: 'other',
      provider: 'custom',
      url: connection.url,
      apiKey: 'other-key',
      enabled: 1,
    })
    await createModel(getDb(), {
      id: 'manual-otari',
      name: 'Manual Otari',
      model: 'other',
      provider: 'otari',
      url: connection.url,
      apiKey: 'manual-key',
      enabled: 1,
    })
    useSearchProviderStore.getState().configureOtariSearch(connection)
    const { triggerChange } = renderWithReactivity(<ConnectionsPage />, {
      tables: ['models', 'models_secrets'],
      wrapper: McpProviderWrapper,
    })
    const disable = await waitForElement(() => screen.queryByRole('switch', { name: 'Disable Otari' }))
    await act(async () => {
      fireEvent.click(disable)
      await getClock().runAllAsync()
      triggerChange(['models'])
    })
    expect((await getOtariSearchAvailability(getDb())).otari).toBe(false)
    expect(await getModel(getDb(), 'manual-otari')).toMatchObject({ apiKey: 'manual-key', enabled: 1 })
    const enable = await waitForElement(() => screen.queryByRole('switch', { name: 'Enable Otari' }))
    expect(enable).toBeEnabled()
    await act(async () => {
      fireEvent.click(enable)
      await getClock().runAllAsync()
      triggerChange(['models'])
    })
    expect((await getOtariSearchAvailability(getDb())).otari).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Open Otari' }))
    const disconnect = await waitForElement(() => screen.queryByRole('button', { name: 'Disconnect' }))
    const pendingAuthorization = await getProviderConnectionAttempt(getDb(), 'otari')
    await act(async () => {
      fireEvent.click(disconnect)
      await getClock().runAllAsync()
      triggerChange(['models', 'models_secrets'])
    })
    expect(await getModel(getDb(), connection.modelId)).toMatchObject({ apiKey: null, deletedAt: null })
    expect(await getModel(getDb(), 'unrelated')).toMatchObject({ apiKey: 'other-key', enabled: 1 })
    expect(await getModel(getDb(), 'manual-otari')).toMatchObject({ apiKey: 'manual-key', enabled: 1 })
    await expect(assertProviderConnectionAttemptCurrent(getDb(), pendingAuthorization)).rejects.toThrow(
      'Provider connection changed',
    )
    expect(await getOtariSearchAvailability(getDb())).toEqual({ otari: false, otariConfigured: true })
    await waitForElement(() => screen.queryByRole('button', { name: 'Connect Otari' }))
  })

  it('restores the Otari detail panel when browser Back returns from authorization', async () => {
    spyOn(otariBrowser, 'getOtariBrowserDraft').mockImplementation((context) =>
      context === 'connections' ? { id: 'draft', origin: 'http://localhost:8099' } : null,
    )
    renderWithReactivity(<ConnectionsPage />, { tables: ['models'], wrapper: McpProviderWrapper })
    await waitForElement(() => screen.queryByRole('button', { name: 'Connect Otari' }))
    expect(screen.getByLabelText('Otari server URL')).toHaveValue('http://localhost:8099')
  })

  it('keeps the account enabled when its models are individually disabled', async () => {
    await createModel(getDb(), {
      id: 'disabled-tinfoil-model',
      provider: 'tinfoil',
      name: 'Disabled model',
      model: 'model',
      enabled: 0,
      oauthProvider: 'tinfoil',
    })
    await saveIntegrationCredentials(getDb(), 'tinfoil', { access_token: 'test-token' }, true)
    renderWithReactivity(<ConnectionsPage />, { tables: ['models'], wrapper: McpProviderWrapper })
    const toggle = await waitForElement(() => screen.queryByRole('switch', { name: 'Disable Tinfoil' }))
    expect(toggle).toBeChecked()
    expect(toggle).not.toBeDisabled()
  })

  it('offers reconnect when token refresh expires the mounted Tinfoil connection', async () => {
    await saveIntegrationCredentials(
      getDb(),
      'tinfoil',
      { access_token: 'expired-token', refresh_token: 'expired-refresh', expires_at: 1 },
      true,
    )
    const { triggerChange } = renderWithReactivity(<ConnectionsPage />, {
      tables: ['models', 'integrations_secrets'],
      wrapper: McpProviderWrapper,
    })
    fireEvent.click(await waitForElement(() => screen.queryByRole('button', { name: 'Open Tinfoil' })))
    expect(await waitForElement(() => screen.queryByText('Connected'))).toBeTruthy()
    spyOn(tinfoilAuth, 'refresh').mockRejectedValue(new TinfoilReauthorizationError())
    const session = createTinfoilSession({ db: getDb, auth: tinfoilAuth, lock: async (work) => work(), now: Date.now })
    await act(async () => {
      await expect(session.getAccessToken()).rejects.toBeInstanceOf(TinfoilReauthorizationError)
      triggerChange(['integrations_secrets'])
    })
    expect(await waitForElement(() => screen.queryByRole('button', { name: 'Reconnect Tinfoil' }))).toBeTruthy()
  })

  it('updates the mounted detail when another window disconnects Tinfoil', async () => {
    await saveIntegrationCredentials(getDb(), 'tinfoil', { access_token: 'test-token' }, true)
    const { triggerChange } = renderWithReactivity(<ConnectionsPage />, {
      tables: ['models', 'integrations_secrets'],
      wrapper: McpProviderWrapper,
    })
    fireEvent.click(await waitForElement(() => screen.queryByRole('button', { name: 'Open Tinfoil' })))
    expect(await waitForElement(() => screen.queryByText('Connected'))).toBeTruthy()
    await act(async () => {
      await saveIntegrationCredentials(getDb(), 'tinfoil', { access_token: '' }, false)
      triggerChange(['integrations_secrets'])
    })
    expect(await waitForElement(() => screen.queryByRole('button', { name: 'Connect Tinfoil' }))).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Enable Tinfoil' })).toBeDisabled()
    expect(screen.queryByText('Connected')).not.toBeInTheDocument()
  })

  it.each(['openrouter', 'tinfoil'] as const)(
    'toggles %s models without removing credentials or unrelated models',
    async (provider) => {
      const id = uuidv7()
      const otherId = uuidv7()
      const providerName = provider === 'tinfoil' ? 'Tinfoil' : 'OpenRouter'
      await createModel(getDb(), {
        id,
        name: 'Connected model',
        provider,
        model: 'test-model',
        enabled: 1,
        ...(provider === 'tinfoil'
          ? { oauthProvider: 'tinfoil' as const }
          : { apiKey: 'test-key', providerDefault: 1 }),
      })
      await createModel(getDb(), {
        id: otherId,
        name: 'Unrelated model',
        provider,
        model: 'byok-model',
        apiKey: 'byok-key',
        enabled: 1,
      })
      await saveIntegrationCredentials(
        getDb(),
        'tinfoil',
        { access_token: 'test-token', refresh_token: 'test-refresh' },
        true,
      )
      const { triggerChange } = renderWithReactivity(<ConnectionsPage />, {
        tables: ['models', 'models_secrets'],
        wrapper: McpProviderWrapper,
      })
      const pendingAttempt = await getProviderConnectionAttempt(getDb(), provider)
      const toggle = await waitForElement(() => screen.queryByRole('switch', { name: `Disable ${providerName}` }))
      await act(async () => {
        fireEvent.click(toggle)
        await getClock().runAllAsync()
      })
      if (provider === 'tinfoil') {
        expect((await getModel(getDb(), id))?.enabled).toBe(1)
        expect(screen.getByRole('alertdialog')).toHaveTextContent('models and Exa search')
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
        expect((await getModel(getDb(), id))?.enabled).toBe(1)
        fireEvent.click(screen.getByRole('switch', { name: 'Disable Tinfoil' }))
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Disable Tinfoil' }))
          await getClock().runAllAsync()
        })
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
        expect((await getIntegrationCredentials(getDb(), 'tinfoil'))?.enabled).toBe(false)
      }
      await expect(assertProviderConnectionAttemptCurrent(getDb(), pendingAttempt)).rejects.toThrow(
        'connection changed',
      )
      const disabledAttempt = await getProviderConnectionAttempt(getDb(), provider)
      expect((await getModel(getDb(), id))?.enabled).toBe(provider === 'tinfoil' ? 1 : 0)
      expect((await getAvailableModels(getDb())).some((model) => model.id === id)).toBe(false)
      expect((await getModel(getDb(), otherId))?.enabled).toBe(1)
      triggerChange(['models'])
      const enable = await waitForElement(() => screen.queryByRole('switch', { name: `Enable ${providerName}` }))
      expect(enable).not.toBeDisabled()
      await act(async () => {
        fireEvent.click(enable)
        await getClock().runAllAsync()
      })
      await expect(assertProviderConnectionAttemptCurrent(getDb(), disabledAttempt)).rejects.toThrow(
        'connection changed',
      )
      await expect(assertProviderConnectionAttemptCurrent(getDb(), pendingAttempt)).rejects.toThrow(
        'connection changed',
      )
      const model = await getModel(getDb(), id)
      expect(model?.enabled).toBe(1)
      expect(model?.deletedAt).toBeNull()
      if (provider === 'openrouter') {
        expect(model?.apiKey).toBe('test-key')
      } else {
        expect(model?.oauthProvider).toBe('tinfoil')
        expect((await getIntegrationCredentials(getDb(), 'tinfoil'))?.enabled).toBe(true)
        expect((await getIntegrationCredentials(getDb(), 'tinfoil'))?.credentials).toEqual({
          access_token: 'test-token',
          refresh_token: 'test-refresh',
          sessionRevision: expect.any(String),
        })
      }
    },
  )

  it.each(['none', 'valid', 'expired'])(
    'controls connection-owned Tinfoil API keys with OAuth state: %s',
    async (oauthState) => {
      const oauthConnected = oauthState !== 'none'
      const db = getDb()
      await createModel(db, {
        id: 'connection-key',
        provider: 'tinfoil',
        name: 'Connection key',
        model: 'model',
        apiKey: 'connection-key',
        providerDefault: 1,
      })
      await createModel(db, {
        id: 'manual-key',
        provider: 'tinfoil',
        name: 'Manual key',
        model: 'model',
        apiKey: 'manual-key',
      })
      if (oauthConnected) {
        await saveIntegrationCredentials(
          db,
          'tinfoil',
          { access_token: 'oauth-token', reauth_required: oauthState === 'expired' },
          true,
        )
      }
      const session = createTinfoilSession({
        db: getDb,
        auth: { ...tinfoilAuth, revoke: async () => {} },
        lock: async (work) => work(),
        now: Date.now,
      })
      spyOn(tinfoilSession, 'disconnect').mockImplementation(session.disconnect)
      const { triggerChange } = renderWithReactivity(<ConnectionsPage />, {
        tables: ['models', 'models_secrets', 'integrations_secrets'],
        wrapper: McpProviderWrapper,
      })
      const toggle = await waitForElement(() => screen.queryByRole('switch', { name: 'Disable Tinfoil' }))
      expect(toggle).not.toBeDisabled()
      fireEvent.click(toggle)
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Disable Tinfoil' }))
        await getClock().runAllAsync()
        triggerChange(['models', 'integrations_secrets'])
      })
      expect(await getModel(db, 'connection-key')).toMatchObject({ enabled: 0, apiKey: 'connection-key' })
      expect(await getModel(db, 'manual-key')).toMatchObject({ enabled: 1, apiKey: 'manual-key' })
      const enable = await waitForElement(() => screen.queryByRole('switch', { name: 'Enable Tinfoil' }))
      await act(async () => {
        fireEvent.click(enable)
        await getClock().runAllAsync()
        triggerChange(['models', 'integrations_secrets'])
      })
      expect(await getModel(db, 'connection-key')).toMatchObject({ enabled: 1, apiKey: 'connection-key' })
      fireEvent.click(screen.getByRole('button', { name: 'Open Tinfoil' }))
      await waitForElement(() => screen.queryByRole('button', { name: 'Disconnect' }))
      expect(Boolean(screen.queryByRole('button', { name: 'Manage subscription' }))).toBe(oauthConnected)
      expect(Boolean(screen.queryByRole('button', { name: 'Reconnect Tinfoil' }))).toBe(oauthState === 'expired')
      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Disconnect Tinfoil' }))
        await getClock().runAllAsync()
        triggerChange(['models_secrets', 'integrations_secrets'])
      })
      expect(await getModel(db, 'connection-key')).toMatchObject({ enabled: 1, apiKey: null })
      expect(await getModel(db, 'manual-key')).toMatchObject({ enabled: 1, apiKey: 'manual-key' })
      expect((await getIntegrationCredentials(db, 'tinfoil'))?.credentials.access_token).toBe('')
      expect(
        await waitForElement(() => {
          const toggle = screen.queryByRole('switch', { name: 'Enable Tinfoil' })
          return toggle?.hasAttribute('disabled') ? toggle : null
        }),
      ).toBeDisabled()
    },
  )

  it('offers API-key setup alongside sign-in on desktop', async () => {
    renderWithReactivity(<ConnectionsPage />, { tables: ['models'], wrapper: McpProviderWrapper })
    fireEvent.click(await waitForElement(() => screen.queryByRole('button', { name: 'Open Tinfoil' })))
    fireEvent.click(await waitForElement(() => screen.queryByRole('button', { name: 'Use an API key instead' })))
    expect(screen.getByLabelText('API Key')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Use sign-in instead' }))
    expect(screen.getByRole('button', { name: 'Connect Tinfoil' })).toBeTruthy()
  })

  it('offers Tinfoil sign-in on native mobile', async () => {
    spyOn(platform, 'isTauri').mockReturnValue(true)
    spyOn(platform, 'isMobile').mockReturnValue(true)
    renderWithReactivity(<ConnectionsPage />, { tables: ['models'], wrapper: McpProviderWrapper })
    fireEvent.click(await waitForElement(() => screen.queryByRole('button', { name: 'Open Tinfoil' })))
    expect(await waitForElement(() => screen.queryByRole('button', { name: 'Connect Tinfoil' }))).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Use an API key instead' }))
    expect(screen.getByLabelText('API Key')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Use sign-in instead' }))
    expect(screen.getByRole('button', { name: 'Connect Tinfoil' })).toBeEnabled()
  })

  it('keeps healthy Tinfoil subscription controls in its provider detail without a reconnect action', async () => {
    await saveIntegrationCredentials(
      getDb(),
      'tinfoil',
      { access_token: 'test-token', expires_at: Date.now() + 3600000 },
      true,
    )
    renderWithReactivity(<ConnectionsPage />, { tables: ['models'], wrapper: McpProviderWrapper })
    await waitForElement(() => screen.queryByRole('button', { name: 'Open Tinfoil' }))
    expect(screen.queryByText('AI providers')).not.toBeInTheDocument()
    expect(screen.queryByText('Connected')).not.toBeInTheDocument()
    expect(screen.queryByText('Not connected')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Manage subscription' })).not.toBeInTheDocument()
    fireEvent.click(await waitForElement(() => screen.queryByRole('button', { name: 'Open Tinfoil' })))
    await waitForElement(() => screen.queryByRole('button', { name: 'Manage subscription' }))
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reconnect Tinfoil' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Connect Tinfoil' })).not.toBeInTheDocument()
  })

  it('confirms Tinfoil disconnect, preserves the connection on cancel, and keeps errors retryable', async () => {
    await saveIntegrationCredentials(getDb(), 'tinfoil', { access_token: 'test-token' }, true)
    const disconnect = spyOn(tinfoilSession, 'disconnect').mockRejectedValue(new Error('Revocation failed'))
    try {
      renderWithReactivity(<ConnectionsPage />, { tables: ['models'], wrapper: McpProviderWrapper })
      fireEvent.click(await waitForElement(() => screen.queryByRole('button', { name: 'Open Tinfoil' })))
      fireEvent.click(await waitForElement(() => screen.queryByRole('button', { name: 'Disconnect' })))
      expect(screen.getByRole('alertdialog')).toHaveTextContent('models and Exa search')
      expect(disconnect).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(disconnect).not.toHaveBeenCalled()
      expect((await getIntegrationCredentials(getDb(), 'tinfoil'))?.credentials.access_token).toBe('test-token')
      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Disconnect Tinfoil' }))
        await getClock().runAllAsync()
      })
      expect(disconnect).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('alertdialog')).toHaveTextContent('Could not disconnect this provider. Please try again.')
      disconnect.mockResolvedValue(undefined)
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Disconnect Tinfoil' }))
        await getClock().runAllAsync()
      })
      expect(disconnect).toHaveBeenCalledTimes(2)
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    } finally {
      disconnect.mockRestore()
    }
  })

  it('offers reconnect for a Tinfoil session that requires reauthorization', async () => {
    await saveIntegrationCredentials(getDb(), 'tinfoil', { access_token: 'test-token', reauth_required: true }, true)
    renderWithReactivity(<ConnectionsPage />, { tables: ['models'], wrapper: McpProviderWrapper })
    fireEvent.click(await waitForElement(() => screen.queryByRole('button', { name: 'Open Tinfoil' })))
    await waitForElement(() => screen.queryByRole('button', { name: 'Reconnect Tinfoil' }))
    expect(screen.getByRole('button', { name: 'Manage subscription' })).toBeInTheDocument()
  })

  it('disconnects OpenRouter credentials even when its model is disabled, preserving the model', async () => {
    const id = uuidv7()
    await createModel(getDb(), {
      id,
      name: 'My OpenRouter model',
      providerDefault: 1,
      model: 'test-model',
      provider: 'openrouter',
      apiKey: 'test-key',
      enabled: 0,
    })
    for (const enabled of [0, 1]) {
      await createModel(getDb(), {
        id: `manual-${enabled}`,
        name: 'Manual OpenRouter model',
        provider: 'openrouter',
        model: 'test-model',
        apiKey: `manual-key-${enabled}`,
        enabled,
      })
    }
    const { triggerChange } = renderWithReactivity(<ConnectionsPage />, {
      tables: ['models', 'models_secrets'],
      wrapper: McpProviderWrapper,
    })
    fireEvent.click(await waitForElement(() => screen.queryByRole('button', { name: 'Open OpenRouter' })))
    const disconnect = await waitForElement(() => screen.queryByRole('button', { name: 'Disconnect' }))
    await act(async () => {
      fireEvent.click(disconnect)
      await getClock().runAllAsync()
    })
    const model = await getModel(getDb(), id)
    expect(model?.apiKey).toBeNull()
    expect(model?.deletedAt).toBeNull()
    expect(model?.enabled).toBe(0)
    for (const enabled of [0, 1]) {
      expect(await getModel(getDb(), `manual-${enabled}`)).toMatchObject({
        apiKey: `manual-key-${enabled}`,
        enabled,
        deletedAt: null,
      })
    }
    triggerChange(['models', 'models_secrets'])
    expect(await waitForElement(() => screen.queryByRole('button', { name: 'Connect OpenRouter' }))).toBeTruthy()
  })

  it('shows the pre-baked integrations and updates when mcp_servers changes', async () => {
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

    // Pre-baked integrations render at the top (Thunderbolt renamed from
    // "Thunderbolt Pro").
    await waitForElement(() => screen.queryByText('Thunderbolt'))
    expect(screen.getByText('Google')).toBeInTheDocument()
    expect(screen.getByText('Microsoft')).toBeInTheDocument()
    expect(screen.queryByText('Thunderbolt Pro')).not.toBeInTheDocument()

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
    expect(await getMcpServerCredentials(db, id)).toEqual({ type: 'bearer', token: 'original-token' })
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
    // Close the form before the 700ms debounce fires.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
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
