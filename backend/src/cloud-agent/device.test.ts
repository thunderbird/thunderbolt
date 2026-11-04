/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { generateResourceIdentity, type ResourceIdentity } from '@shared/cloud-agent/crypto'
import { createAuth } from '../auth/auth'
import { session, user } from '../db/auth-schema'
import { cloudIdentities } from '../db/cloud-agent-schema'
import { devicesTable } from '../db/powersync-schema'
import { signTestToken } from '../test-utils/auth-token'
import { getSharedIsolatedTestDb, type IsolatedTestDb } from '../test-utils/db'
import { readCloudSettings } from './config'
import { requireCloudTrustedDevice } from './device'
import { createCloudAgentRoutes } from './routes'
import { createCloudAgentService } from './service'

let testDb: IsolatedTestDb
let identity: ResourceIdentity
beforeAll(async () => {
  testDb = await getSharedIsolatedTestDb()
  identity = await generateResourceIdentity()
}, 60_000)

/** Real sessions exercise macro ordering: the trust gate must run after auth resolution and before any mutation. */
const fixture = async (
  options: { trusted?: boolean; bound?: boolean; anonymous?: boolean; type?: 'normal' | 'bridge' | 'cli' } = {},
) => {
  const ownerId = crypto.randomUUID()
  const deviceId = crypto.randomUUID()
  const token = crypto.randomUUID()
  await testDb.db.insert(user).values({
    id: ownerId,
    email: `${ownerId}@example.test`,
    name: 'Trusted cloud owner',
    emailVerified: true,
    isAnonymous: options.anonymous ?? false,
  })
  await testDb.db
    .insert(devicesTable)
    .values({ id: deviceId, userId: ownerId, trusted: options.trusted ?? true, deviceType: options.type ?? 'normal' })
  await testDb.db.insert(session).values({
    id: crypto.randomUUID(),
    token,
    userId: ownerId,
    deviceId: options.bound === false ? null : deviceId,
    expiresAt: new Date(Date.now() + 3600_000),
    updatedAt: new Date(),
  })
  const settings = readCloudSettings({
    CLOUD_AGENTS_ENABLED: 'true',
    CLOUD_AGENT_RUNTIME_IDENTITY: JSON.stringify(identity),
  })
  const service = createCloudAgentService(testDb.db, settings)
  const app = createCloudAgentRoutes(createAuth(testDb.db), service, null)
  const headers = {
    authorization: `Bearer ${signTestToken(token)}`,
    'x-device-id': deviceId,
    'content-type': 'application/json',
  }
  const body = JSON.stringify({
    identity: {
      version: 1,
      accountKeyId: '0',
      publicKey: identity.publicKey,
      ciphertext: { version: 1, kind: 'scoped-payload', iv: 'opaque', ciphertext: 'opaque' },
    },
  })
  const save = (overrides: Record<string, string> = {}) =>
    app.handle(
      new Request('http://localhost/cloud-agents/identity', {
        method: 'POST',
        headers: { ...headers, ...overrides },
        body,
      }),
    )
  return { ownerId, deviceId, app, headers, save }
}

describe('cloud trusted-device gate', () => {
  it('rejects anonymous accounts even with a trusted session-bound device', async () => {
    const f = await fixture({ anonymous: true })
    const response = await f.save()
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'cloud_account_required' })
    expect(
      (await f.app.handle(new Request('http://localhost/cloud-agents/capabilities', { headers: f.headers }))).status,
    ).toBe(403)
    expect(await testDb.db.select().from(cloudIdentities).where(eq(cloudIdentities.userId, f.ownerId))).toHaveLength(0)
  })

  it('permits the active trusted app device bound to the authenticated session', async () => {
    const f = await fixture()
    const response = await f.save()
    expect(response.status).toBe(200)
    expect(await testDb.db.select().from(cloudIdentities).where(eq(cloudIdentities.userId, f.ownerId))).toHaveLength(1)
  })

  it('does not let an unbound session borrow a trusted device through its header', async () => {
    const f = await fixture({ bound: false })
    const response = await f.save()
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'cloud_trusted_device_required' })
    expect(await testDb.db.select().from(cloudIdentities).where(eq(cloudIdentities.userId, f.ownerId))).toHaveLength(0)
  })

  it('rejects mismatched headers, pending devices, revoked devices, and relay-only CLI devices', async () => {
    const trusted = await fixture()
    expect((await trusted.save({ 'x-device-id': crypto.randomUUID() })).status).toBe(403)
    expect((await trusted.save({ 'x-device-id': '' })).status).toBe(403)
    const pending = await fixture({ trusted: false })
    expect((await pending.save()).status).toBe(403)
    const cli = await fixture({ type: 'cli' })
    expect((await cli.save()).status).toBe(403)
    await testDb.db.update(devicesTable).set({ revokedAt: new Date() }).where(eq(devicesTable.id, trusted.deviceId))
    expect((await trusted.save()).status).toBe(403)
  })

  it('checks device ownership and allows encrypted reads without conferring write permission', async () => {
    const f = await fixture({ trusted: false })
    const response = await f.app.handle(
      new Request('http://localhost/cloud-agents/capabilities', { headers: f.headers }),
    )
    expect(response.status).toBe(200)
    await expect(
      requireCloudTrustedDevice(
        testDb.db,
        crypto.randomUUID(),
        new Request('https://app.test', { headers: { 'x-device-id': f.deviceId } }),
        { deviceId: f.deviceId },
      ),
    ).rejects.toThrow('cloud_trusted_device_required')
    expect((await f.save()).status).toBe(403)
  })
})
