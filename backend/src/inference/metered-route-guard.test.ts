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

/** Mount a guarded route, an unguarded route before it, and a sibling app; record what the rate limit saw. */
const createApp = (options: Partial<MeteredRouteGuardOptions> = {}) => {
  const rateLimitedUsers: string[] = []
  const rateLimit = new Elysia()
    .onBeforeHandle((ctx) => {
      rateLimitedUsers.push((ctx as { user?: { id: string } }).user?.id ?? 'none')
    })
    .as('scoped')
  const routes = new Elysia({ prefix: '/routes' })
    .get('/open', () => 'open')
    .use(
      createMeteredRouteGuard({
        auth: mockAuth,
        database: {} as InferenceDatabase,
        cliDeviceRegistrationEnabled: false,
        rateLimit,
        ...options,
      }),
    )
    .get('/metered', ({ user }) => user.id)
  const app = new Elysia().use(routes).get('/sibling', () => 'sibling')
  const get = (path: string) => app.handle(new Request(`http://localhost${path}`))
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
})
