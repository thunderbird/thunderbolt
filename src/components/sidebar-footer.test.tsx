/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { type ReactNode } from 'react'
import { MemoryRouter } from 'react-router'

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'

// Per docs/development/testing.md: do NOT mock app-internal modules. Real implementations
// are used via createTestProvider + SignInModalProvider + SidebarProvider. Modal components
// only render their dialog when `open={true}`, so leaving them real is harmless here.

import { SidebarProvider } from '@/components/ui/sidebar'
import { SignInModalProvider } from '@/contexts'
import type { AuthClient } from '@/contexts'
import { SidebarFooter } from './sidebar-footer'

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
    <MemoryRouter>
      <TestProvider>
        <SignInModalProvider>
          <SidebarProvider>{children}</SidebarProvider>
        </SignInModalProvider>
      </TestProvider>
    </MemoryRouter>
  )
  return render(<SidebarFooter />, { wrapper: Wrapper })
}

describe('SidebarFooter', () => {
  describe('anonymous users', () => {
    it('shows the Sign In affordance (treats anonymous as logged-out)', () => {
      const authClient = createMockAuthClient({
        session: { user: { id: 'anon-1', email: 'temp@anon.com', name: 'Anonymous', isAnonymous: true } },
      })
      renderWithProviders(authClient)
      expect(screen.getByText('Sign In')).toBeInTheDocument()
    })

    it('does NOT leak the synthetic anonymous email into the UI', () => {
      const authClient = createMockAuthClient({
        session: { user: { id: 'anon-1', email: 'temp@anon.com', name: 'Anonymous', isAnonymous: true } },
      })
      renderWithProviders(authClient)
      expect(screen.queryByText('temp@anon.com')).toBeNull()
    })

    it('does NOT show "Anonymous" as a logged-in display name', () => {
      const authClient = createMockAuthClient({
        session: { user: { id: 'anon-1', email: 'temp@anon.com', name: 'Anonymous', isAnonymous: true } },
      })
      renderWithProviders(authClient)
      expect(screen.queryByText('Anonymous')).toBeNull()
    })
  })

  describe('real authenticated users', () => {
    it('shows the user email and not the Sign In affordance', () => {
      const authClient = createMockAuthClient({
        session: { user: { id: 'real-1', email: 'user@example.com', name: 'Real User', isAnonymous: false } },
      })
      renderWithProviders(authClient)
      expect(screen.getByText('user@example.com')).toBeInTheDocument()
      expect(screen.queryByText('Sign In')).toBeNull()
    })
  })

  describe('fully logged-out users', () => {
    it('shows the Sign In affordance', () => {
      const authClient = createMockAuthClient({ session: null })
      renderWithProviders(authClient)
      expect(screen.getByText('Sign In')).toBeInTheDocument()
    })
  })

  describe('pending session', () => {
    it('shows the loading indicator', () => {
      const authClient = createMockAuthClient({ session: null, isPending: true })
      renderWithProviders(authClient)
      expect(screen.getByText('Loading...')).toBeInTheDocument()
    })
  })
})
