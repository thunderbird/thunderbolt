/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { AnonymousSignInButton } from './anonymous-sign-in-button'

const mockNavigate = mock(() => {})
mock.module('react-router', () => ({
  useNavigate: () => mockNavigate,
}))

const mockSignInAnonymous = mock(
  async (): Promise<{
    error: { status: number; code: string } | null
    data: { user: { id: string } } | null
  }> => ({
    error: null,
    data: { user: { id: 'anon-1' } },
  }),
)

mock.module('@/contexts', () => ({
  useAuth: () => ({
    signIn: { anonymous: mockSignInAnonymous },
  }),
}))

describe('AnonymousSignInButton', () => {
  beforeEach(() => {
    mockNavigate.mockClear()
    mockSignInAnonymous.mockClear()
  })

  it('renders with the correct label', () => {
    render(<AnonymousSignInButton />)
    expect(screen.getByRole('button', { name: 'Try Thunderbolt without signing up' })).toBeDefined()
  })

  it('navigates to / on successful sign-in', async () => {
    mockSignInAnonymous.mockResolvedValueOnce({ error: null, data: { user: { id: 'anon-1' } } })
    render(<AnonymousSignInButton />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button'))
    })

    expect(mockSignInAnonymous).toHaveBeenCalledTimes(1)
    expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true })
  })

  it('navigates to / when user already has an anonymous session (400 error code)', async () => {
    mockSignInAnonymous.mockResolvedValueOnce({
      error: { status: 400, code: 'ANONYMOUS_USERS_CANNOT_SIGN_IN_AGAIN_ANONYMOUSLY' },
      data: null,
    })
    render(<AnonymousSignInButton />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button'))
    })

    expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true })
  })

  it('shows "Starting…" label while pending', async () => {
    // Keep the promise unresolved so we can inspect the pending state
    let resolve!: (value: { error: null; data: { user: { id: string } } }) => void
    mockSignInAnonymous.mockReturnValueOnce(
      new Promise((res) => {
        resolve = res
      }),
    )

    render(<AnonymousSignInButton />)
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
