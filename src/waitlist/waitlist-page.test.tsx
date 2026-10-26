/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { useSyncExternalStore, type ReactNode } from 'react'
import { Link, MemoryRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router'

import { AuthGate } from '@/components/auth-gate'
import { useWelcomeStore } from '@/components/welcome-dialog'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import * as returningUserOnboarding from '@/lib/returning-user-onboarding'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { WaitlistPage } from './waitlist-page'

describe('WaitlistPage', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)

  afterEach(() => {
    cleanup()
    restoreViewport()
    useWelcomeStore.setState({ pending: false })
    mock.restore()
  })

  it('centers the mobile code entry directly below the email instructions', async () => {
    forceMobileViewport()
    const TestProvider = createTestProvider({
      mockResponse: { success: true, challengeToken: 'challenge-token' },
    })
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <TestProvider>
        <MemoryRouter>{children}</MemoryRouter>
      </TestProvider>
    )
    render(<WaitlistPage />, { wrapper: Wrapper })

    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'test@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByText('Check your email').parentElement).toHaveClass('mt-auto', 'md:my-auto')
    expect(screen.getByText(/If you received a code/).parentElement).toHaveClass(
      'mb-auto',
      'mt-8',
      'md:mb-0',
      'md:mt-0',
    )
  })

  it('does not navigate again when post-sign-in work finishes after the session redirect', async () => {
    const onboarding = Promise.withResolvers<void>()
    const markOnboarded = spyOn(returningUserOnboarding, 'markOnboardedForReturningUser').mockImplementation(
      () => onboarding.promise,
    )
    const user = { id: 'returning-user', email: 'test@example.com', isNew: false }
    const authClient = createMockAuthClient({
      signInEmailOtp: async () => ({ data: { user }, error: null }),
    })
    const session = { current: authClient.useSession() }
    const listeners = new Set<() => void>()
    const subscribe = (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
    const useSession = () => useSyncExternalStore(subscribe, () => session.current)
    authClient.useSession = useSession
    const TestProvider = createTestProvider({
      authClient,
      mockResponse: { success: true, challengeToken: 'challenge-token' },
    })
    const LocationProbe = () => <p data-testid="location">{useLocation().pathname}</p>
    render(
      <TestProvider>
        <MemoryRouter initialEntries={['/waitlist']}>
          <LocationProbe />
          <Routes>
            <Route element={<AuthGate require="unauthenticated" />}>
              <Route path="waitlist" element={<WaitlistPage />} />
            </Route>
            <Route element={<AuthGate require="authenticated" />}>
              <Route path="/" element={<Outlet />}>
                <Route index element={<Navigate to="/chats/new" replace />} />
                <Route path="chats/:chatThreadId" element={<Link to="/projects">Projects</Link>} />
                <Route path="projects" element={<p>Project content</p>} />
              </Route>
            </Route>
          </Routes>
        </MemoryRouter>
      </TestProvider>,
    )
    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: user.email } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    })
    await act(async () => {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: '12345678' } })
    })
    expect(markOnboarded).toHaveBeenCalledTimes(1)

    await act(async () => {
      session.current = createMockAuthClient({ session: { user } }).useSession()
      listeners.forEach((listener) => listener())
    })

    expect(screen.getByTestId('location')).toHaveTextContent('/chats/new')
    fireEvent.click(screen.getByRole('link', { name: 'Projects' }))
    expect(screen.getByTestId('location')).toHaveTextContent('/projects')
    await act(async () => onboarding.resolve())

    expect(screen.getByTestId('location')).toHaveTextContent('/projects')
    expect(screen.getByText('Project content')).toBeVisible()
  })
})
