/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { jwtVerify } from 'jose'
import type { Auth } from '@/auth/elysia-plugin'
import { getMiniAppAudiences } from '@/config/settings'
import { createTestSettings } from '@/test-utils/settings'
import { createMiniAppRoutes } from './mini-apps'

const financeSecret = 'finance-model-test-secret-32-chars'
const journeysSecret = 'patient-journeys-test-secret-32ch'

const audiences = JSON.stringify({
  'finance-model': { origin: 'http://localhost:5174', secret: financeSecret },
  'patient-journeys': { origin: 'http://localhost:5180', secret: journeysSecret },
})

const settings = createTestSettings({
  miniAppAudiences: audiences,
  appUrl: 'http://localhost:1420',
  corsOrigins: 'http://localhost:1420',
})

/** Minimal Auth stand-in: only `getSession` is reached by these routes. */
const authWithUser = (user: unknown): Auth =>
  ({ api: { getSession: async () => (user ? { user } : null) } }) as unknown as Auth

const realUser = { id: 'user-1', email: 'demo@example.com', name: 'Demo User', isAnonymous: false }

const post = (auth: Auth, appId: string, origin = 'http://localhost:1420') =>
  createMiniAppRoutes(auth, settings).handle(
    new Request(`http://localhost/mini-apps/${appId}/token`, { method: 'POST', headers: { origin } }),
  )

describe('getMiniAppAudiences', () => {
  it('parses configured apps', () => {
    expect(Object.keys(getMiniAppAudiences({ miniAppAudiences: audiences }))).toEqual([
      'finance-model',
      'patient-journeys',
    ])
  })

  it('returns nothing for malformed JSON rather than throwing', () => {
    expect(getMiniAppAudiences({ miniAppAudiences: '{ not json' })).toEqual({})
  })

  it('drops entries with a short secret, so a weak key cannot sign', () => {
    const weak = JSON.stringify({ app: { origin: 'https://a.test', secret: 'tooshort' } })
    expect(getMiniAppAudiences({ miniAppAudiences: weak })).toEqual({})
  })
})

describe('POST /mini-apps/:appId/token', () => {
  it('mints a token scoped to the app it was requested for', async () => {
    const response = await post(authWithUser(realUser), 'finance-model')
    expect(response.status).toBe(200)

    const body = (await response.json()) as { token: string; expiresAt: string }
    const { payload } = await jwtVerify(body.token, new TextEncoder().encode(financeSecret))

    expect(payload.aud).toBe('http://localhost:5174')
    expect(payload.iss).toBe('http://localhost:1420')
    expect(payload.sub).toBe('user-1')
    expect(payload.email).toBe('demo@example.com')
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  /**
   * The reason secrets are per app rather than shared: a token minted for one
   * app must be worthless to another even if it gets there.
   */
  it("cannot be verified with another app's secret", async () => {
    const response = await post(authWithUser(realUser), 'finance-model')
    const { token } = (await response.json()) as { token: string }

    await expect(jwtVerify(token, new TextEncoder().encode(journeysSecret))).rejects.toThrow()
  })

  it('rejects an unauthenticated caller', async () => {
    expect((await post(authWithUser(null), 'finance-model')).status).toBe(401)
  })

  it('refuses anonymous users, whose identity would not mean anything', async () => {
    const anonymous = { ...realUser, isAnonymous: true }
    expect((await post(authWithUser(anonymous), 'finance-model')).status).toBe(403)
  })

  it('404s an unknown app rather than revealing which ids exist', async () => {
    expect((await post(authWithUser(realUser), 'not-an-app')).status).toBe(404)
  })

  it('rejects a request from an origin that is not allowed', async () => {
    expect((await post(authWithUser(realUser), 'finance-model', 'https://evil.test')).status).toBe(403)
  })

  it('mounts nothing when no apps are configured', async () => {
    const routes = createMiniAppRoutes(authWithUser(realUser), createTestSettings({ miniAppAudiences: '' }))
    const response = await routes.handle(
      new Request('http://localhost/mini-apps/finance-model/token', { method: 'POST' }),
    )
    expect(response.status).toBe(404)
  })
})
