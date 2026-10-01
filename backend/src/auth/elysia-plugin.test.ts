/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { stripStaleSessionCookie } from './elysia-plugin'

const make = (headers: Record<string, string>) =>
  new Request('http://localhost/v1/api/auth/passkey/generate-register-options', { headers })

describe('stripStaleSessionCookie', () => {
  it('drops the session cookie but keeps the WebAuthn challenge cookie when a bearer is present', () => {
    const out = stripStaleSessionCookie(
      make({
        authorization: 'Bearer abc.def',
        cookie: 'better-auth.session_token=STALE.sig; better-auth-passkey=challenge123',
      }),
    )
    expect(out.headers.get('cookie')).toBe('better-auth-passkey=challenge123')
  })

  it('removes the cookie header entirely when only the session cookie was present', () => {
    const out = stripStaleSessionCookie(
      make({ authorization: 'Bearer abc.def', cookie: 'better-auth.session_token=STALE.sig' }),
    )
    expect(out.headers.get('cookie')).toBeNull()
  })

  it('leaves the request untouched when there is no bearer token (cookie-auth flows)', () => {
    const req = make({ cookie: 'better-auth.session_token=VALID.sig' })
    const out = stripStaleSessionCookie(req)
    expect(out).toBe(req)
    expect(out.headers.get('cookie')).toBe('better-auth.session_token=VALID.sig')
  })

  it('leaves the request untouched when there is no session cookie', () => {
    const req = make({ authorization: 'Bearer abc.def', cookie: 'better-auth-passkey=challenge123' })
    expect(stripStaleSessionCookie(req)).toBe(req)
  })
})
