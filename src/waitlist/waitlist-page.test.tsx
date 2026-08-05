/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { WaitlistPage } from './waitlist-page'

describe('WaitlistPage', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)

  afterEach(() => {
    cleanup()
    restoreViewport()
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
})
