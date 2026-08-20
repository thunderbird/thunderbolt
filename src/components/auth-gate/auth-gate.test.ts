/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { resolveRedirect } from './auth-gate'

describe('resolveRedirect', () => {
  it('sends an unauthenticated SSO visitor to the sign-in flow', () => {
    expect(resolveRedirect('sso', '')).toBe('/sso-redirect')
    expect(resolveRedirect('sso', '?utm_source=email')).toBe('/sso-redirect')
  })

  it('diverts a failed sign-in to the terminal error page', () => {
    // The SAML assertion-consumer path ignores `onAPIError.errorURL` and lands
    // failures on the app root, where restarting the flow would loop forever.
    expect(resolveRedirect('sso', '?error=account_not_linked')).toBe('/auth-error?error=account_not_linked')
    expect(resolveRedirect('sso', '?error=saml_error&error_description=bad+assertion')).toBe(
      '/auth-error?error=saml_error&error_description=bad+assertion',
    )
  })

  it('leaves the other targets alone', () => {
    expect(resolveRedirect('waitlist', '?error=whatever')).toBe('/waitlist')
    expect(resolveRedirect('home', '?error=whatever')).toBe('/')
  })
})
