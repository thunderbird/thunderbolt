/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { jwtVerify } from 'jose'
import type { Auth } from '@/auth/elysia-plugin'
import { getMiniApps, getPublicMiniApps } from '@/config/settings'
import { createTestSettings } from '@/test-utils/settings'
import { createMiniAppRoutes } from './mini-apps'

const financeSecret = 'finance-model-test-secret-32-chars'
const journeysSecret = 'patient-journeys-test-secret-32ch'

const registry = JSON.stringify({
  'finance-model': { name: 'Finance Model', origin: 'http://localhost:5174', secret: financeSecret },
  'patient-journeys': {
    name: 'Patient Journeys',
    description: 'Disease-by-disease maps.',
    icon: 'route',
    origin: 'http://localhost:5180',
    url: 'http://localhost:5180/dashboard',
    secret: journeysSecret,
  },
})

const settings = createTestSettings({
  miniApps: registry,
  appUrl: 'http://localhost:1420',
  corsOrigins: 'http://localhost:1420',
})

/** Minimal Auth stand-in: only `getSession` is reached by these routes. */
const authWithUser = (user: unknown): Auth =>
  ({ api: { getSession: async () => (user ? { user } : null) } }) as unknown as Auth

const realUser = { id: 'user-1', email: 'demo@example.com', name: 'Demo User', isAnonymous: false }

const get = (auth: Auth) => createMiniAppRoutes(auth, settings).handle(new Request('http://localhost/mini-apps'))

const post = (auth: Auth, appId: string, origin = 'http://localhost:1420') =>
  createMiniAppRoutes(auth, settings).handle(
    new Request(`http://localhost/mini-apps/${appId}/token`, { method: 'POST', headers: { origin } }),
  )

describe('getMiniApps', () => {
  it('parses configured apps', () => {
    expect([...getMiniApps({ miniApps: registry }).keys()]).toEqual(['finance-model', 'patient-journeys'])
  })

  it('defaults url to origin, so operators need not repeat it', () => {
    expect(getMiniApps({ miniApps: registry }).get('finance-model')?.url).toBe('http://localhost:5174')
  })

  it('returns nothing for malformed JSON rather than throwing', () => {
    expect(getMiniApps({ miniApps: '{ not json' }).size).toBe(0)
  })

  it('drops entries with a short secret, so a weak key cannot sign', () => {
    const weak = JSON.stringify({ app: { name: 'A', origin: 'https://a.test', secret: 'tooshort' } })
    expect(getMiniApps({ miniApps: weak }).size).toBe(0)
  })

  /** An origin reaches `<iframe src>`, where a `javascript:` URL executes in
   *  our page rather than in a frame. */
  it('refuses a javascript: origin', () => {
    const hostile = JSON.stringify({ app: { name: 'A', origin: 'javascript:alert(1)', secret: financeSecret } })
    expect(getMiniApps({ miniApps: hostile }).size).toBe(0)
  })

  it('refuses a javascript: url even behind a good origin', () => {
    const hostile = JSON.stringify({
      app: { name: 'A', origin: 'https://a.test', url: 'javascript:alert(1)', secret: financeSecret },
    })
    expect(getMiniApps({ miniApps: hostile }).size).toBe(0)
  })

  /**
   * `event.origin` never carries a path or trailing slash, and the bridge
   * compares the two with `===` — so an unnormalised trailing slash produced an
   * app that loaded and then ignored every message it sent.
   */
  it('normalises an origin to what the browser will actually report', () => {
    const trailing = JSON.stringify({ app: { name: 'A', origin: 'https://a.test/', secret: financeSecret } })
    expect(getMiniApps({ miniApps: trailing }).get('app')?.origin).toBe('https://a.test')
  })

  /** The whole record used to be parsed at once, so one typo emptied the
   *  registry and every app disappeared together. */
  it('keeps the good apps when one entry is malformed', () => {
    const mixed = JSON.stringify({
      good: { name: 'Good', origin: 'https://good.test', secret: financeSecret },
      broken: { name: 'Broken', origin: 'https://broken.test', secret: 'tooshort' },
    })
    expect([...getMiniApps({ miniApps: mixed }).keys()]).toEqual(['good'])
  })

  it('registers nothing when the payload is not an object of apps', () => {
    expect(getMiniApps({ miniApps: '[]' }).size).toBe(0)
  })
})

describe('getPublicMiniApps', () => {
  it('never includes the signing secret', () => {
    const published = JSON.stringify(getPublicMiniApps({ miniApps: registry }))
    expect(published).not.toContain(financeSecret)
    expect(published).not.toContain('secret')
  })

  it('carries the id alongside the presentation fields', () => {
    const [first] = getPublicMiniApps({ miniApps: registry })
    expect(first).toMatchObject({ id: 'finance-model', name: 'Finance Model', origin: 'http://localhost:5174' })
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

  /**
   * The registry used to be a plain object, so an id off the URL that named an
   * `Object.prototype` member resolved to an inherited function — truthy, so the
   * 404 guard never fired and the route went on to sign a token with an
   * `undefined` audience and an empty HMAC key.
   */
  it.each(['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'])(
    '404s the prototype key %p rather than signing with an inherited value',
    async (appId) => {
      expect((await post(authWithUser(realUser), appId)).status).toBe(404)
    },
  )

  it('rejects a request from an origin that is not allowed', async () => {
    expect((await post(authWithUser(realUser), 'finance-model', 'https://evil.test')).status).toBe(403)
  })

  it('404s every app id when no apps are configured', async () => {
    const routes = createMiniAppRoutes(authWithUser(realUser), createTestSettings({ miniApps: '' }))
    const response = await routes.handle(
      new Request('http://localhost/mini-apps/finance-model/token', { method: 'POST' }),
    )
    expect(response.status).toBe(404)
  })
})

describe('GET /mini-apps', () => {
  it('lists the configured apps for a signed-in user', async () => {
    const response = await get(authWithUser(realUser))
    const body = (await response.json()) as { apps: { id: string }[] }

    expect(response.status).toBe(200)
    expect(body.apps.map((app) => app.id)).toEqual(['finance-model', 'patient-journeys'])
  })

  it('never puts a signing secret on the wire', async () => {
    const response = await get(authWithUser(realUser))

    expect(await response.text()).not.toContain(financeSecret)
  })

  it('rejects an unauthenticated caller', async () => {
    expect((await get(authWithUser(null))).status).toBe(401)
  })

  /**
   * An anonymous session is still a session, so a `!user` check alone let it
   * through — which this route's own comment said it should not. Which apps a
   * deployment runs is not quite a secret, but it isn't public either.
   */
  it('refuses anonymous users, matching the token route', async () => {
    const anonymous = { ...realUser, isAnonymous: true }

    expect((await get(authWithUser(anonymous))).status).toBe(403)
  })

  /**
   * A deployment that runs no apps must answer, not 404. The client cannot tell
   * a 404 from a network failure, so an unmounted route made "this deployment
   * runs no apps" render as "Couldn't load your apps. Check your connection."
   */
  it('answers with an empty registry rather than 404 when no apps are configured', async () => {
    const routes = createMiniAppRoutes(authWithUser(realUser), createTestSettings({ miniApps: '' }))
    const response = await routes.handle(new Request('http://localhost/mini-apps'))
    const body = (await response.json()) as { apps: unknown[] }

    expect(response.status).toBe(200)
    expect(body.apps).toEqual([])
  })
})
