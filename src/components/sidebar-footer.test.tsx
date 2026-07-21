/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Cloud, CloudAlert, CloudOff, Loader2 } from 'lucide-react'
import { type ReactElement, type ReactNode } from 'react'
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
import { getDatabaseInstance } from '@/db/database'
import type { DatabaseInterface } from '@/db/database-interface'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { SidebarFooter, SyncStateIcon, syncStatusText } from './sidebar-footer'

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
      expect(screen.getByText('Sign in')).toBeInTheDocument()
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
      expect(screen.queryByText('Sign in')).toBeNull()
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
      expect(screen.getByText('Sign in')).toBeInTheDocument()
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

/** Renders a React element and returns its (single) SVG root. */
const renderSvg = (node: ReactElement): SVGSVGElement => {
  const { container } = render(node)
  const svg = container.querySelector('svg')
  if (!svg) {
    throw new Error('Expected the element to render an <svg>')
  }
  return svg as SVGSVGElement
}

/** SVG path data is a stable identity signal for lucide glyphs (unlike class strings). */
const pathData = (svg: SVGSVGElement): string[] =>
  Array.from(svg.querySelectorAll('path')).map((path) => path.getAttribute('d') ?? '')

const referencePaths = (icon: ReactElement): string[] => pathData(renderSvg(icon))

describe('SyncStateIcon', () => {
  it('renders the plain Cloud outline when signed out, regardless of sync state', () => {
    const svg = renderSvg(<SyncStateIcon isLoggedIn={false} syncEnabled={true} connectionStatus="connected" />)
    expect(pathData(svg)).toEqual(referencePaths(<Cloud />))
    // Plain outline — not the gradient-stroked connected variant.
    expect(svg.querySelector('linearGradient')).toBeNull()
  })

  it('renders CloudOff when signed in with sync disabled', () => {
    const svg = renderSvg(<SyncStateIcon isLoggedIn={true} syncEnabled={false} connectionStatus="connected" />)
    expect(pathData(svg)).toEqual(referencePaths(<CloudOff />))
  })

  it('renders a spinner while connecting', () => {
    const svg = renderSvg(<SyncStateIcon isLoggedIn={true} syncEnabled={true} connectionStatus="connecting" />)
    expect(pathData(svg)).toEqual(referencePaths(<Loader2 />))
    expect(svg.classList.contains('animate-spin')).toBe(true)
  })

  it('renders the warning CloudAlert when sync is on but not connected', () => {
    for (const connectionStatus of ['disconnected', 'not-configured'] as const) {
      const svg = renderSvg(<SyncStateIcon isLoggedIn={true} syncEnabled={true} connectionStatus={connectionStatus} />)
      expect(pathData(svg)).toEqual(referencePaths(<CloudAlert />))
      expect(svg.classList.contains('text-warning')).toBe(true)
    }
  })

  it('renders the brand-gradient cloud in the healthy connected state', () => {
    const svg = renderSvg(<SyncStateIcon isLoggedIn={true} syncEnabled={true} connectionStatus="connected" />)
    // Same glyph as the signed-out Cloud, but stroked with the brand gradient.
    expect(pathData(svg)).toEqual(referencePaths(<Cloud />))
    expect(svg.querySelector('linearGradient')).not.toBeNull()
  })
})

describe('sync retry flow', () => {
  const loggedInAuthClient = () =>
    createMockAuthClient({
      session: { user: { id: 'real-1', email: 'user@example.com', name: 'Real User', isAnonymous: false } },
    })

  // The test database is bun-sqlite (no PowerSync instance), so usePowerSyncStatus
  // reports 'not-configured' — with sync enabled that is exactly the
  // "needs attention" state that surfaces the Retry button.
  beforeEach(() => {
    useLocalSettingsStore.getState().setLocalSetting('syncEnabled', true)
  })

  afterEach(() => {
    useLocalSettingsStore.getState().setLocalSetting('syncEnabled', false)
  })

  const openAccountMenu = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }))
    await screen.findByText('Cloud Sync')
  }

  it('shows the offline warning and a Retry button when sync is enabled but not connected', async () => {
    renderWithProviders(loggedInAuthClient())
    await openAccountMenu()
    expect(screen.getByText('Offline. Changes will sync when back online.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument()
  })

  it('clicking Retry triggers a reconnect through the database singleton', async () => {
    // reconnectSync() reaches the registered database via getDatabaseInstance() and
    // calls its `reconnect` method when present. The bun-sqlite test database has no
    // reconnect, so attach one to observe the real code path — no module mocking.
    const database = getDatabaseInstance() as DatabaseInterface & { reconnect?: () => Promise<void> }
    let reconnectCalls = 0
    database.reconnect = async () => {
      reconnectCalls += 1
    }
    try {
      renderWithProviders(loggedInAuthClient())
      await openAccountMenu()
      fireEvent.click(screen.getByRole('button', { name: /Retry/ }))
      await waitFor(() => expect(reconnectCalls).toBe(1))
    } finally {
      delete database.reconnect
    }
  })

  it('does not offer Retry when sync is disabled', async () => {
    useLocalSettingsStore.getState().setLocalSetting('syncEnabled', false)
    renderWithProviders(loggedInAuthClient())
    await openAccountMenu()
    expect(screen.getByText('Keep your data synced across devices.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()
  })
})

describe('syncStatusText', () => {
  it('pitches sync when it is off', () => {
    expect(syncStatusText(false, 'disconnected', false, null)).toBe('Keep your data synced across devices.')
  })

  it('reports connecting and offline states', () => {
    expect(syncStatusText(true, 'connecting', false, null)).toBe('Connecting...')
    expect(syncStatusText(true, 'disconnected', false, null)).toBe('Offline. Changes will sync when back online.')
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
