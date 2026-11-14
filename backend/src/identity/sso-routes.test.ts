/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import { identityConnection, membershipSource, ssoProvider } from '@/db/schema'
import { createTestDb } from '@/test-utils/db'
import { createTestSettings } from '@/test-utils/settings'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ensureEnvSsoConnection, envSsoConnectionId } from './sso-connections'
import { createSsoRoutes } from './sso-routes'

const oidcSettings = createTestSettings({
  authMode: 'oidc',
  oidcIssuer: 'https://entra.test',
  oidcClientId: 'thunderbolt',
  oidcClientSecret: 'secret',
})

describe('POST /sso/discover', () => {
  let db: typeof DbType
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    ;({ db, cleanup } = await createTestDb())
    await db.delete(membershipSource).where(eq(membershipSource.identityConnectionId, envSsoConnectionId))
    await db.delete(identityConnection)
    await db.delete(ssoProvider)
  })

  afterEach(async () => {
    await cleanup()
  })

  const discover = (settings: typeof oidcSettings, body: unknown) =>
    createSsoRoutes({ settings, database: db }).handle(
      new Request('http://localhost/sso/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )

  it('returns the connections to offer', async () => {
    await ensureEnvSsoConnection(db, oidcSettings)

    const res = await discover(oidcSettings, { email: 'person@entra.test' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ connections: [{ providerId: 'sso', name: 'SSO' }] })
  })

  it('accepts a request with no email', async () => {
    await ensureEnvSsoConnection(db, oidcSettings)

    expect((await discover(oidcSettings, {})).status).toBe(200)
  })

  it('is not mounted outside SSO mode', async () => {
    expect((await discover(createTestSettings({ authMode: 'consumer' }), {})).status).toBe(404)
  })
})
