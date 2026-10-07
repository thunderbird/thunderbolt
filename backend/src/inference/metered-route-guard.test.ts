/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { cliRegistrationPendingDeviceId } from '@/dal/sessions'
import { mockAuth, mockAuthUnauthenticated } from '@/test-utils/mock-auth'
import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { createMeteredRouteGuard, type MeteredRouteGuardOptions } from './metered-route-guard'
import type { InferenceDatabase } from './usage-ledger'

const pendingCliAuth = {
  api: {
    getSession: async () => ({ user: { id: 'cli-user' }, session: { deviceId: cliRegistrationPendingDeviceId } }),
  },
} as unknown as Auth

/** A user rate limit shaped like `createUserTierRateLimit`'s, recording the user each spent point belongs to. */
const createRecordingRateLimit = () => {
  const rateLimitedUsers: string[] = []
  const rateLimit = new Elysia()
    .onBeforeHandle((ctx) => {
      rateLimitedUsers.push((ctx as { user?: { id: string } }).user?.id ?? 'none')
    })
    .as('scoped')
  return { rateLimit, rateLimitedUsers }
}

/** A route group with an unguarded route before the guard and a metered route after it. */
const createRouteGroup = (prefix: string, options: MeteredRouteGuardOptions) =>
  new Elysia({ prefix })
    .get('/open', () => 'open')
    .use(createMeteredRouteGuard(options))
    .get('/metered', ({ user }) => user.id)

/** Mount one guarded group and a sibling route; record what the rate limit saw. */
const createApp = (options: Partial<MeteredRouteGuardOptions> = {}) => {
  const { rateLimit, rateLimitedUsers } = createRecordingRateLimit()
  const routes = createRouteGroup('/routes', {
    auth: mockAuth,
    database: {} as InferenceDatabase,
    cliDeviceRegistrationEnabled: false,
    rateLimit,
    ...options,
  })
  const app = new Elysia().use(routes).get('/sibling', () => 'sibling')
  const get = (path: string, headers?: HeadersInit) => app.handle(new Request(`http://localhost${path}`, { headers }))
  return { get, rateLimitedUsers }
}

describe('createMeteredRouteGuard', () => {
  it('resolves the user for the route and the rate limit', async () => {
    const { get, rateLimitedUsers } = createApp()
    const response = await get('/routes/metered')
    expect(await response.text()).toBe('test-user')
    expect(rateLimitedUsers).toEqual(['test-user'])
  })

  it('requires a session', async () => {
    const { get, rateLimitedUsers } = createApp({ auth: mockAuthUnauthenticated })
    expect((await get('/routes/metered')).status).toBe(401)
    expect(rateLimitedUsers).toEqual([])
  })

  it('rejects an unbound CLI session before the rate limit spends a point', async () => {
    const { get, rateLimitedUsers } = createApp({ auth: pendingCliAuth, cliDeviceRegistrationEnabled: true })
    const response = await get('/routes/metered')
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ code: 'CLI_DEVICE_NOT_BOUND' })
    expect(rateLimitedUsers).toEqual([])
  })

  it('leaves routes registered before it and sibling apps unguarded', async () => {
    const { get, rateLimitedUsers } = createApp({ auth: mockAuthUnauthenticated })
    expect(await (await get('/routes/open')).text()).toBe('open')
    expect(await (await get('/sibling')).text()).toBe('sibling')
    expect(rateLimitedUsers).toEqual([])
  })

  it('works without a rate limit', async () => {
    const { get } = createApp({ rateLimit: undefined })
    expect(await (await get('/routes/metered')).text()).toBe('test-user')
  })

  it('rejects a personal access token on a confidential route before the rate limit spends a point', async () => {
    const { get, rateLimitedUsers } = createApp({ confidentialApiKeysEnabled: false })
    const response = await get('/routes/metered', { 'x-api-key': 'pat' })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: { code: 'WEB_LOGIN_REQUIRED' } })
    expect(rateLimitedUsers).toEqual([])
  })

  it.each([
    ['a direct route, where the step is off', undefined],
    ['a confidential route that allows PATs', true],
  ])('admits a personal access token on %s', async (_label, confidentialApiKeysEnabled) => {
    const { get } = createApp({ confidentialApiKeysEnabled })
    expect(await (await get('/routes/metered', { 'x-api-key': 'pat' })).text()).toBe('test-user')
  })

  it.each([undefined, false])(
    'leaves the request body unread for the handler (confidentialApiKeysEnabled: %p)',
    async (confidentialApiKeysEnabled) => {
      const app = new Elysia({ prefix: '/routes' })
        .use(
          createMeteredRouteGuard({
            auth: mockAuth,
            database: {} as InferenceDatabase,
            cliDeviceRegistrationEnabled: true,
            confidentialApiKeysEnabled,
          }),
        )
        // No `parse: 'none'`, like `/v1/chat`: the handler reads the raw request itself.
        .post('/metered', async ({ request }) => request.json())
      const response = await app.handle(
        new Request('http://localhost/routes/metered', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ a: 1 }),
        }),
      )
      expect(await response.json()).toEqual({ a: 1 })
    },
  )
})

describe('createMeteredRouteGuard on two groups sharing one rate limit, as createApp mounts them', () => {
  const createSharedApp = (auth: Auth, cliDeviceRegistrationEnabled = false) => {
    const { rateLimit, rateLimitedUsers } = createRecordingRateLimit()
    const options = { auth, database: {} as InferenceDatabase, cliDeviceRegistrationEnabled, rateLimit }
    const app = new Elysia()
      .use(createRouteGroup('/chat', options))
      .use(createRouteGroup('/agent', options))
      .get('/sibling', () => 'sibling')
    const get = (path: string) => app.handle(new Request(`http://localhost${path}`))
    return { get, rateLimitedUsers }
  }

  it('spends exactly one point per request on each group, for the resolved user', async () => {
    const { get, rateLimitedUsers } = createSharedApp(mockAuth)
    expect(await (await get('/chat/metered')).text()).toBe('test-user')
    expect(rateLimitedUsers).toEqual(['test-user'])
    expect(await (await get('/agent/metered')).text()).toBe('test-user')
    expect(rateLimitedUsers).toEqual(['test-user', 'test-user'])
  })

  it('runs the CLI check on each group after the user is resolved', async () => {
    // The check destructures the resolved session; run before the macro it would throw and answer 500.
    const { get, rateLimitedUsers } = createSharedApp(pendingCliAuth, true)
    for (const path of ['/chat/metered', '/agent/metered']) {
      const response = await get(path)
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ code: 'CLI_DEVICE_NOT_BOUND' })
    }
    expect(rateLimitedUsers).toEqual([])
  })

  it('leaves the sibling route and the routes before each guard unguarded', async () => {
    const { get, rateLimitedUsers } = createSharedApp(mockAuthUnauthenticated)
    expect(await (await get('/sibling')).text()).toBe('sibling')
    expect(await (await get('/chat/open')).text()).toBe('open')
    expect(await (await get('/agent/open')).text()).toBe('open')
    expect((await get('/agent/metered')).status).toBe(401)
    expect(rateLimitedUsers).toEqual([])
  })
})
