/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { createModel, updateModel } from '@/dal/models'
import { saveIntegrationCredentials } from '@/dal/integrations'
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
  useSearchProviderStore.getState().clearSearchProvider()
})

it.each([true, false])(
  'shows Tinfoil selection and disables search independently of models (local mode: %s)',
  async (localMode) => {
    useLocalSettingsStore.setState({ cloudUrl: localMode ? '' : 'https://server.example/v1', localMode })
    await createModel(getDb(), {
      id: 'tf',
      name: 'Tinfoil',
      provider: 'tinfoil',
      model: 'test',
      apiKey: 'key',
      enabled: 1,
      toolUsage: 1,
    })
    renderWithReactivity(<SearchSettingsPage />, { route: '/settings/search', tables: ['models', 'settings'] })
    const toggle = await waitForElement(() => screen.queryByRole('switch', { name: 'Disable Tinfoil' }))
    expect(toggle).toBeTruthy()
    expect(screen.getByText('Exa search through Tinfoil')).toBeTruthy()
    expect(screen.queryByText('Exa search through your Tinfoil subscription')).toBeNull()
    expect(screen.getByText('Private')).toBeTruthy()
    expect(screen.queryByText('Selected')).toBeNull()
    fireEvent.click(toggle)
    expect(useSearchProviderStore.getState().selection).toBe('none')
    expect(screen.queryByText('Selected')).toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: 'Use Tinfoil' }))
    expect(useSearchProviderStore.getState().selection).toBe('tinfoil')
  },
)

it('switches to Tinfoil without losing a configured search key', async () => {
  await createModel(getDb(), {
    id: 'oauth',
    name: 'Tinfoil',
    provider: 'tinfoil',
    model: 'test',
    oauthProvider: 'tinfoil',
    enabled: 1,
    toolUsage: 1,
  })
  await saveIntegrationCredentials(getDb(), 'tinfoil', { access_token: 'token' }, true)
  useSearchProviderStore.getState().configureSearchProvider('saved-exa', 'exa')
  renderWithReactivity(<SearchSettingsPage />, { route: '/settings/search', tables: ['models', 'settings'] })
  await waitForElement(() => {
    const toggle = screen.queryByRole('switch', { name: 'Use Tinfoil' })
    return toggle && !toggle.hasAttribute('disabled') ? toggle : null
  })
  const toggle = screen.getByRole('switch', { name: 'Use Tinfoil' })
  expect(screen.getByRole('switch', { name: 'Disable Exa' })).toBeTruthy()
  fireEvent.click(toggle)
  expect(useSearchProviderStore.getState()).toMatchObject({
    selection: 'tinfoil',
    apiKey: 'saved-exa',
    provider: 'exa',
  })
  expect(screen.getByRole('switch', { name: 'Use Exa' })).toBeTruthy()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Open Tinfoil' }))
  })
  expect(
    screen.getByText(
      'Exa provides search and page content through Tinfoil’s encrypted connection and privacy filters. No separate Exa API key is needed.',
    ),
  ).toBeTruthy()
})

it('lists all providers and opens the chosen provider without reusing another provider’s key', async () => {
  useSearchProviderStore.getState().configureSearchProvider('private-exa-key', 'exa')
  renderWithReactivity(<SearchSettingsPage />, { route: '/settings/search', tables: ['models', 'settings'] })
  for (const name of ['Tinfoil', 'Exa', 'Brave', 'Tavily']) {
    expect(screen.getByRole('button', { name: `Open ${name}` })).toBeTruthy()
  }
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Open Brave' }))
  })
  expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('')
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull()
  expect(useSearchProviderStore.getState().apiKey).toBe('private-exa-key')
})

it('keeps Tinfoil visible but removes selected status when its connection is disabled', async () => {
  await createModel(getDb(), {
    id: 'tf',
    name: 'Tinfoil',
    provider: 'tinfoil',
    model: 'test',
    apiKey: 'key',
    enabled: 1,
    toolUsage: 1,
  })
  useSearchProviderStore.getState().selectSearchProvider('tinfoil')
  const { triggerChange } = renderWithReactivity(<SearchSettingsPage />, {
    route: '/settings/search',
    tables: ['models', 'settings'],
  })
  await waitForElement(() => screen.queryByRole('switch', { name: 'Disable Tinfoil' }))
  await act(async () => {
    await updateModel(getDb(), 'tf', { enabled: 0 })
    triggerChange(['models'])
  })
  await waitForElement(() => screen.queryByRole('switch', { name: 'Use Tinfoil' }))
  expect(screen.getByRole('button', { name: 'Open Tinfoil' })).toBeTruthy()
  expect(screen.getByText('Private')).toBeTruthy()
  expect(screen.getByRole('switch', { name: 'Use Tinfoil' }).getAttribute('aria-checked')).toBe('false')
  expect(useSearchProviderStore.getState().selection).toBe('tinfoil')
})
