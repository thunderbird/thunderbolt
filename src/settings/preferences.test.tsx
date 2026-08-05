/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { type ReactNode } from 'react'

// Per docs/development/testing.md: do NOT mock shared modules. All app-internal hooks
// (useSettings, useCountryUnits, useUnitsOptions, useSyncEnabledToggle, etc.) use their
// real implementations and run against the test DB / mock HTTP client provided by
// createTestProvider. `posthog-js` is already globally mocked by src/testing-library.ts.

import { SignInModalProvider } from '@/contexts'
import type { AuthClient } from '@/contexts'
import PreferencesSettingsPage from './preferences'

const anonSession = {
  user: { id: 'anon-1', email: '', name: '', isAnonymous: true },
}

const authedSession = {
  user: { id: 'user-1', email: 'a@b.com', name: 'Alice', isAnonymous: false },
}

const renderPage = (authClient: AuthClient) => {
  const TestProvider = createTestProvider({ authClient })
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <TestProvider>
      <SignInModalProvider>{children}</SignInModalProvider>
    </TestProvider>
  )
  return render(<PreferencesSettingsPage />, { wrapper: Wrapper })
}

describe('PreferencesSettingsPage — sync toggle gating', () => {
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

  it('shows Sign In button and no sync toggle for anonymous users', () => {
    const authClient = createMockAuthClient({ session: anonSession })
    renderPage(authClient)

    expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: /sync this device/i })).not.toBeInTheDocument()
  })

  it('shows sync toggle and no Sign In button for authenticated (non-anonymous) users', () => {
    const authClient = createMockAuthClient({ session: authedSession })
    renderPage(authClient)

    expect(screen.queryByRole('button', { name: 'Sign In' })).toBeNull()
    expect(screen.getByText('Sync This Device With Cloud')).toBeInTheDocument()
  })

  it('shows the cloud proxy setting in Network immediately above Data', () => {
    const authClient = createMockAuthClient({ session: authedSession })
    renderPage(authClient)

    const sectionTitles = screen.getAllByRole('heading').map((heading) => heading.textContent)
    const networkIndex = sectionTitles.indexOf('Network')

    expect(screen.getByRole('switch', { name: 'Use Cloud Proxy' })).toBeInTheDocument()
    expect(sectionTitles[networkIndex + 1]).toBe('Data')
  })

  it('shows Delete All Local Data for anonymous users (R-23)', () => {
    const authClient = createMockAuthClient({ session: anonSession })
    renderPage(authClient)

    expect(screen.getByText('Delete All Local Data')).toBeInTheDocument()
  })

  it('hides Delete My Account for anonymous users (no real account exists to delete)', () => {
    const authClient = createMockAuthClient({ session: anonSession })
    renderPage(authClient)

    expect(screen.queryByText('Delete My Account')).toBeNull()
  })

  it('shows Delete My Account for authenticated (non-anonymous) users', () => {
    const authClient = createMockAuthClient({ session: authedSession })
    renderPage(authClient)

    expect(screen.getByText('Delete My Account')).toBeInTheDocument()
  })
})
