/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { MemoryRouter, Route, Router, Routes, useLocation } from 'react-router'
import { AuthGate } from './auth-gate'

const env = import.meta.env as Record<string, string | undefined>

const LocationProbe = () => {
  const { pathname, search } = useLocation()
  return <p>{`${pathname}${search}`}</p>
}

const renderGateAt = (entry: string) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route element={<AuthGate require="authenticated" />}>
          <Route path="/" element={<LocationProbe />} />
        </Route>
        <Route path="/sso-redirect" element={<LocationProbe />} />
        <Route path="/sso-error" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
    { wrapper: createTestProvider({ authClient: createMockAuthClient() }) },
  )

describe('AuthGate in SSO mode with no session', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  afterEach(() => {
    delete env.VITE_AUTH_MODE
  })

  it('starts the login for a plain visit', () => {
    env.VITE_AUTH_MODE = 'sso'
    renderGateAt('/')

    expect(screen.getByText('/sso-redirect')).toBeInTheDocument()
  })

  it('keeps a spinner visible until the auth redirect commits', () => {
    env.VITE_AUTH_MODE = 'sso'
    const replace = mock(() => {})
    const { container } = render(
      <Router location="/" navigator={{ createHref: () => '/', go: () => {}, push: () => {}, replace }}>
        <AuthGate require="authenticated" />
      </Router>,
      { wrapper: createTestProvider({ authClient: createMockAuthClient() }) },
    )

    expect(replace).toHaveBeenCalled()
    expect(container.querySelector('.animate-spin')).toBeInTheDocument()
  })

  it('shows the error page instead of restarting the login when the callback carries an error', () => {
    env.VITE_AUTH_MODE = 'sso'
    renderGateAt('/?error=account_not_linked')

    expect(screen.getByText('/sso-error?error=account_not_linked')).toBeInTheDocument()
  })
})
