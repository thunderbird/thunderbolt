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
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { SsoEmailCodePage } from './sso-email-code-page'

const httpClient = createClient({
  prefixUrl: 'http://backend.test',
  fetch: async () =>
    new Response(JSON.stringify({ success: true, challengeToken: 'token' }), {
      headers: { 'Content-Type': 'application/json' },
    }),
})

describe('SsoEmailCodePage', () => {
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

  const renderPage = async () => {
    const TestProvider = createTestProvider({ httpClient, authClient: createMockAuthClient({ session: null }) })
    render(<SsoEmailCodePage />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={[{ pathname: '/sign-in/email-code', state: { email: 'contractor@corp.com' } }]}>
          <TestProvider>{children}</TestProvider>
        </MemoryRouter>
      ),
    })
    await act(async () => {
      await getClock().runAllAsync()
    })
  }

  const sendCode = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await act(async () => {
      await getClock().runAllAsync()
    })
  }

  it('goes straight into the app once the code is accepted, with no welcome step', async () => {
    const replace = spyOn(window.location, 'replace').mockImplementation(() => undefined)
    try {
      await renderPage()
      expect(screen.getByRole('textbox')).toHaveValue('contractor@corp.com')
      await sendCode()
      expect(screen.getByText('Check your email')).toBeInTheDocument()

      fireEvent.change(screen.getByRole('textbox'), { target: { value: '12345678' } })
      await act(async () => {
        await getClock().tickAsync(100)
      })

      expect(replace).toHaveBeenCalledWith('/')
      expect(screen.queryByText(/Welcome/)).not.toBeInTheDocument()
    } finally {
      replace.mockRestore()
    }
  })

  it('goes back from the code step to the email step', async () => {
    await renderPage()
    await sendCode()

    fireEvent.click(screen.getByRole('button', { name: 'Go back' }))

    expect(screen.getByRole('heading', { name: 'Sign in with an email code' })).toBeInTheDocument()
  })
})
