/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { MemoryRouter } from 'react-router'
import { createTestProvider } from '@/test-utils/test-provider'
import { resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { clearAuthToken } from '@/lib/auth-token'
import { clearCachedSession } from '@/lib/session-cache'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { ConnectProviderButton } from './connect-provider-button'

beforeEach(async () => {
  await resetTestDatabase()
  clearAuthToken()
  clearCachedSession()
  useLocalSettingsStore.setState({ cloudUrl: 'https://server.example/v1', localMode: false })
})
afterEach(() => {
  cleanup()
  clearAuthToken()
  clearCachedSession()
  useLocalSettingsStore.setState({ cloudUrl: '', localMode: true })
})
afterAll(teardownTestDatabase)
it.each([
  { provider: 'google', cloudUrl: '' },
  { provider: 'microsoft', cloudUrl: '' },
  { provider: 'google', cloudUrl: 'https://server.example/v1' },
  { provider: 'microsoft', cloudUrl: 'https://server.example/v1' },
] as const)('connects $provider without a Thunderbolt session (server: $cloudUrl)', async ({ provider, cloudUrl }) => {
  useLocalSettingsStore.setState({ cloudUrl, localMode: true })
  const connect = mock(async () => {})
  const Provider = createTestProvider()
  render(
    <MemoryRouter>
      <Provider>
        <ConnectProviderButton
          provider={provider}
          useOAuthConnectHook={() => ({
            connect,
            isConnecting: false,
            error: null,
            clearError: () => {},
            processCallback: async () => true,
          })}
        />
      </Provider>
    </MemoryRouter>,
  )
  await act(async () =>
    fireEvent.click(
      screen.getByRole('button', { name: provider === 'google' ? 'Connect Google' : 'Connect Microsoft' }),
    ),
  )
  expect(connect).toHaveBeenCalledWith(provider)
  expect(screen.queryByText('Connect your account')).toBeNull()
  expect(screen.queryByText('Sign in to Thunderbolt')).toBeNull()
})
