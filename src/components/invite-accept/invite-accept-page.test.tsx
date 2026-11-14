/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createClient } from '@/lib/http'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { InviteAcceptPage } from './invite-accept-page'

const LocationSpy = ({ onChange }: { onChange: (path: string) => void }) => {
  onChange(useLocation().pathname)
  return null
}

/** A backend that answers every request with `status` and `body`, recording each path and each invitation lookup. */
const backend = (status: number, body: unknown) => {
  const requests: string[] = []
  const paths: string[] = []
  const client = createClient({
    prefixUrl: 'http://backend.test',
    fetch: async (input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      paths.push(path)
      if (path.startsWith('/invitations/')) {
        requests.push(path)
      }
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    },
  })
  return { client, requests, paths }
}

const invitation = { email: 'contractor@corp.com', expiresAt: '2026-11-21T00:00:00.000Z' }

describe('InviteAcceptPage', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  afterEach(async () => {
    await resetTestDatabase()
    cleanup()
  })

  const renderPage = async ({
    status = 200,
    body = invitation as unknown,
    session = null as { user: { id: string; email: string; isAnonymous?: boolean } } | null,
  } = {}) => {
    const { client, requests, paths } = backend(status, body)
    const TestProvider = createTestProvider({ httpClient: client, authClient: createMockAuthClient({ session }) })
    let location = ''
    render(
      <Routes>
        <Route path="/invite/:token" element={<InviteAcceptPage />} />
        <Route path="*" element={<LocationSpy onChange={(path) => (location = path)} />} />
      </Routes>,
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <MemoryRouter initialEntries={['/invite/abc_123-token']}>
            <TestProvider>{children}</TestProvider>
          </MemoryRouter>
        ),
      },
    )
    await act(async () => {
      await getClock().runAllAsync()
    })
    return { requests, paths, getLocation: () => location }
  }

  it('looks the invitation up by its token and offers the email code for the invited address', async () => {
    const { requests } = await renderPage()

    expect(requests).toEqual(['/invitations/abc_123-token'])
    expect(screen.getByRole('heading', { name: /You've been invited to/ })).toBeInTheDocument()
    expect(screen.getByText('Sign in with contractor@corp.com to accept the invitation.')).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue('contractor@corp.com')
  })

  it('sends the invited address down the email-code path, never asking for SSO discovery', async () => {
    // An overridden invitee on a domain an IdP claims must reach the code step. SSO discovery goes
    // through the shared `http` client, so watch the global fetch as well as the app's client.
    const originalFetch = globalThis.fetch
    const globalUrls: string[] = []
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        globalUrls.push(input instanceof Request ? input.url : input.toString())
        return originalFetch(input, init)
      },
      { preconnect: originalFetch.preconnect },
    )
    try {
      const { paths } = await renderPage()

      fireEvent.click(screen.getByRole('button', { name: 'Send Magic Link' }))
      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(paths).toContain('/waitlist/join')
      expect([...paths, ...globalUrls].filter((url) => url.includes('/sso/discover'))).toEqual([])
      expect(screen.queryByRole('button', { name: /organization/i })).not.toBeInTheDocument()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('says an invitation that can no longer be used is not valid, and offers sign-in', async () => {
    const { getLocation } = await renderPage({ status: 404, body: { code: 'INVITATION_NOT_FOUND' } })

    expect(screen.getByRole('heading', { name: 'This invitation is no longer valid' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))
    expect(getLocation()).toBe('/')
  })

  it('offers a retry when the lookup fails for another reason', async () => {
    const { requests } = await renderPage({ status: 500, body: {} })

    expect(screen.getByRole('heading', { name: "Couldn't load this invitation" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await act(async () => {
      await getClock().runAllAsync()
    })
    expect(requests).toHaveLength(2)
  })

  it('tells a signed-in visitor who they are signed in as', async () => {
    const { getLocation } = await renderPage({ session: { user: { id: 'u1', email: 'me@corp.com' } } })

    expect(screen.getByText("You're signed in as me@corp.com.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(getLocation()).toBe('/')
  })

  it('treats an anonymous session as signed out', async () => {
    await renderPage({ session: { user: { id: 'anon', email: 'anon@x.invalid', isAnonymous: true } } })

    expect(screen.getByRole('textbox')).toHaveValue('contractor@corp.com')
  })
})
