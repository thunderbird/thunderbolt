/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as settingsModule from '@/config/settings'
import { createTestDb } from '@/test-utils/db'
import { createTestSettings } from '@/test-utils/settings'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'

const oidcIssuerUrl = 'https://oidc.test'
const appUrl = 'https://app.example.com'

const discoveryDocument = {
  issuer: oidcIssuerUrl,
  authorization_endpoint: `${oidcIssuerUrl}/authorize`,
  token_endpoint: `${oidcIssuerUrl}/token`,
  userinfo_endpoint: `${oidcIssuerUrl}/userinfo`,
  jwks_uri: `${oidcIssuerUrl}/jwks`,
}

/**
 * Counts token-endpoint hits. Reaching the exchange is the observable signal
 * that a callback got past the state check — the exchange itself always fails
 * here, since a real one would need a signed id_token.
 */
let tokenRequests = 0

const stubbedFetch = async (input: RequestInfo | URL): Promise<Response> => {
  const url = input instanceof Request ? input.url : input.toString()
  if (url.includes('/.well-known/openid-configuration')) {
    return new Response(JSON.stringify(discoveryDocument), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (url.includes('/token')) {
    tokenRequests += 1
    return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
  }
  return new Response('not found', { status: 404 })
}

describe('SSO callback state binding', () => {
  let handle: (request: Request) => Promise<Response>
  let cleanup: () => Promise<void>
  let getSettingsSpy: ReturnType<typeof spyOn>
  const savedFetch = globalThis.fetch
  const savedOrigins = process.env.TRUSTED_ORIGINS

  beforeAll(() => {
    globalThis.fetch = Object.assign(stubbedFetch, { preconnect: fetch.preconnect })
    process.env.TRUSTED_ORIGINS = `${oidcIssuerUrl},${appUrl}`
    getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue(
      createTestSettings({
        authMode: 'oidc',
        oidcIssuer: oidcIssuerUrl,
        oidcClientId: 'test-client-id',
        oidcClientSecret: 'test-client-secret',
        appUrl,
        betterAuthUrl: 'http://localhost:8000',
      }),
    )
  })

  afterAll(() => {
    getSettingsSpy?.mockRestore()
    globalThis.fetch = savedFetch
    process.env.TRUSTED_ORIGINS = savedOrigins
  })

  // One transaction per test, rolled back after it, per backend/docs/testing.md.
  // These tests write verification rows, so sharing a transaction would let one
  // test's consumed state leak into the next.
  beforeEach(async () => {
    const testEnv = await createTestDb()
    cleanup = testEnv.cleanup
    tokenRequests = 0

    const { createAuth } = await import('./auth')
    const app = new Elysia({ prefix: '/v1' }).mount(createAuth(testEnv.db).handler)
    handle = (request) => app.handle(request)
  }, 60_000)

  afterEach(async () => {
    await cleanup()
  }, 60_000)

  /** Starts a sign-in and returns its single-use state plus the cookie that binds it. */
  const startFlow = async () => {
    const res = await handle(
      new Request('http://localhost:8000/v1/api/auth/sign-in/sso', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: appUrl },
        body: JSON.stringify({ providerId: 'sso', callbackURL: `${appUrl}/` }),
      }),
    )
    const setCookies = res.headers.getSetCookie()
    const { url } = (await res.json()) as { url: string }
    return {
      state: new URL(url).searchParams.get('state') as string,
      cookie: setCookies.map((c) => c.split(';')[0]).join('; '),
      setCookies,
    }
  }

  const callback = (state: string, headers: Record<string, string> = {}) =>
    handle(
      new Request(`http://localhost:8000/v1/api/auth/sso/callback/sso?code=test-code&state=${state}`, {
        headers,
        redirect: 'manual',
      }),
    )

  it('lets the callback through when the browser returns the state cookie', async () => {
    const flow = await startFlow()
    const before = tokenRequests

    await callback(flow.state, { cookie: flow.cookie })

    expect(tokenRequests).toBe(before + 1)
  })

  it('rejects a callback that arrives without the state cookie', async () => {
    // A cross-site deployment drops the cookie here. Failing is correct: the
    // cookie is the only thing tying this callback to the browser that started
    // the flow.
    const flow = await startFlow()
    const before = tokenRequests

    const res = await callback(flow.state)

    expect(tokenRequests).toBe(before)
    expect(res.headers.get('location')).toBe(`${appUrl}/auth-error?error=state_mismatch`)
  })

  it('rejects an attacker-supplied state replayed in a victim browser', async () => {
    // Login CSRF: the attacker starts their own flow and hands the victim the
    // resulting callback URL. The victim's browser carries its own state cookie,
    // which must not validate the attacker's state.
    const attacker = await startFlow()
    const victim = await startFlow()
    const before = tokenRequests

    const res = await callback(attacker.state, { cookie: victim.cookie })

    expect(tokenRequests).toBe(before)
    expect(res.headers.get('location')).toBe(`${appUrl}/auth-error?error=state_mismatch`)
  })

  it('consumes the state so a callback cannot be replayed', async () => {
    const flow = await startFlow()
    await callback(flow.state, { cookie: flow.cookie })
    const before = tokenRequests

    const res = await callback(flow.state, { cookie: flow.cookie })

    expect(tokenRequests).toBe(before)
    expect(res.headers.get('location')).toBe(`${appUrl}/auth-error?error=please_restart_the_process`)
  })

  it('sends every failure to the app rather than the API origin', async () => {
    const flow = await startFlow()

    const res = await callback(flow.state)

    // Without onAPIError.errorURL this lands on `${BETTER_AUTH_URL}/error`, which
    // serves no HTML.
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toStartWith(`${appUrl}/auth-error?`)
  })

  it('issues the state cookie as SameSite=Lax', async () => {
    // Why APP_URL and BETTER_AUTH_URL have to stay same-site: a Lax cookie is
    // neither set nor sent across sites, so a cross-site split breaks the flow
    // above. See docs/self-hosting/configuration.md.
    const flow = await startFlow()

    const stateCookie = flow.setCookies.find((c) => c.includes('better-auth.state'))
    expect(stateCookie).toContain('SameSite=Lax')
    expect(stateCookie).toContain('HttpOnly')
  })
})
