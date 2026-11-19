/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { CreateItemProvider, useCreateItem } from '@/components/create-item/context'
import { setAuthToken, clearAuthToken } from '@/lib/auth-token'
import { updateSettings } from '@/dal'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import {
  saveProviderConnection,
  getProviderCredentials,
  updateProviderConnection,
  disconnectProviderConnection,
} from '@/dal/provider-connections'
import { setupTestDatabase, resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import SearchSettingsPage from './index'
import * as otariBrowser from '@/lib/otari-browser-auth'
import * as otariAuth from '@/lib/otari-auth'
import * as platform from '@/lib/platform'
import { getClock } from '@/testing-library'
import * as otariCapabilities from '@/integrations/otari-search/capabilities'

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
beforeEach(async () => {
  await resetTestDatabase()
  spyOn(otariAuth, 'revokeOtariToken').mockResolvedValue()
  await updateSettings(getDb(), { experimental_feature_otari: true })
  useLocalSettingsStore.setState({ cloudUrl: '', localMode: true })
  useSearchProviderStore.getState().clearSearchProvider()
  spyOn(otariCapabilities, 'loadOtariWebCapabilities').mockResolvedValue({
    search: 'available',
    fetch: 'available',
  })
})
afterEach(() => {
  cleanup()
  mock.restore()
  clearAuthToken()
  useSearchProviderStore.getState().clearSearchProvider()
})
const renderPage = () =>
  renderWithReactivity(
    <CreateItemProvider>
      <SearchSettingsPage />
    </CreateItemProvider>,
    {
      route: '/settings/search',
      tables: ['provider_connections', 'provider_connection_secrets', 'settings'],
    },
  )
/** Reveal the management link in the shared detail header menu. */
const openManageMenu = async () => {
  await act(async () => {
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), { button: 0 })
  })
  return waitForElement(() => screen.queryByRole('menuitem', { name: 'Manage connection' }))
}

const save = (provider: 'tinfoil' | 'otari' | 'exa', name: string) =>
  saveProviderConnection(getDb(), {
    provider,
    name,
    authMethod: 'api_key',
    url: provider === 'otari' ? 'https://otari.example/api/v1' : null,
    credentials: { apiKey: `secret-${name}` },
  })

it.each(['not_configured', 'workspace_disabled', 'unknown'] as const)(
  'omits Otari search when live discovery reports %s, even with an old available status',
  async (status) => {
    const id = await save('otari', 'Otari without search')
    useSearchProviderStore.getState().configureProviderSearch(id, 'available')
    spyOn(otariCapabilities, 'loadOtariWebCapabilities').mockResolvedValue({ search: status, fetch: 'available' })
    await save('exa', 'Working search')
    renderPage()
    await waitForElement(() => screen.queryByRole('switch', { name: 'Use Working search' }))
    await act(async () => {
      await getClock().tickAsync(100)
    })
    expect(screen.queryByRole('button', { name: 'Open Otari without search' })).toBeNull()
    expect(useSearchProviderStore.getState().connectionId).toBe(id)
  },
)

it('checks each Otari instance separately and discovers search enabled later without reconnecting', async () => {
  await save('otari', 'No search')
  const available = await save('otari', 'Search enabled')
  const discover = spyOn(otariCapabilities, 'loadOtariWebCapabilities').mockImplementation(async (_url, key) => ({
    search: key === 'secret-Search enabled' ? 'available' : 'not_configured',
    fetch: 'available',
  }))
  const view = renderPage()
  await waitForElement(() => screen.queryByRole('switch', { name: 'Use Search enabled' }))
  expect(screen.queryByRole('button', { name: 'Open No search' })).toBeNull()
  fireEvent.click(screen.getByRole('switch', { name: 'Use Search enabled' }))
  expect(useSearchProviderStore.getState().connectionId).toBe(available)
  view.unmount()
  discover.mockResolvedValue({ search: 'available', fetch: 'available' })
  renderPage()
  expect(await waitForElement(() => screen.queryByRole('switch', { name: 'Use No search' }))).toBeVisible()
})

it('lists named connections without models or inline credential fields and preserves each credential when switching', async () => {
  const work = await save('exa', 'Work search')
  const personal = await save('exa', 'Personal search')
  useSearchProviderStore.getState().selectSearchConnection(work)
  renderPage()
  await waitForElement(() => screen.queryByRole('switch', { name: 'Disable Work search' }))
  fireEvent.click(screen.getByRole('switch', { name: 'Use Personal search' }))
  expect(useSearchProviderStore.getState().connectionId).toBe(personal)
  expect((await getProviderCredentials(getDb(), work))?.apiKey).toBe('secret-Work search')
  expect((await getProviderCredentials(getDb(), personal))?.apiKey).toBe('secret-Personal search')
  fireEvent.click(screen.getByRole('button', { name: 'Open Work search' }))
  expect(screen.queryByLabelText('API key')).toBeNull()
  expect(await openManageMenu()).toHaveAttribute('href', '/settings/connections')
})

