/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createBetterAuthPlugin } from '@/auth/elysia-plugin'
import { clearSettingsCache } from '@/config/settings'
import { createApp } from '@/index'
import { getSharedIsolatedTestDb } from '@/test-utils/db'
import { insertTestUsers } from '@/test-utils/identity'
import { createScimClient, keycloakUser, scimUserSchema, uniqueSuffix } from '@/test-utils/scim'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createScimConnection } from './connections'

const env = { MIN_APP_VERSION: '99.0.0', RATE_LIMIT_ENABLED: 'true', TRUSTED_PROXY: '' }

/** SCIM behind the whole `createApp` stack: the app-version gate and every rate limit on. */
describe('SCIM through createApp', () => {
  let saved: Record<string, string | undefined>
  let app: Awaited<ReturnType<typeof createApp>>
  let token: string

  beforeAll(async () => {
    const { db } = await getSharedIsolatedTestDb()
    saved = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]))
    Object.assign(process.env, env)
    clearSettingsCache()
    app = await createApp({ database: db })
    const actorId = `scim-admin-${uniqueSuffix()}`
    await insertTestUsers(db, { id: actorId, name: 'Admin', email: `${actorId}@example.com`, emailVerified: true })
    ;({ token } = await createScimConnection(createBetterAuthPlugin(db).auth, {
      actorId,
      name: `Keycloak ${uniqueSuffix()}`,
    }))
  })

  afterAll(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
    clearSettingsCache()
  })

  it('takes a 25-user Keycloak full sync without a 429 or 426, and spends no auth-tier budget', async () => {
    const scim = createScimClient((request) => app.handle(request), token)
    const attributes = 'attributes=userName,externalId,emails,active&startIndex=1&count=100'
    const statuses: number[] = []
    for (let index = 0; index < 25; index++) {
      const externalId = crypto.randomUUID()
      const userName = `sync-${uniqueSuffix()}`
      const lookups = [
        `/Users?filter=${encodeURIComponent(`externalId eq "${externalId}"`)}&${attributes}`,
        `/Users?filter=${encodeURIComponent(`userName eq "${userName}"`)}&${attributes}`,
        `/Schemas/${scimUserSchema}`,
        '/ServiceProviderConfig',
      ]
      for (const path of lookups) {
        statuses.push((await scim.call('GET', path)).status)
      }
      const created = await scim.call('POST', '/Users', {
        body: keycloakUser(userName, `${userName}@example.com`, externalId),
      })
      statuses.push(created.status)
      for (const path of [`/Users/${created.body.id}`, `/Users/${created.body.id}`, '/Schemas', '/ResourceTypes']) {
        statuses.push((await scim.call('GET', path)).status)
      }
    }
    expect(statuses).toHaveLength(225)
    expect(statuses.filter((status) => status === 429 || status === 426)).toEqual([])
    expect(statuses.filter((status) => status === 201)).toHaveLength(25)

    // The gate is on for everything else, and the `auth` IP tier (10/min) is still unspent.
    expect((await app.handle(new Request('http://localhost/v1/api/auth/ok'))).status).toBe(426)
    const authRoute = await app.handle(
      new Request('http://localhost/v1/api/auth/ok', { headers: { 'x-app-version': '99.0.0' } }),
    )
    expect(authRoute.status).toBe(200)
  })
})
