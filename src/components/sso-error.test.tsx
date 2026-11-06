/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { MemoryRouter, Route, Routes } from 'react-router'
import SsoError from './sso-error'

const renderAt = (search: string) =>
  render(
    <MemoryRouter initialEntries={[`/sso-error${search}`]}>
      <Routes>
        <Route path="/sso-error" element={<SsoError />} />
        <Route path="/sso-redirect" element={<p>restarted sign-in</p>} />
      </Routes>
    </MemoryRouter>,
  )

describe('SsoError', () => {
  afterEach(cleanup)

  it('explains a cancelled sign-in', () => {
    renderAt('?error=access_denied')

    expect(
      screen.getByText('Sign-in was cancelled, or your identity provider did not grant access.'),
    ).toBeInTheDocument()
  })

  // OIDC sends the code with spaces (`account+not+linked`), SAML with underscores.
  it.each(['?error=account+not+linked', '?error=account_not_linked'])(
    'explains an unlinked account for "%s"',
    (search) => {
      renderAt(search)

      expect(screen.getByText(/An account with this email already exists but is not verified/)).toBeInTheDocument()
    },
  )

  it('tells the user to start from the app when a dashboard login is refused', () => {
    renderAt('?error=unsolicited_response&error_description=IdP-initiated+SSO+not+allowed')

    expect(screen.getByText(/Open Thunderbolt and sign in from there/)).toBeInTheDocument()
  })

  it('shows a generic message for an unknown code and never the code itself', () => {
    renderAt('?error=<b>boom</b>&error_description=raw+provider+text')

    expect(screen.getByText('We could not sign you in. Please try again.')).toBeInTheDocument()
    expect(screen.queryByText(/boom/)).toBeNull()
    expect(screen.queryByText(/raw provider text/)).toBeNull()
  })

  it.each(['', '?error=constructor', '?error=__proto__'])('falls back to the generic message for "%s"', (search) => {
    renderAt(search)

    expect(screen.getByText('We could not sign you in. Please try again.')).toBeInTheDocument()
  })

  it('sends "Try again" to the SSO redirect', () => {
    renderAt('?error=access_denied')

    fireEvent.click(screen.getByRole('link', { name: 'Try again' }))

    expect(screen.getByText('restarted sign-in')).toBeInTheDocument()
  })
})
