/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { WaitlistPage } from './waitlist-page'
import { WaitlistLanguagePicker } from './waitlist-language-picker'

const TestProvider = createTestProvider({ mockResponse: { success: true } })
const Wrapper = ({ children }: { children: ReactNode }) => (
  <TestProvider>
    <MemoryRouter>{children}</MemoryRouter>
  </TestProvider>
)

describe('WaitlistLanguagePicker', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(cleanup)

  it('renders unauthenticated, without a signed-in account', () => {
    render(<WaitlistLanguagePicker />, { wrapper: Wrapper })

    expect(screen.getByRole('combobox', { name: 'Language' })).toBeInTheDocument()
  })

  it('shows the language the app is currently rendering in', () => {
    render(<WaitlistLanguagePicker />, { wrapper: Wrapper })

    // The endonym, not the tag — the list has to read naturally to someone who
    // cannot yet read the surrounding UI.
    expect(screen.getByRole('combobox', { name: 'Language' })).toHaveTextContent('English')
  })

  it('sits below the legal text on the waitlist entry screen', () => {
    render(<WaitlistPage />, { wrapper: Wrapper })

    const terms = screen.getByText(/By continuing, you agree to our/)
    const picker = screen.getByRole('combobox', { name: 'Language' })

    // `compareDocumentPosition` returns FOLLOWING when `picker` comes after
    // `terms` in document order.
    expect(terms.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
