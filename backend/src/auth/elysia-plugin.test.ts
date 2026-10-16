/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  exposePasskeyChallenge,
  passkeyChallengeHeader,
  restorePasskeyChallenge,
  stripStaleSessionCookie,
} from './elysia-plugin'

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

  it('drops the __Secure- session cookie too', () => {
    const out = stripStaleSessionCookie(
      make({
        authorization: 'Bearer abc.def',
        cookie: '__Secure-better-auth.session_token=STALE.sig; __Secure-better-auth-passkey=challenge123',
      }),
    )
    expect(out.headers.get('cookie')).toBe('__Secure-better-auth-passkey=challenge123')
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

const challengeCookie = '__Secure-better-auth.better-auth-passkey=token.sig%3D'

const issued = (setCookies: string[], extra: Record<string, string> = {}) => {
  const headers = new Headers(extra)
  for (const setCookie of setCookies) {
    headers.append('set-cookie', setCookie)
  }
  return new Response('{}', { status: 200, headers })
}

describe('exposePasskeyChallenge', () => {
  it('copies the challenge cookie into an exposed header on the options responses', () => {
    for (const path of [
      '/v1/api/auth/passkey/generate-register-options',
      '/v1/api/auth/passkey/generate-authenticate-options',
    ]) {
      const out = exposePasskeyChallenge(path, issued([`${challengeCookie}; Path=/; HttpOnly; Secure; SameSite=Lax`]))
      expect(out.headers.get(passkeyChallengeHeader)).toBe(challengeCookie)
      expect(out.headers.get('access-control-expose-headers')).toBe(passkeyChallengeHeader)
      expect(out.headers.getSetCookie()).toHaveLength(1)
    }
  })

  it('merges into an expose list the response already carries', () => {
    const out = exposePasskeyChallenge(
      '/v1/api/auth/passkey/generate-authenticate-options',
      issued([`${challengeCookie}; Path=/`], { 'access-control-expose-headers': 'set-auth-token' }),
    )
    expect(out.headers.get('access-control-expose-headers')).toBe(`set-auth-token, ${passkeyChallengeHeader}`)
  })

  it('relays only the challenge cookie, never another one', () => {
    const out = exposePasskeyChallenge(
      '/v1/api/auth/passkey/generate-authenticate-options',
      issued(['better-auth.session_token=abc.sig; Path=/']),
    )
    expect(out.headers.get(passkeyChallengeHeader)).toBeNull()
  })

  it('leaves other passkey responses untouched', () => {
    const response = issued([`${challengeCookie}; Path=/`])
    expect(exposePasskeyChallenge('/v1/api/auth/passkey/verify-authentication', response)).toBe(response)
  })
})

describe('restorePasskeyChallenge', () => {
  const verifyPath = '/v1/api/auth/passkey/verify-authentication'
  const verify = (headers: Record<string, string>, path = verifyPath) =>
    new Request(`http://localhost${path}`, { method: 'POST', headers })

  it('restores on both verify calls and nowhere else', () => {
    for (const path of ['/v1/api/auth/passkey/verify-registration', verifyPath]) {
      const out = restorePasskeyChallenge(path, verify({ [passkeyChallengeHeader]: challengeCookie }, path))
      expect(out.headers.get('cookie')).toBe(challengeCookie)
    }
    const deletePath = '/v1/api/auth/passkey/delete-passkey'
    const req = verify({ [passkeyChallengeHeader]: challengeCookie }, deletePath)
    expect(restorePasskeyChallenge(deletePath, req)).toBe(req)
  })

  it('turns the relayed header back into the challenge cookie', () => {
    const out = restorePasskeyChallenge(verifyPath, verify({ [passkeyChallengeHeader]: challengeCookie }))
    expect(out.headers.get('cookie')).toBe(challengeCookie)
    expect(out.headers.get(passkeyChallengeHeader)).toBeNull()
  })

  it('appends to cookies the request already carries', () => {
    const out = restorePasskeyChallenge(
      verifyPath,
      verify({ cookie: 'other=1', [passkeyChallengeHeader]: challengeCookie }),
    )
    expect(out.headers.get('cookie')).toBe(`other=1; ${challengeCookie}`)
  })

  it('ignores a header that is not exactly the challenge cookie', () => {
    for (const value of [
      'better-auth.session_token=abc.sig',
      `${challengeCookie}; better-auth.session_token=abc.sig`,
    ]) {
      const req = verify({ [passkeyChallengeHeader]: value })
      expect(restorePasskeyChallenge(verifyPath, req)).toBe(req)
    }
  })

  it('leaves a request without the header untouched', () => {
    const req = verify({ cookie: challengeCookie })
    expect(restorePasskeyChallenge(verifyPath, req)).toBe(req)
  })
})
