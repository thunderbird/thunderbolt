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
import { SidebarFooter, syncStatusText } from './sidebar-footer'

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
    it('shows the account pill with the display name and not the Sign In affordance', () => {
      const authClient = createMockAuthClient({
        session: { user: { id: 'real-1', email: 'user@example.com', name: 'Real User', isAnonymous: false } },
      })
      renderWithProviders(authClient)
      expect(screen.getByText('Real User')).toBeInTheDocument()
      expect(screen.queryByText('Sign In')).toBeNull()
    })

    it('falls back to the email when the account has no display name', () => {
      const authClient = createMockAuthClient({
        session: { user: { id: 'real-2', email: 'noname@example.com', isAnonymous: false } },
      })
      renderWithProviders(authClient)
      expect(screen.getByText('noname@example.com')).toBeInTheDocument()
    })

    it('collapses to an icon-only perfect circle when the display label is blank', () => {
      // OTP sign-ups get name '' (not null); the old pill kept its horizontal
      // padding and rendered a 48×32 oval around the cloud icon. Blank labels
      // must produce the square rounded-full control that matches ThemeToggle.
      const authClient = createMockAuthClient({
        session: { user: { id: 'real-3', email: '', name: '', isAnonymous: false } },
      })
      renderWithProviders(authClient)
      const button = screen.getByRole('button', { name: 'Account menu' })
      expect(button.className).toContain('size-[var(--touch-height-default)]')
      expect(button.querySelector('span')).toBeNull()
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

describe('syncStatusText', () => {
  it('pitches sync when it is off', () => {
    expect(syncStatusText(false, 'disconnected', false, null)).toBe('Keep your data synced across devices.')
  })

  it('reports connecting and offline states', () => {
    expect(syncStatusText(true, 'connecting', false, null)).toBe('Connecting...')
    expect(syncStatusText(true, 'disconnected', false, null)).toBe('Offline — changes will sync when back online.')
  })

  it('reports a fresh sync as "Just synced"', () => {
    expect(syncStatusText(true, 'connected', true, new Date(Date.now() - 5_000))).toBe('Just synced')
  })

  it('reports an older sync as relative time', () => {
    expect(syncStatusText(true, 'connected', true, new Date(Date.now() - 10 * 60_000))).toBe('Synced 10 minutes ago')
  })

  it('falls back to Connected before the first sync lands', () => {
    expect(syncStatusText(true, 'connected', false, null)).toBe('Connected')
  })
})
