/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { setAuthToken, clearAuthToken } from '@/lib/auth-token'
import { updateSettings } from '@/dal'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'bun:test'
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

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
beforeEach(async () => {
  await resetTestDatabase()
  useLocalSettingsStore.setState({ cloudUrl: '', localMode: true })
  useSearchProviderStore.getState().clearSearchProvider()
})
afterEach(() => {
  cleanup()
  clearAuthToken()
  useSearchProviderStore.getState().clearSearchProvider()
})
const renderPage = () =>
  renderWithReactivity(<SearchSettingsPage />, {
    route: '/settings/search',
    tables: ['provider_connections', 'provider_connection_secrets', 'settings'],
  })
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
  expect(screen.getByRole('link', { name: 'Add a connection' })).toHaveAttribute('href', '/settings/connections')
  expect(screen.queryByLabelText('API key')).toBeNull()
})
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