it('shows the shared OAuth connection summary and keeps management in the header menu', async () => {
  const id = await saveProviderConnection(getDb(), {
    provider: 'otari',
    name: 'Team search',
    authMethod: 'oauth',
    url: 'https://otari.example/api/v1',
    credentials: { access_token: 'test-token' },
  })
  const { triggerChange } = renderPage()
  fireEvent.click(await waitForElement(() => screen.queryByRole('button', { name: 'Open Team search' })))
  expect(screen.getByRole('status')).toHaveTextContent('Connected to Otari')
  expect(screen.getByRole('status')).toHaveTextContent('https://otari.example/api/v1')
  expect(screen.queryByRole('button', { name: 'Manage connection' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Manage connection' })).toBeNull()
  expect(await openManageMenu()).toHaveAttribute('href', '/settings/connections')
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  await act(async () => {
    await disconnectProviderConnection(getDb(), id)
    triggerChange(['provider_connections', 'provider_connection_secrets'])
  })
  expect(
    await waitForElement(() => screen.queryByText('Connect or enable this connection to use search')),
  ).toBeVisible()
  expect(screen.queryByText('Connected to Otari')).toBeNull()
})
it.each(['tinfoil', 'otari'] as const)('selects and disables %s search independently of models', async (provider) => {
  const id = await save(provider, 'My provider')
  useSearchProviderStore.getState().configureProviderSearch(id, 'available')
  renderPage()
  const toggle = await waitForElement(() => screen.queryByRole('switch', { name: 'Disable My provider' }))
  expect(screen.queryByText('Private') !== null).toBe(provider === 'tinfoil')
  fireEvent.click(toggle)
  expect(useSearchProviderStore.getState().selection).toBe('none')
  expect((await getProviderCredentials(getDb(), id))?.apiKey).toBeTruthy()
  fireEvent.click(screen.getByRole('switch', { name: 'Use My provider' }))
  expect(useSearchProviderStore.getState().connectionId).toBe(id)
})
it.each(['disabled', 'disconnected'] as const)(
  'retains selection intent but shows an unavailable connection after %s',
  async (change) => {
    const id = await save('tinfoil', 'Private search')
    useSearchProviderStore.getState().selectSearchConnection(id)
    const { triggerChange } = renderPage()
    await waitForElement(() => screen.queryByRole('switch', { name: 'Disable Private search' }))
    await act(async () => {
      if (change === 'disabled') {
        await updateProviderConnection(getDb(), id, { enabled: false })
      } else {
        await disconnectProviderConnection(getDb(), id)
      }
      triggerChange(['provider_connections', 'provider_connection_secrets'])
    })
    await waitForElement(() => screen.queryByRole('switch', { name: 'Use Private search' }))
    expect(useSearchProviderStore.getState().connectionId).toBe(id)
    fireEvent.click(screen.getByRole('switch', { name: 'Use Private search' }))
    expect(await openManageMenu()).toBeTruthy()
  },
)
it('offers adding a connection when none exists', async () => {
  renderPage()
  expect(await waitForElement(() => screen.queryByText('No search connections available'))).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Add connection' }))
  expect(screen.getByRole('link', { name: 'Manage all connections' })).toHaveAttribute('href', '/settings/connections')
  fireEvent.click(screen.getByRole('button', { name: 'Exa Search' }))
  expect(screen.getByRole('button', { name: 'Connect Exa' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Go back' }))
  expect(screen.getByRole('link', { name: 'Manage all connections' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Exa Search' }))
  fireEvent.click(screen.getByRole('button', { name: 'Use API Key instead' }))
  expect(screen.getByLabelText('API key')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'OpenAI Models' })).toBeNull()
})

it('continues an existing Otari connection to its search availability details', async () => {
  await saveProviderConnection(getDb(), {
    provider: 'otari',
    name: 'Inference only',
    authMethod: 'oauth',
    url: 'https://otari.example/api/v1',
    credentials: { access_token: 'test-token' },
  })
  spyOn(otariCapabilities, 'loadOtariWebCapabilities').mockResolvedValue({
    search: 'not_configured',
    fetch: 'available',
  })
  renderPage()
  await waitForElement(() => screen.queryByText('No search connections available'))
  fireEvent.click(screen.getByRole('button', { name: 'New Search Connection' }))
  fireEvent.click(screen.getByRole('button', { name: 'Otari Models and search' }))
  expect(screen.getByRole('status')).toHaveTextContent('Connected to Otari')
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  expect(
    await waitForElement(() =>
      screen.queryByText('Otari web search isn’t available. Configure a search provider in Otari to use it here.'),
    ),
  ).toBeVisible()
  expect(screen.getByRole('heading', { name: 'Inference only' })).toBeVisible()
})

it.each(['New Search Connection', 'Open Existing search', 'Edit', 'Remove'])(
  'cancels pending Otari authorization when navigating to %s',
  async (destination) => {
    await save('exa', 'Existing search')
    spyOn(platform, 'isTauri').mockReturnValue(false)
    const start = spyOn(otariBrowser, 'startOtariBrowserConnection').mockResolvedValue()
    renderPage()
    await waitForElement(() => screen.queryByRole('button', { name: 'Open Existing search' }))
    fireEvent.click(screen.getByRole('button', { name: 'New Search Connection' }))
    fireEvent.click(screen.getByRole('button', { name: 'Otari Models and search' }))
    fireEvent.click(screen.getByRole('button', { name: 'Connect Otari' }))
    await act(async () => getClock().runAllAsync())
    expect(start).toHaveBeenCalledTimes(1)
    const signal = start.mock.calls[0][2]
    expect(signal.aborted).toBe(false)
    if (destination === 'Edit' || destination === 'Remove') {
      fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Existing search' }))
      fireEvent.click(await waitForElement(() => screen.queryByRole('menuitem', { name: destination })))
    } else {
      fireEvent.click(screen.getByRole('button', { name: destination }))
    }
    expect(signal.aborted).toBe(true)
    expect(screen.queryByRole('button', { name: 'Cancel connection' })).not.toBeInTheDocument()
  },
)
it.each([true, false])('keeps Cloud visible while its integration is enabled: %s', async (enabled) => {
  useLocalSettingsStore.setState({ cloudUrl: 'https://server.example/v1', localMode: false })
  setAuthToken('session')
  await updateSettings(getDb(), { integrations_pro_is_enabled: enabled })
  renderPage()
  const toggle = await waitForElement(() => screen.queryByRole('switch', { name: 'Use Thunderbolt' }))
  expect(toggle.getAttribute('aria-checked')).toBe(String(enabled))
  if (!enabled) {
    fireEvent.click(toggle)
    expect(await openManageMenu()).toBeTruthy()
  }
})

it.each(['Edit', 'Remove'] as const)('%s opens the shared connection aside without leaving Search', async (action) => {
  const id = await save('exa', 'Work Exa')
  const RequestProbe = () => {
    const { request } = useCreateItem()
    return <p data-testid="connection-request">{JSON.stringify(request)}</p>
  }
  renderWithReactivity(
    <CreateItemProvider>
      <SearchSettingsPage />
      <RequestProbe />
    </CreateItemProvider>,
    {
      route: '/settings/search',
      tables: ['provider_connections', 'provider_connection_secrets'],
    },
  )
  fireEvent.contextMenu(await waitForElement(() => screen.queryByRole('button', { name: 'Open Work Exa' })))
  fireEvent.click(await waitForElement(() => screen.queryByRole('menuitem', { name: action })))
  expect(JSON.parse(screen.getByTestId('connection-request').textContent!)).toMatchObject({
    kind: 'connection',
    connectionId: id,
    action: action.toLowerCase(),
  })
  expect(screen.getByRole('heading', { name: 'Search' })).toBeVisible()
})

it('filters named connections and cloud search, and clears the filter', async () => {
  await save('exa', 'Research')
  await save('tinfoil', 'Private workspace')
  useLocalSettingsStore.setState({ cloudUrl: 'https://server.example/v1', localMode: false })
  setAuthToken('session')
  renderPage()
  await waitForElement(() => screen.queryByRole('button', { name: 'Open Research' }))
  fireEvent.click(screen.getByRole('button', { name: 'Search' }))
  const input = screen.getByPlaceholderText('Search connections')
  expect(input).toHaveFocus()
  for (const query of ['  RESEARCH  ', 'Exa']) {
    fireEvent.change(input, { target: { value: query } })
    await act(async () => {
      await getClock().tickAsync(100)
    })
    expect(screen.getByRole('button', { name: 'Open Research' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Open Private workspace' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open Thunderbolt' })).toBeNull()
  }
  fireEvent.change(input, { target: { value: 'Thunderbolt' } })
  await act(async () => {
    await getClock().tickAsync(100)
  })
  expect(screen.getByRole('button', { name: 'Open Thunderbolt' })).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Open Research' })).toBeNull()
  fireEvent.change(input, { target: { value: 'no match' } })
  await act(async () => {
    await getClock().tickAsync(100)
  })
  expect(screen.getByText('No matching connections.')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
  expect(screen.getByRole('button', { name: 'Open Research' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Open Private workspace' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Open Thunderbolt' })).toBeVisible()
})
