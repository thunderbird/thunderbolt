/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import type { Settings } from '@/config/settings'
import { createSsoDesktopCallbackRoutes } from './sso-desktop-callback'

const ssoSettings = {
  authMode: 'oidc',
  betterAuthUrl: 'http://localhost:8000',
  betterAuthSecret: 'test-secret',
} as Settings

const createApp = (settings = ssoSettings) =>
  new Elysia({ prefix: '/v1' }).use(createSsoDesktopCallbackRoutes(settings))

const callbackUrl = (port: number | string, cookies?: string) => {
  const app = createApp()
  const req = new Request(`http://localhost/v1/api/auth/sso/desktop-callback?loopback_port=${port}`, {
    headers: cookies ? { cookie: cookies } : {},
  })
  return app.handle(req)
}

describe('SSO desktop routes in consumer mode', () => {
  it('returns 404 when authMode is consumer', async () => {
    const app = createApp({ authMode: 'consumer' } as Settings)
    const res = await app.handle(new Request('http://localhost/v1/api/auth/sso/desktop-initiate?loopback_port=17421'))
    expect(res.status).toBe(404)
  })
})

describe('SSO desktop-callback', () => {
  describe('port validation', () => {
    it('rejects disallowed port', async () => {
      const res = await callbackUrl(9999, 'thunderbolt_desktop_sso_nonce=abc; better-auth.session_token=tok')
      expect(res.status).toBe(400)
      const body = await res.text()
      expect(body).toContain('Invalid loopback port')
    })

    it('rejects non-numeric port', async () => {
      const res = await callbackUrl('abc', 'thunderbolt_desktop_sso_nonce=abc; better-auth.session_token=tok')
      expect(res.status).toBe(400)
    })

    it('rejects port 80 (open redirect prevention)', async () => {
      const res = await callbackUrl(80, 'thunderbolt_desktop_sso_nonce=abc; better-auth.session_token=tok')
      expect(res.status).toBe(400)
    })

    it.each([17421, 17422, 17423])('accepts allowed port %d', async (port) => {
      const res = await callbackUrl(port, 'thunderbolt_desktop_sso_nonce=abc; better-auth.session_token=tok')
      expect(res.status).toBe(302)
    })
  })

  describe('nonce verification (CSRF protection)', () => {
    it('rejects request without nonce cookie', async () => {
      const res = await callbackUrl(17421, 'better-auth.session_token=tok')
      expect(res.status).toBe(403)
      const body = await res.text()
      expect(body).toContain('Invalid request')
    })

    it('rejects request with no cookies at all', async () => {
      const res = await callbackUrl(17421)
      expect(res.status).toBe(403)
    })

    it('accepts request with nonce cookie present', async () => {
      const res = await callbackUrl(17421, 'thunderbolt_desktop_sso_nonce=abc123; better-auth.session_token=tok')
      expect(res.status).toBe(302)
    })

    it('clears nonce cookie after use', async () => {
      const res = await callbackUrl(17421, 'thunderbolt_desktop_sso_nonce=abc123; better-auth.session_token=tok')
      const setCookie = res.headers.get('set-cookie') ?? ''
      expect(setCookie).toContain('thunderbolt_desktop_sso_nonce=')
      expect(setCookie).toContain('Max-Age=0')
    })
  })

  describe('session token extraction', () => {
    it('rejects request without session cookie', async () => {
      const res = await callbackUrl(17421, 'thunderbolt_desktop_sso_nonce=abc')
      expect(res.status).toBe(401)
      const body = await res.text()
      expect(body).toContain('Session not found')
    })

    it('redirects to loopback with token', async () => {
      const res = await callbackUrl(
        17421,
        'thunderbolt_desktop_sso_nonce=abc; better-auth.session_token=rawtoken.sig123',
      )
      expect(res.status).toBe(302)
      const location = res.headers.get('location')!
      expect(location).toStartWith('http://127.0.0.1:17421/?token=')
      const url = new URL(location)
      expect(url.searchParams.get('token')).toBe('rawtoken.sig123')
    })

    it('decodes URL-encoded cookie value', async () => {
      const res = await callbackUrl(
        17422,
        'thunderbolt_desktop_sso_nonce=abc; better-auth.session_token=rawtoken.sig%3D%3D',
      )
      expect(res.status).toBe(302)
      const location = res.headers.get('location')!
      const url = new URL(location)
      expect(url.searchParams.get('token')).toBe('rawtoken.sig==')
    })

    it('redirects to the correct port', async () => {
      const res = await callbackUrl(17423, 'thunderbolt_desktop_sso_nonce=abc; better-auth.session_token=tok')
      const location = res.headers.get('location')!
      expect(location).toStartWith('http://127.0.0.1:17423/')
    })
  })
})

describe('SSO desktop-initiate', () => {
  const initiateUrl = (port: number | string) => {
    const app = createApp()
    return app.handle(new Request(`http://localhost/v1/api/auth/sso/desktop-initiate?loopback_port=${port}`))
  }

  describe('port validation', () => {
    it('rejects disallowed port', async () => {
      const res = await initiateUrl(9999)
      expect(res.status).toBe(400)
      const body = await res.text()
      expect(body).toContain('Invalid loopback port')
    })

    it('rejects port 0', async () => {
      const res = await initiateUrl(0)
      expect(res.status).toBe(400)
    })

    it('rejects negative port', async () => {
      const res = await initiateUrl(-1)
      expect(res.status).toBe(400)
    })
  })
})
