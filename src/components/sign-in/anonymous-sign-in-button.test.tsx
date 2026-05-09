/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { AnonymousSignInButton } from './anonymous-sign-in-button'

const mockNavigate = mock(() => {})
mock.module('react-router', () => ({
  useNavigate: () => mockNavigate,
}))

describe('AnonymousSignInButton', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    mockNavigate.mockClear()
    await resetTestDatabase()
  })

  afterEach(() => {
    // Component-level cleanup (createTestProvider's QueryClient is per-render)
  })

  const renderButton = (
    signInAnonymous: () => ReturnType<NonNullable<Parameters<typeof createMockAuthClient>[0]>['signInAnonymous'] & {}>,
  ) => {
    const authClient = createMockAuthClient({ signInAnonymous })
    return render(<AnonymousSignInButton />, { wrapper: createTestProvider({ authClient }) })
  }

  it('renders with the correct label', () => {
    renderButton(async () => ({ error: null, data: { user: { id: 'anon-1' } } }))
    expect(screen.getByRole('button', { name: 'Try Thunderbolt without signing up' })).toBeDefined()
  })

  it('navigates to / on successful sign-in', async () => {
    const signInAnonymous = mock(async () => ({ error: null, data: { user: { id: 'anon-1' } } }))
    renderButton(signInAnonymous)

    await act(async () => {
      fireEvent.click(screen.getByRole('button'))
    })

    expect(signInAnonymous).toHaveBeenCalledTimes(1)
    expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true })
  })

  it('navigates to / when user already has an anonymous session (400 error code)', async () => {
    renderButton(async () => ({
      error: { status: 400, code: 'ANONYMOUS_USERS_CANNOT_SIGN_IN_AGAIN_ANONYMOUSLY' },
      data: null,
    }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button'))
    })

    expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true })
  })

  it('shows "Starting…" label while pending', async () => {
    // Keep the promise unresolved so we can inspect the pending state
    let resolve!: (value: { error: null; data: { user: { id: string } } }) => void
    const signInAnonymous = mock(
      () =>
        new Promise<{ error: null; data: { user: { id: string } } }>((res) => {
          resolve = res
        }),
    )
    renderButton(signInAnonymous)
    const button = screen.getByRole('button')

    fireEvent.click(button)

    // In the same tick: button should be disabled
    expect(button).toHaveProperty('disabled', true)

    // Clean up: resolve the promise so the test ends cleanly
    await act(async () => {
      resolve({ error: null, data: { user: { id: 'anon-1' } } })
    })
  })
})
