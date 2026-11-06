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
import * as platform from '@/lib/platform'
import { getClock } from '@/testing-library'

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
beforeEach(async () => {
  await resetTestDatabase()
  useLocalSettingsStore.setState({ cloudUrl: '', localMode: true })
  useSearchProviderStore.getState().clearSearchProvider()
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
const save = (provider: 'tinfoil' | 'otari' | 'exa', name: string) =>
  saveProviderConnection(getDb(), {
    provider,
    name,
    authMethod: 'api_key',
    url: provider === 'otari' ? 'https://otari.example/api/v1' : null,
    credentials: { apiKey: `secret-${name}` },
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
  expect(screen.getByRole('link', { name: 'Manage connection' })).toHaveAttribute('href', '/settings/connections')
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
    expect(screen.getByRole('link', { name: 'Manage connection' })).toBeTruthy()
  },
)
it('offers adding a connection when none exists', () => {
  renderPage()
  fireEvent.click(screen.getByRole('button', { name: 'New Search Connection' }))
  expect(screen.getByRole('link', { name: 'Manage all connections' })).toHaveAttribute('href', '/settings/connections')
  fireEvent.click(screen.getByRole('button', { name: 'Exa Search' }))
  expect(screen.getByRole('button', { name: 'Connect Exa' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Use API Key instead' }))
  expect(screen.getByLabelText('API key')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'OpenAI Models' })).toBeNull()
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
    expect(screen.getByRole('link', { name: 'Manage connection' })).toBeTruthy()
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
