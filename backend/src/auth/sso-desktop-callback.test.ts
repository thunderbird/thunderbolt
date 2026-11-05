/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { createHmac } from 'crypto'
import { Elysia } from 'elysia'
import type { Settings } from '@/config/settings'
import { createSsoDesktopCallbackRoutes } from './sso-desktop-callback'

const ssoSettings = {
  authMode: 'oidc',
  betterAuthUrl: 'http://localhost:8000',
  betterAuthSecret: 'desktop-sso-test-secret',
} as Settings
const clientState = 'a'.repeat(43)
const nonceCookieName = 'thunderbolt_desktop_sso_nonce'
const sessionCookie = 'better-auth.session_token=rawtoken.sig%3D%3D'
const createApp = (settings = ssoSettings, fetchFn?: typeof fetch) =>
  new Elysia({ prefix: '/v1' }).use(createSsoDesktopCallbackRoutes(settings, fetchFn))

const startFlow = async (
  port = 17421,
  state: string | null = clientState,
  options: { origin?: string; headers?: HeadersInit } = {},
) => {
  const ssoRequests: { providerId: string; callbackURL: string; errorCallbackURL: string }[] = []
  const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    ssoRequests.push(JSON.parse(String(init?.body)))
    return Response.json(
      { url: 'https://idp.example.test/authorize' },
      { headers: { 'set-cookie': 'better-auth.state=state-cookie; HttpOnly' } },
    )
  }) as typeof fetch
  const app = createApp(ssoSettings, fakeFetch)
  const query = new URLSearchParams({ loopback_port: String(port), ...(state && { client_state: state }) })
  const response = await app.handle(
    new Request(`${options.origin ?? 'http://localhost'}/v1/api/auth/sso/desktop-initiate?${query}`, {
      headers: options.headers,
    }),
  )
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${nonceCookieName}=`))!
    .split(';')[0]
  return { app, response, cookie, callback: new URL(ssoRequests[0].callbackURL), ssoRequest: ssoRequests[0] }
}

const complete = (
  flow: Awaited<ReturnType<typeof startFlow>>,
  options: { cookie?: string; session?: string | null; query?: Record<string, string | null> } = {},
) => {
  const url = new URL(flow.callback)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === null) {
      url.searchParams.delete(key)
    } else {
      url.searchParams.set(key, value)
    }
  }
  return flow.app.handle(
    new Request(url, {
      headers: {
        cookie: [options.cookie ?? flow.cookie, options.session === undefined ? sessionCookie : options.session]
          .filter(Boolean)
          .join('; '),
      },
    }),
  )
}

describe('SSO desktop routes', () => {
  it('is unavailable in consumer mode', async () => {
    const app = createApp({ authMode: 'consumer' } as Settings)
    const response = await app.handle(
      new Request('http://localhost/v1/api/auth/sso/desktop-initiate?loopback_port=17421'),
    )
    expect(response.status).toBe(404)
  })

  it.each([17421, 17422, 17423])('binds and completes a sign-in on registered port %d', async (port) => {
    const flow = await startFlow(port)
    expect(flow.response.status).toBe(302)
    expect(flow.response.headers.get('location')).toBe('https://idp.example.test/authorize')
    expect(flow.ssoRequest.providerId).toBe('sso')
    expect(flow.ssoRequest.errorCallbackURL).toBe(flow.ssoRequest.callbackURL)
    expect(flow.callback.searchParams.get('client_state')).toBe(clientState)
    expect(flow.callback.searchParams.get('callback_state')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(flow.response.headers.getSetCookie()).toContain('better-auth.state=state-cookie; HttpOnly')
    const nonce = flow.response.headers.getSetCookie().find((value) => value.startsWith(`${nonceCookieName}=`))!
    expect(nonce).toContain('HttpOnly; SameSite=Lax; Path=/v1/api/auth/sso; Max-Age=600')
    const response = await complete(flow)
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('location')!)
    expect(location.origin).toBe(`http://127.0.0.1:${port}`)
    expect(location.searchParams.get('token')).toBe('rawtoken.sig==')
    expect(location.searchParams.get('client_state')).toBe(clientState)
    expect(location.searchParams.has('callback_state')).toBe(false)
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it.each(['0', '80', '9999', '-1', 'abc'])('rejects an invalid loopback port %s', async (port) => {
    const app = createApp()
    const response = await app.handle(
      new Request(`http://localhost/v1/api/auth/sso/desktop-initiate?loopback_port=${port}`),
    )
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Invalid loopback port')
    expect((await complete(await startFlow(), { query: { loopback_port: port } })).status).toBe(400)
  })

  it.each<{ origin: string; headers: HeadersInit; secure: boolean }>([
    { origin: 'http://localhost', headers: {}, secure: false },
    { origin: 'https://app.example.test', headers: {}, secure: true },
    { origin: 'http://localhost', headers: { 'x-forwarded-proto': 'https' }, secure: true },
  ])('sets Secure on the nonce cookie for HTTPS: $origin $headers', async ({ origin, headers, secure }) => {
    const flow = await startFlow(17421, clientState, { origin, headers })
    const nonce = flow.response.headers.getSetCookie().find((value) => value.startsWith(`${nonceCookieName}=`))!
    expect(nonce.includes('; Secure')).toBe(secure)
  })

  it.each(['', 'short', 'a'.repeat(129), 'x&token=attacker', 'a'.repeat(42) + '='])(
    'rejects malformed app state %s',
    async (state) => {
      const app = createApp()
      const response = await app.handle(
        new Request(
          `http://localhost/v1/api/auth/sso/desktop-initiate?${new URLSearchParams({ loopback_port: '17421', client_state: state })}`,
        ),
      )
      expect(response.status).toBe(422)
    },
  )

  it('keeps new-backend compatibility for older clients while binding their browser callback', async () => {
    const flow = await startFlow(17421, null)
    expect(flow.callback.searchParams.has('client_state')).toBe(false)
    const response = await complete(flow)
    expect(response.status).toBe(302)
    expect(new URL(response.headers.get('location')!).searchParams.has('client_state')).toBe(false)
  })

  it.each<{ label: string; query: Record<string, string | null> }>([
    { label: 'client state changed', query: { client_state: 'b'.repeat(43) } },
    { label: 'client state removed', query: { client_state: null } },
    { label: 'port changed', query: { loopback_port: '17422' } },
    { label: 'binding changed', query: { callback_state: 'b'.repeat(43) } },
  ])('rejects a modified callback: $label', async ({ query }) => {
    const response = await complete(await startFlow(), { query })
    expect(response.status).toBe(403)
    expect(response.headers.has('location')).toBe(false)
  })

  it('rejects callbacks with missing binding even if a nonce cookie is present', async () => {
    const response = await complete(await startFlow(), { query: { callback_state: null } })
    expect(response.status).toBe(422)
    expect(response.headers.has('location')).toBe(false)
  })

  it.each(['', `${nonceCookieName}=unrelated-nonce`])(
    'rejects a missing or unrelated browser nonce',
    async (cookie) => {
      const response = await complete(await startFlow(), { cookie })
      expect(response.status).toBe(403)
      expect(response.headers.has('location')).toBe(false)
    },
  )

  it('rejects an earlier flow after another initiation replaces its cookie', async () => {
    const first = await startFlow()
    const second = await startFlow()
    expect(first.cookie).not.toBe(second.cookie)
    const response = await complete(first, { cookie: second.cookie })
    expect(response.status).toBe(403)
  })

  it('rejects a caller-chosen cookie and binding without a server signature', async () => {
    const nonce = 'attacker-chosen-nonce'
    const binding = createHmac('sha256', nonce)
      .update(JSON.stringify([17421, clientState]))
      .digest('base64url')
    const response = await complete(await startFlow(), {
      cookie: `${nonceCookieName}=${nonce}`,
      query: { callback_state: binding },
    })
    expect(response.status).toBe(403)
    expect(response.headers.has('location')).toBe(false)
  })

  it('requires a session only on the success path', async () => {
    const response = await complete(await startFlow(), { session: null })
    expect(response.status).toBe(401)
    expect(await response.text()).toContain('Session not found')
  })

  it('binds the error path and treats an error code as one inert value', async () => {
    const response = await complete(await startFlow(), { session: null, query: { error: 'x&token=evil' } })
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('location')!)
    expect(location.searchParams.get('error')).toBe('x&token=evil')
    expect(location.searchParams.get('client_state')).toBe(clientState)
    expect(location.searchParams.has('token')).toBe(false)
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  it('never forwards a forged error to the app', async () => {
    const response = await complete(await startFlow(), {
      query: { error: 'access_denied', client_state: 'b'.repeat(43) },
    })
    expect(response.status).toBe(403)
    expect(response.headers.has('location')).toBe(false)
  })
})

describe('SSO desktop error page', () => {
  it('titles the page with the branding app name, HTML-escaped', async () => {
    const app = createApp({ ...ssoSettings, branding: { appName: 'Acme <AI> & Co' } } as Settings)
    const res = await app.handle(new Request('http://localhost/v1/api/auth/sso/desktop-initiate?loopback_port=1'))
    expect(await res.text()).toContain('<title>Acme &lt;AI&gt; &amp; Co</title>')
  })

  it('declares UTF-8, so a name in any script survives', async () => {
    const app = createApp({ ...ssoSettings, branding: { appName: 'サンダー' } } as Settings)
    const res = await app.handle(new Request('http://localhost/v1/api/auth/sso/desktop-initiate?loopback_port=1'))
    expect(await res.text()).toContain('<meta charset="utf-8"><title>サンダー</title>')
  })

  it('falls back to Thunderbolt without branding', async () => {
    const res = await createApp().handle(
      new Request('http://localhost/v1/api/auth/sso/desktop-initiate?loopback_port=1'),
    )
    expect(await res.text()).toContain('<title>Thunderbolt</title>')
  })
})
