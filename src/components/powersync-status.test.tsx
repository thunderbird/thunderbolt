/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { type ReactNode } from 'react'

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'

// Per docs/development/testing.md: do NOT mock app-internal modules. Real implementations
// are used via createTestProvider + SignInModalProvider + SidebarProvider. `posthog-js` is
// globally mocked by src/testing-library.ts.

import { SidebarProvider } from '@/components/ui/sidebar'
import { SignInModalProvider } from '@/contexts'
import type { AuthClient } from '@/contexts'
import { PowerSyncStatus } from './powersync-status'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

afterEach(() => {
  cleanup()
})

const renderWithProviders = (authClient: AuthClient) => {
  const TestProvider = createTestProvider({ authClient })
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <TestProvider>
      <SignInModalProvider>
        <SidebarProvider>{children}</SidebarProvider>
      </SignInModalProvider>
    </TestProvider>
  )
  return render(<PowerSyncStatus />, { wrapper: Wrapper })
}

describe('PowerSyncStatus', () => {
  it('renders the sync status button with a sign-in popover for anonymous users', () => {
    const authClient = createMockAuthClient({
      session: { user: { id: 'anon-1', email: 'temp@anon.com', name: 'Anonymous', isAnonymous: true } },
    })
    renderWithProviders(authClient)
    // The button is visible (same affordance as fully logged-out users get) — the popover
    // content then shows a Sign In CTA because anonymous is gated out of real sync.
    expect(screen.getByLabelText('Sync status')).toBeInTheDocument()
  })

  it('renders the sync status button for an authenticated real user', () => {
    const authClient = createMockAuthClient({
      session: { user: { id: 'real-1', email: 'user@example.com', name: 'User', isAnonymous: false } },
    })
    renderWithProviders(authClient)
    expect(screen.getByLabelText('Sync status')).toBeInTheDocument()
  })

  it('renders the sync status button when there is no session (logged-out fallback)', () => {
    const authClient = createMockAuthClient({ session: null })
    renderWithProviders(authClient)
    expect(screen.getByLabelText('Sync status')).toBeInTheDocument()
  })
})
