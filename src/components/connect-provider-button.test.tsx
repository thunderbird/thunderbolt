/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { MemoryRouter } from 'react-router'
import { SignInModalProvider } from '@/contexts'
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
it.each(['google', 'microsoft'] as const)('asks for server sign-in before connecting %s', async (provider) => {
  const connect = mock(async () => {})
  const Provider = createTestProvider()
  render(
    <MemoryRouter>
      <Provider>
        <SignInModalProvider>
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
        </SignInModalProvider>
      </Provider>
    </MemoryRouter>,
  )
  await act(async () =>
    fireEvent.click(
      screen.getByRole('button', { name: provider === 'google' ? 'Connect Google' : 'Connect Microsoft' }),
    ),
  )
  expect(connect).not.toHaveBeenCalled()
  expect(screen.getByText('Connect your account')).toBeTruthy()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign In' })))
  expect(screen.getByText('Sign in to Thunderbolt')).toBeTruthy()
  expect(connect).not.toHaveBeenCalled()
})
