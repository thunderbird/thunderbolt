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

const createApp = (settings = ssoSettings, fetchFn?: typeof fetch) =>
  new Elysia({ prefix: '/v1' }).use(createSsoDesktopCallbackRoutes(settings, fetchFn))

const callbackUrl = (port: number | string, cookies?: string, extraQuery = '') => {
  const app = createApp()
  const req = new Request(`http://localhost/v1/api/auth/sso/desktop-callback?loopback_port=${port}${extraQuery}`, {
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

  describe('failed login', () => {
    const callbackWithError = (error: string, cookies?: string) =>
      callbackUrl(17421, cookies, `&error=${encodeURIComponent(error)}`)

    it('hands a hostile error code to the app as one inert value', async () => {
      const res = await callbackWithError('x&token=evil', 'thunderbolt_desktop_sso_nonce=abc')

      expect(res.status).toBe(302)
      const location = new URL(res.headers.get('location')!)
      expect(location.origin).toBe('http://127.0.0.1:17421')
      expect(location.searchParams.get('error')).toBe('x&token=evil')
      expect(location.searchParams.has('token')).toBe(false)
    })

    it('still requires the nonce cookie', async () => {
      const res = await callbackWithError('access_denied')

      expect(res.status).toBe(403)
      expect(res.headers.has('location')).toBe(false)
    })
  })
})

describe('SSO desktop-initiate', () => {
  const initiateUrl = (port: number | string, fetchFn?: typeof fetch) => {
    const app = createApp(ssoSettings, fetchFn)
    return app.handle(new Request(`http://localhost/v1/api/auth/sso/desktop-initiate?loopback_port=${port}`))
  }

  it('asks Better Auth to send a failed login back to the desktop callback', async () => {
    const requests: { url: string; body: unknown }[] = []
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) })
      return Response.json({ url: 'https://idp.example.test/authorize' })
    }) as typeof fetch

    await initiateUrl(17421, fakeFetch)

    const callbackURL = 'http://localhost:8000/v1/api/auth/sso/desktop-callback?loopback_port=17421'
    expect(requests).toEqual([
      {
        url: 'http://localhost:8000/v1/api/auth/sign-in/sso',
        body: { providerId: 'sso', callbackURL, errorCallbackURL: callbackURL },
      },
    ])
  })

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

describe('SSO desktop error page', () => {
  it('titles the page with the branding app name, HTML-escaped', async () => {
    const app = createApp({ ...ssoSettings, branding: { appName: 'Acme <AI> & Co' } } as Settings)
    const res = await app.handle(new Request('http://localhost/v1/api/auth/sso/desktop-callback?loopback_port=1'))
    const html = await res.text()
    expect(html).toContain('<title>Acme &lt;AI&gt; &amp; Co</title>')
  })

  it('falls back to Thunderbolt without branding', async () => {
    const res = await callbackUrl(1)
    expect(await res.text()).toContain('<title>Thunderbolt</title>')
  })
})
