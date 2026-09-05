/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { APIError } from 'better-auth'
import { jwtVerify } from 'jose'
import type { Auth } from '@/auth/elysia-plugin'
import { getMiniApps, toPublicMiniApps } from '@/config/settings'
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

/** Better Auth throws for a rejected credential rather than returning null —
 *  a stray `x-api-key` trips its before-hook. */
const authThatRejectsCredentials = (): Auth =>
  ({
    api: {
      getSession: async () => {
        throw new APIError('UNAUTHORIZED', { message: 'Invalid API key' })
      },
    },
  }) as unknown as Auth

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

describe('toPublicMiniApps', () => {
  const published = () => toPublicMiniApps(getMiniApps({ miniApps: registry }))

  it('never includes the signing secret', () => {
    const serialised = JSON.stringify(published())
    expect(serialised).not.toContain(financeSecret)
    expect(serialised).not.toContain(journeysSecret)
  })

  it('carries the id alongside the presentation fields', () => {
    expect(published()[0]).toMatchObject({
      id: 'finance-model',
      name: 'Finance Model',
      origin: 'http://localhost:5174',
    })
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

  /**
   * A credential Better Auth rejects must read as unauthenticated, not as a
   * server fault. Calling `getSession` directly let the thrown `APIError` reach
   * the error handler, which reports a 500 — so a client with a stale key was
   * told the backend was broken.
   */
  it('answers 401 when the credential is rejected, not 500', async () => {
    const response = await post(authThatRejectsCredentials(), 'finance-model')

    expect(response.status).toBe(401)
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
  /**
   * The route is unauthenticated, so anything it recomputes per request is
   * something an anonymous caller can drive. It used to re-parse `MINI_APPS` and
   * re-log every malformed entry on each call, turning a startup diagnostic into
   * unbounded log volume; the registry is parsed once at construction instead.
   */
  it('parses the registry once, not per request', async () => {
    const withBadEntry = JSON.stringify({
      good: { name: 'Good', origin: 'https://good.test', secret: financeSecret },
      bad: { name: 'Bad', origin: 'https://bad.test', secret: 'tooshort' },
    })
    const dropped: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => dropped.push(args)

    try {
      const routes = createMiniAppRoutes(
        authWithUser(realUser),
        createTestSettings({ miniApps: withBadEntry, appUrl: 'http://localhost:1420' }),
      )
      const atConstruction = dropped.length

      await routes.handle(new Request('http://localhost/mini-apps'))
      await routes.handle(new Request('http://localhost/mini-apps'))

      expect(atConstruction).toBe(1)
      expect(dropped).toHaveLength(atConstruction)
    } finally {
      console.error = original
    }
  })

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

  /**
   * The registry carries no secret, so it is unauthenticated — and it has to
   * answer these callers rather than 403 them, or the client has no terminal
   * state to render and `/apps/:id` hangs on `loading` forever.
   */
  it('answers an unauthenticated caller', async () => {
    const response = await get(authWithUser(null))
    const body = (await response.json()) as { apps: { id: string }[] }

    expect(response.status).toBe(200)
    expect(body.apps.map((app) => app.id)).toEqual(['finance-model', 'patient-journeys'])
  })

  it('answers an anonymous session, unlike the token route', async () => {
    const anonymous = { ...realUser, isAnonymous: true }

    expect((await get(authWithUser(anonymous))).status).toBe(200)
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
