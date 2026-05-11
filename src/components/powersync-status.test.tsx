/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { type ReactNode } from 'react'

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'

// Mock only single-export leaf modules per docs/development/testing.md.
// - SignInModal / SyncSetupModal are dialog components rendered by SignInModalProvider;
//   we don't need to test the modal flows here.
// - useIsMobile reads window.matchMedia, which is unreliable in happy-dom.
mock.module('@/components/sign-in-modal', () => ({ SignInModal: () => null }))
mock.module('@/components/sync-setup/sync-setup-modal', () => ({ SyncSetupModal: () => null }))
mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => ({ isMobile: false }) }))

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
  it('renders nothing when the session user is anonymous', () => {
    const authClient = createMockAuthClient({
      session: { user: { id: 'anon-1', email: 'temp@anon.com', name: 'Anonymous', isAnonymous: true } },
    })
    renderWithProviders(authClient)
    expect(screen.queryByLabelText('Sync status')).toBeNull()
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
