/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { takeDeviceApprovalReturn } from '@/lib/device-approval-return'
import { DeviceApproval } from './device-approval'

type FetchResult = { data: unknown; error: unknown }
type Handlers = Partial<Record<string, () => FetchResult>>

const NavigationSpy = ({ onLocationChange }: { onLocationChange: (pathname: string) => void }) => {
  const location = useLocation()
  onLocationChange(location.pathname)
  return null
}

const authedSession = { user: { id: 'user-1', email: 'user@example.com' } }

const makeFetch = (handlers: Handlers) =>
  mock(async (path: string) => (handlers[path] ?? (() => ({ data: null, error: null })))())

const pendingVerify: Handlers = {
  '/device': () => ({ data: { user_code: 'ABCD1234', status: 'pending' }, error: null }),
}

describe('DeviceApproval', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  afterEach(async () => {
    await resetTestDatabase()
    cleanup()
    localStorage.clear()
  })

  const renderPage = ({
    code,
    session = authedSession,
    handlers = {},
  }: {
    code?: string
    session?: typeof authedSession | null
    handlers?: Handlers
  }) => {
    const url = code ? `/device?user_code=${code}` : '/device'
    const fetch = makeFetch(handlers)
    const authClient = createMockAuthClient({ session, fetch })

    let lastPathname = '/device'
    const TestProvider = createTestProvider({ authClient })

    render(
      <>
        <DeviceApproval />
        <NavigationSpy onLocationChange={(p) => (lastPathname = p)} />
      </>,
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <MemoryRouter initialEntries={[url]}>
            <TestProvider>{children}</TestProvider>
          </MemoryRouter>
        ),
      },
    )

    return { fetch, getLastPathname: () => lastPathname }
  }

  const flush = async () => {
    await act(async () => {
      await getClock().runAllAsync()
    })
  }

  describe('authentication gate', () => {
    it('redirects unauthenticated visitors into the auth flow', () => {
      const { getLastPathname } = renderPage({ code: 'ABCD1234', session: null })

      expect(getLastPathname()).toBe('/')
    })

    it('does not call any device endpoint when unauthenticated', () => {
      const { fetch } = renderPage({ code: 'ABCD1234', session: null })

      expect(fetch).not.toHaveBeenCalled()
    })

    it('stashes the return URL so the code survives the login redirect', () => {
      renderPage({ code: 'ABCD1234', session: null })

      expect(takeDeviceApprovalReturn()).toBe('/device?user_code=ABCD1234')
    })

    it('stashes nothing when there is no code to preserve', () => {
      renderPage({ session: null })

      expect(takeDeviceApprovalReturn()).toBeNull()
    })
  })

  describe('verify + confirm', () => {
    it('claims the code on mount and shows the approval prompt with the code', async () => {
      const { fetch } = renderPage({ code: 'ABCD1234', handlers: pendingVerify })
      await flush()

      expect(screen.getByText('Approve CLI sign-in?')).toBeInTheDocument()
      expect(screen.getByText('ABCD1234')).toBeInTheDocument()
      expect(fetch).toHaveBeenCalledWith('/device', { method: 'GET', query: { user_code: 'ABCD1234' } })
    })

    it('shows a manual entry form when no code is in the URL', async () => {
      renderPage({})
      await flush()

      expect(screen.getByText('Sign in to the CLI')).toBeInTheDocument()
      expect(screen.getByLabelText('Code')).toBeInTheDocument()
    })

    it('normalizes a typed code through verify AND approve', async () => {
      const { fetch } = renderPage({
        handlers: { ...pendingVerify, '/device/approve': () => ({ data: { success: true }, error: null }) },
      })
      await flush()

      fireEvent.change(screen.getByLabelText('Code'), { target: { value: ' abcd-1234 ' } })
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
      await flush()

      fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
      await flush()

      // Both the verify (query) and approve (body) must carry the normalized code,
      // not the raw " abcd-1234 " the user typed.
      expect(fetch).toHaveBeenCalledWith('/device', { method: 'GET', query: { user_code: 'ABCD-1234' } })
      expect(fetch).toHaveBeenCalledWith('/device/approve', { method: 'POST', body: { userCode: 'ABCD-1234' } })
    })
  })

  describe('approve', () => {
    it('approves and tells the user to return to their terminal', async () => {
      const { fetch } = renderPage({
        code: 'ABCD1234',
        handlers: { ...pendingVerify, '/device/approve': () => ({ data: { success: true }, error: null }) },
      })
      await flush()

      fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
      await flush()

      expect(screen.getByText('Sign-in approved')).toBeInTheDocument()
      expect(screen.getByText('You can return to your terminal.')).toBeInTheDocument()
      const successIcon = screen.getByText('Sign-in approved').closest('[role="dialog"]')?.querySelector('svg')
      expect(successIcon?.querySelector('linearGradient')).toBeInTheDocument()
      expect(successIcon).toHaveAttribute('aria-hidden', 'true')
      expect(fetch).toHaveBeenCalledWith('/device/approve', { method: 'POST', body: { userCode: 'ABCD1234' } })
    })
  })

  describe('deny', () => {
    it('denies and shows the denied state', async () => {
      const { fetch } = renderPage({
        code: 'ABCD1234',
        handlers: { ...pendingVerify, '/device/deny': () => ({ data: { success: true }, error: null }) },
      })
      await flush()

      fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
      await flush()

      expect(screen.getByText('Sign-in denied')).toBeInTheDocument()
      expect(fetch).toHaveBeenCalledWith('/device/deny', { method: 'POST', body: { userCode: 'ABCD1234' } })
    })
  })

  describe('error states', () => {
    it('shows an expired state when the code has expired', async () => {
      renderPage({
        code: 'ABCD1234',
        handlers: {
          '/device': () => ({ data: null, error: { error: 'expired_token', status: 400 } }),
        },
      })
      await flush()

      expect(screen.getByText('Request expired')).toBeInTheDocument()
    })

    it('shows an invalid state for an unknown code', async () => {
      renderPage({
        code: 'ABCD1234',
        handlers: {
          '/device': () => ({ data: null, error: { error: 'invalid_request', status: 400 } }),
        },
      })
      await flush()

      expect(screen.getByText("Code didn't work")).toBeInTheDocument()
    })
  })
})
