/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, describe, expect, it } from 'bun:test'
import { createHash, createHmac } from 'crypto'
import { Elysia } from 'elysia'
import { createTestSettings } from '@/test-utils/settings'
import { getSharedIsolatedTestDb } from '@/test-utils/db'
import { account as accountTable, session as sessionTable, user as userTable } from '@/db/auth-schema'
import { createSsoNativeCallbackRoutes } from './sso-native-callback'

const state = 's'.repeat(43)
const verifier = 'v'.repeat(43)
const challenge = createHash('sha256').update(verifier).digest('base64url')
const settings = createTestSettings({
  authMode: 'oidc',
  betterAuthUrl: 'https://api.example.test',
  betterAuthSecret: 'test-sso-secret',
})
const callbackBinding = (nonce: string) =>
  createHmac('sha256', settings.betterAuthSecret)
    .update(JSON.stringify([nonce, state, challenge]))
    .digest('base64url')

describe('native SSO callback', () => {
  const database = getSharedIsolatedTestDb()
  const app = database.then(({ db }) =>
    new Elysia({ prefix: '/v1' }).use(
      createSsoNativeCallbackRoutes(settings, db, (async () =>
        Response.json(
          { url: 'https://idp.example.test/authorize' },
          { headers: { 'set-cookie': 'better-auth.state=oauth; HttpOnly' } },
        )) as unknown as typeof fetch),
    ),
  )

  afterAll(async () => {
    await database
  })

  const insertSession = async () => {
    const { db } = await database
    const userId = crypto.randomUUID()
    const rawToken = crypto.randomUUID()
    const now = new Date()
    await db.insert(userTable).values({ id: userId, email: `${userId}@example.test`, name: 'SSO user' })
    await db.insert(sessionTable).values({
      id: crypto.randomUUID(),
      token: rawToken,
      userId,
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      updatedAt: now,
    })
    await db.insert(accountTable).values({
      id: crypto.randomUUID(),
      accountId: `sso-${userId}`,
      providerId: 'sso',
      userId,
    })
    const signedToken = `${rawToken}.${createHmac('sha256', settings.betterAuthSecret).update(rawToken).digest('base64')}`
    return { rawToken, signedToken }
  }

  const start = async () => {
    const instance = await app
    const response = await instance.handle(
      new Request(
        `https://api.example.test/v1/api/auth/sso/native-initiate?state=${state}&code_challenge=${challenge}`,
      ),
    )
    expect(response.status).toBe(302)
    const nonceCookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith('thunderbolt_native_sso_nonce='))!
    const nonce = nonceCookie.split(';')[0].split('=')[1]
    const { signedToken } = await insertSession()
    const callback = new URL(
      `https://api.example.test/v1/api/auth/sso/native-callback?state=${state}&code_challenge=${challenge}&callback_state=${callbackBinding(nonce)}`,
    )
    const callbackResponse = await instance.handle(
      new Request(callback, {
        headers: {
          cookie: `${nonceCookie.split(';')[0]}; better-auth.session_token=${encodeURIComponent(signedToken)}`,
        },
      }),
    )
    expect(callbackResponse.status).toBe(302)
    const location = new URL(callbackResponse.headers.get('location')!)
    expect(location.protocol).toBe('net.thunderbird.thunderbolt.native:')
    expect(location.host).toBe('sso-callback')
    expect(location.searchParams.get('state')).toBe(state)
    expect(location.searchParams.get('token')).toBeNull()
    return { instance, location }
  }

  it('issues a one-use PKCE code and returns the signed token only to one concurrent redemption', async () => {
    const { instance, location } = await start()
    const redeem = () =>
      instance.handle(
        new Request('https://api.example.test/v1/api/auth/sso/native-token', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: location.searchParams.get('code'), state, code_verifier: verifier }),
        }),
      )
    const responses = await Promise.all([redeem(), redeem()])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401])
    const successfulResponse = responses.find((response) => response.status === 200)!
    expect(await successfulResponse.json()).toMatchObject({ token: expect.stringContaining('.') })
    expect(successfulResponse.headers.get('cache-control')).toBe('no-store')
    expect(successfulResponse.headers.get('pragma')).toBe('no-cache')
  })

  it('rejects a callback without the initiating browser nonce', async () => {
    const { instance } = await start()
    const response = await instance.handle(
      new Request(
        `https://api.example.test/v1/api/auth/sso/native-callback?state=${state}&code_challenge=${challenge}&callback_state=${callbackBinding('wrong')}`,
      ),
    )
    expect(response.status).toBe(403)
  })

  it('rejects a code redeemed with a different PKCE verifier', async () => {
    const { instance, location } = await start()
    const response = await instance.handle(
      new Request('https://api.example.test/v1/api/auth/sso/native-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: location.searchParams.get('code'), state, code_verifier: 'x'.repeat(43) }),
      }),
    )
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'invalid_or_expired_code' })
  })

  it('does not exchange an unchanged browser session from before the SSO attempt', async () => {
    const instance = await app
    const { signedToken } = await insertSession()
    const startResponse = await instance.handle(
      new Request(
        `https://api.example.test/v1/api/auth/sso/native-initiate?state=${state}&code_challenge=${challenge}`,
        { headers: { cookie: `better-auth.session_token=${encodeURIComponent(signedToken)}` } },
      ),
    )
    const nonceCookie = startResponse.headers
      .getSetCookie()
      .find((value) => value.startsWith('thunderbolt_native_sso_nonce='))!
    const nonce = nonceCookie.split(';')[0].split('=')[1]
    const callback = await instance.handle(
      new Request(
        `https://api.example.test/v1/api/auth/sso/native-callback?state=${state}&code_challenge=${challenge}&callback_state=${callbackBinding(nonce)}`,
        {
          headers: {
            cookie: `${nonceCookie.split(';')[0]}; better-auth.session_token=${encodeURIComponent(signedToken)}`,
          },
        },
      ),
    )

    const location = new URL(callback.headers.get('location')!)
    expect(location.searchParams.get('error')).toBe('session_not_created')
    expect(location.searchParams.has('code')).toBe(false)
  })

  it('does not expose native SSO routes in consumer mode', async () => {
    const { db } = await database
    const consumerApp = new Elysia({ prefix: '/v1' }).use(
      createSsoNativeCallbackRoutes(createTestSettings({ authMode: 'consumer' }), db),
    )
    const response = await consumerApp.handle(
      new Request('https://api.example.test/v1/api/auth/sso/native-initiate?state=x&code_challenge=y'),
    )
    expect(response.status).toBe(404)
  })
})
