/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { apikey } from '@/db/auth-schema'
import { authHeaders, createTestApp, type TestAppHandle } from '@/test-utils/e2e'
import { eq } from 'drizzle-orm'

const authBase = 'http://localhost/v1/api/auth'
const clientId = 'thunderbolt-cli'

const postJson = (app: TestAppHandle['app'], path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.handle(
    new Request(`${authBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  )

const getSession = (app: TestAppHandle['app'], headers: Record<string, string>) =>
  app.handle(new Request(`${authBase}/get-session`, { headers }))

const deviceTokenBody = (deviceCode: string) => ({
  grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  device_code: deviceCode,
  client_id: clientId,
})

type DeviceCodeResponse = {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

type ApiKeyResponse = {
  id: string
  key: string
  expiresAt: string | null
}

describe('Device Authorization Grant (RFC 8628)', () => {
  let harness: TestAppHandle

  beforeEach(async () => {
    harness = await createTestApp()
  })

  afterEach(async () => {
    await harness.cleanup()
  })

  const requestDeviceCode = async (): Promise<DeviceCodeResponse> => {
    const res = await postJson(harness.app, '/device/code', { client_id: clientId })
    expect(res.status).toBe(200)
    return (await res.json()) as DeviceCodeResponse
  }

  it('issues device + user codes pointing at the frontend /device page with an RFC-8628 polling interval', async () => {
    const body = await requestDeviceCode()

    expect(body.device_code).toBeTruthy()
    expect(body.user_code).toBeTruthy()
    // verificationUri is derived from appUrl (self-hostable, no hardcoded host).
    expect(body.verification_uri).toBe('http://localhost:1420/device')
    expect(body.verification_uri_complete).toBe(`http://localhost:1420/device?user_code=${body.user_code}`)
    expect(body.interval).toBe(5)
    expect(body.expires_in).toBe(1800)
  })

  it('returns authorization_pending while the user has not approved yet', async () => {
    const { device_code: deviceCode } = await requestDeviceCode()

    const pendingRes = await postJson(harness.app, '/device/token', deviceTokenBody(deviceCode))
    expect(pendingRes.status).toBe(400)
    expect(((await pendingRes.json()) as { error: string }).error).toBe('authorization_pending')
  })

  it('exposes an approved device credential that authenticates protected routes as the approving account', async () => {
    const { device_code: deviceCode, user_code: userCode } = await requestDeviceCode()

    const approveRes = await postJson(harness.app, '/device/approve', { userCode }, authHeaders(harness.bearerToken))
    expect(approveRes.status).toBe(200)

    const tokenRes = await postJson(harness.app, '/device/token', deviceTokenBody(deviceCode))
    expect(tokenRes.status).toBe(200)
    const granted = (await tokenRes.json()) as { access_token: string; token_type: string }
    expect(granted.token_type).toBe('Bearer')
    expect(granted.access_token).toBeTruthy()

    const bearerToken = tokenRes.headers.get('set-auth-token')
    expect(bearerToken).toBeTruthy()
    expect(bearerToken).not.toBe(granted.access_token)
    expect(tokenRes.headers.get('set-cookie')).toBeNull()
    expect(tokenRes.headers.get('access-control-expose-headers')?.toLowerCase()).toContain('set-auth-token')

    const rawTokenRes = await harness.app.handle(
      new Request('http://localhost/v1/devices/allowlist', { headers: authHeaders(granted.access_token) }),
    )
    expect(rawTokenRes.status).toBe(401)

    if (!bearerToken) {
      throw new Error('approved device response did not expose a bearer token')
    }

    const sessionRes = await getSession(harness.app, authHeaders(bearerToken))
    expect(sessionRes.status).toBe(200)
    const session = (await sessionRes.json()) as { user: { email: string } } | null
    expect(session?.user.email).toBe(harness.email)

    const allowlistRes = await harness.app.handle(
      new Request('http://localhost/v1/devices/allowlist', { headers: authHeaders(bearerToken) }),
    )
    expect(allowlistRes.status).toBe(200)
  })

  it('rejects device approval from an unauthenticated caller', async () => {
    const { user_code: userCode } = await requestDeviceCode()
    const res = await postJson(harness.app, '/device/approve', { userCode })
    expect(res.status).toBe(401)
  })
})

describe('API key authentication', () => {
  let harness: TestAppHandle

  beforeEach(async () => {
    harness = await createTestApp()
  })

  afterEach(async () => {
    await harness.cleanup()
  })

  /** Create an API key owned by the harness user through Better Auth's public endpoint. */
  const createApiKey = async (): Promise<ApiKeyResponse> => {
    const res = await postJson(harness.app, '/api-key/create', {}, authHeaders(harness.bearerToken))
    expect(res.status).toBe(200)
    return (await res.json()) as ApiKeyResponse
  }

  /** Assert a rejected API key produces a generic protected-route response. */
  const expectApiKeyRejected = async (key: string): Promise<void> => {
    const res = await harness.app.handle(
      new Request('http://localhost/v1/devices/allowlist', { headers: { 'x-api-key': key } }),
    )
    const body = await res.text()

    expect(res.status).toBe(401)
    expect(body.toLowerCase()).not.toContain('api key')
  }

  it('authenticates as the owning account when the key is sent via x-api-key', async () => {
    const { key } = await createApiKey()
    expect(key).toBeTruthy()

    const sessionRes = await getSession(harness.app, { 'x-api-key': key })
    expect(sessionRes.status).toBe(200)
    const session = (await sessionRes.json()) as { user: { email: string } } | null
    expect(session?.user.email).toBe(harness.email)
  })

  it('expires newly created api keys after the configured default lifetime', async () => {
    const beforeCreation = Date.now()
    const { expiresAt } = await createApiKey()

    expect(expiresAt).not.toBeNull()
    const expectedExpiry = beforeCreation + 90 * 24 * 60 * 60 * 1000
    expect(Math.abs(new Date(expiresAt!).getTime() - expectedExpiry)).toBeLessThan(5_000)
  })

  it('rejects an unknown api key', async () => {
    const res = await getSession(harness.app, { 'x-api-key': 'not-a-real-key' })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_API_KEY')
  })

  it('returns 401 from protected routes for an unknown api key', async () => {
    await expectApiKeyRejected('not-a-real-key')
  })

  it('returns 200 from protected routes for a valid api key', async () => {
    const { key } = await createApiKey()
    const res = await harness.app.handle(
      new Request('http://localhost/v1/devices/allowlist', { headers: { 'x-api-key': key } }),
    )

    expect(res.status).toBe(200)
  })

  it('returns 401 from protected routes for an expired api key', async () => {
    const { id, key } = await createApiKey()
    await harness.db
      .update(apikey)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(apikey.id, id))

    await expectApiKeyRejected(key)
  })

  it('returns 401 from protected routes for a deleted api key', async () => {
    const { id, key } = await createApiKey()
    const deleteRes = await postJson(harness.app, '/api-key/delete', { keyId: id }, authHeaders(harness.bearerToken))
    expect(deleteRes.status).toBe(200)

    await expectApiKeyRejected(key)
  })

  it('does not throttle a key to the plugin default of 10 requests/day', async () => {
    const { key } = await createApiKey()

    // 12 > the plugin's default maxRequests (10) — all must succeed since per-key
    // rate limiting is disabled for headless CI/self-host use.
    for (const _ of Array.from({ length: 12 })) {
      const res = await getSession(harness.app, { 'x-api-key': key })
      expect(res.status).toBe(200)
      const session = (await res.json()) as { user: { email: string } } | null
      expect(session?.user.email).toBe(harness.email)
    }
  })
})
