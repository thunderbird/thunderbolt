/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { saveIntegrationCredentials } from '@/dal'
import { getDb } from '@/db/database'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { type ReactNode } from 'react'
import { MemoryRouter } from 'react-router'

// Per docs/development/testing.md: do NOT mock shared modules. useIntegrationStatus,
// useSettings, getProStatus, etc. run their real implementations against the test DB.
import { SignInModalProvider } from '@/contexts'
import type { AuthClient } from '@/contexts'
import IntegrationsPage from './integrations'

const authedSession = {
  user: { id: 'user-1', email: 'a@b.com', name: 'Alice', isAnonymous: false },
}

// IntegrationsPage uses react-router (useLocation/useNavigate), which the test
// provider does not supply — wrap in a MemoryRouter.
const renderPage = (authClient: AuthClient) => {
  const TestProvider = createTestProvider({ authClient })
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <TestProvider>
      <SignInModalProvider>
        <MemoryRouter initialEntries={['/settings/integrations']}>{children}</MemoryRouter>
      </SignInModalProvider>
    </TestProvider>
  )
  return render(<IntegrationsPage />, { wrapper: Wrapper })
}

/** Flush the page's mount-time queries (integration status, settings, pro status). */
const flushQueries = async () => {
  await act(async () => {
    await getClock().runAllAsync()
  })
}

const seedConnectedTinfoil = async () => {
  await saveIntegrationCredentials(
    getDb(),
    'tinfoil',
    {
      access_token: 'test-access',
      refresh_token: 'test-refresh',
      expires_at: Date.now() + 3_600_000,
      profile: { email: 'user@tinfoil.test', name: 'Tinfoil User' },
    },
    true,
  )
}

describe('IntegrationsPage — Tinfoil SKU surface', () => {
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

  it('frames the disconnected Tinfoil card around powering models with a plan', async () => {
    renderPage(createMockAuthClient({ session: authedSession }))
    await flushQueries()

    // Subscription-aware framing instead of a bare "Connect Tinfoil".
    expect(screen.getByText(/power tinfoil.s confidential models with your own plan/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /connect tinfoil/i })).toBeInTheDocument()
    // No "Manage subscription" until connected.
    expect(screen.queryByRole('button', { name: /manage subscription/i })).not.toBeInTheDocument()
  })

  it('shows connected state with a Manage subscription outbound link', async () => {
    await seedConnectedTinfoil()
    renderPage(createMockAuthClient({ session: authedSession }))
    await flushQueries()

    expect(screen.getByText('user@tinfoil.test')).toBeInTheDocument()
    expect(screen.getByText(/tinfoil models run on your plan/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /manage subscription/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /disconnect/i })).toBeInTheDocument()
  })

  it('does not claim "run on your plan" when connected but disabled', async () => {
    // Connected credentials present, but the integration toggle is off — the
    // managed path serves the models, so the card must not assert the plan path.
    await saveIntegrationCredentials(
      getDb(),
      'tinfoil',
      {
        access_token: 'test-access',
        refresh_token: 'test-refresh',
        expires_at: Date.now() + 3_600_000,
        profile: { email: 'user@tinfoil.test', name: 'Tinfoil User' },
      },
      false,
    )
    renderPage(createMockAuthClient({ session: authedSession }))
    await flushQueries()

    expect(screen.getByText(/connected, but disabled/i)).toBeInTheDocument()
    expect(screen.queryByText(/models run on your plan/i)).not.toBeInTheDocument()
    // Still connected, so Manage subscription + Disconnect remain available.
    expect(screen.getByRole('button', { name: /manage subscription/i })).toBeInTheDocument()
  })

  it('opens the Tinfoil dashboard billing page from Manage subscription', async () => {
    await seedConnectedTinfoil()
    const originalOpen = window.open
    const mockWindowOpen = mock(() => null)
    window.open = mockWindowOpen as typeof window.open

    renderPage(createMockAuthClient({ session: authedSession }))
    await flushQueries()

    fireEvent.click(screen.getByRole('button', { name: /manage subscription/i }))

    expect(mockWindowOpen).toHaveBeenCalledWith('https://dash.tinfoil.sh/?tab=billing', '_blank', 'noopener,noreferrer')

    window.open = originalOpen
  })
})
