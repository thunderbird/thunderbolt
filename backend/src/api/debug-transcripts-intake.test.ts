/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { user } from '@/db/auth-schema'
import { deleteUser } from '@/dal/users'
import { debugTranscriptClientsTable, debugTranscriptsTable } from '@/db/debug-transcript-schema'
import { hashDebugTranscriptClientKey } from '@/debug-transcripts/client-key'
import { createIpTierRateLimit, createRateLimitConsumer } from '@/middleware/rate-limit'
import { getSharedIsolatedTestDb } from '@/test-utils/db'
import { rateLimits } from '@/db/rate-limit-schema'
import { createTestSettings } from '@/test-utils/settings'
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { createDebugTranscriptsIntakeRoutes, ensureSelfDebugTranscriptClient } from './debug-transcripts-intake'

const body = { threadId: 'thread-1', schemaVersion: 1, payload: { turns: [] }, userId: 'origin-user' }

describe('Debug transcript intake', () => {
  let db: Awaited<ReturnType<typeof getSharedIsolatedTestDb>>['db']
  let app: ReturnType<typeof createDebugTranscriptsIntakeRoutes>

  beforeAll(async () => {
    db = (await getSharedIsolatedTestDb()).db
  })
  beforeEach(async () => {
    await db.delete(debugTranscriptsTable)
    await db.delete(debugTranscriptClientsTable)
    await db.delete(rateLimits)
    await db.insert(debugTranscriptClientsTable).values([
      { id: 'acme', name: 'Acme', keyHash: hashDebugTranscriptClientKey('acme-key') },
      { id: 'old', name: 'Old', keyHash: hashDebugTranscriptClientKey('old-key'), revokedAt: new Date() },
    ])
    app = createDebugTranscriptsIntakeRoutes({
      database: db,
      settings: createTestSettings({ debugTranscriptIntakeEnabled: true }),
      rateLimit: createRateLimitConsumer(db, { enabled: true }, 'debug-transcript-intake'),
    })
  })

  const post = (payload: BodyInit, key?: string, ip?: string) =>
    app.handle(
      new Request('http://localhost/debug-transcripts/intake', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
          ...(ip ? { 'cf-connecting-ip': ip } : {}),
        },
        body: payload,
      }),
    )

  it('is not mounted when the intake is disabled', async () => {
    const off = createDebugTranscriptsIntakeRoutes({ database: db, settings: createTestSettings(), rateLimit: null })
    expect(
      (await off.handle(new Request('http://localhost/debug-transcripts/intake', { method: 'POST' }))).status,
    ).toBe(404)
  })

  it('requires a known, non-revoked client key', async () => {
    expect((await post(JSON.stringify(body))).status).toBe(401)
    expect((await post(JSON.stringify(body), 'unknown')).status).toBe(401)
    expect((await post(JSON.stringify(body), 'old-key')).status).toBe(403)
    expect(await db.select().from(debugTranscriptsTable)).toHaveLength(0)
  })

  it('rate limits unknown keys before client lookup while allowing another IP', async () => {
    app = createDebugTranscriptsIntakeRoutes({
      database: db,
      settings: createTestSettings({ debugTranscriptIntakeEnabled: true }),
      rateLimit: createRateLimitConsumer(db, { enabled: true }, 'debug-transcript-intake'),
      ipRateLimit: createIpTierRateLimit(db, { enabled: true, trustedProxy: 'cloudflare' }, 'debug-transcript-intake'),
    })

    for (let index = 0; index < 600; index++) {
      expect((await post(JSON.stringify(body), 'unknown', '10.5.0.1')).status).toBe(401)
    }
    const blocked = await post(JSON.stringify(body), 'unknown', '10.5.0.1')
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toEqual({ error: 'Too many requests. Please try again later.' })
    expect((await post(JSON.stringify(body), 'acme-key', '10.5.0.2')).status).toBe(201)
  })

  it('stores an accepted transcript under the client and returns its id', async () => {
    const response = await post(JSON.stringify(body), 'acme-key')
    expect(response.status).toBe(201)
    const { id } = (await response.json()) as { id: string }
    const rows = await db.select().from(debugTranscriptsTable)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id,
      clientId: 'acme',
      userId: 'origin-user',
      threadId: 'thread-1',
    })
  })

  it('stores a null userId for anonymous submissions', async () => {
    expect((await post(JSON.stringify({ ...body, userId: null }), 'acme-key')).status).toBe(201)
    expect((await db.select().from(debugTranscriptsTable))[0].userId).toBeNull()
  })

  it('rejects schema violations with 422', async () => {
    expect((await post(JSON.stringify({ ...body, extra: 1 }), 'acme-key')).status).toBe(422)
    expect((await post(JSON.stringify({ threadId: 'x' }), 'acme-key')).status).toBe(422)
  })

  it('rejects an oversized chunked body without content-length with 413', async () => {
    const big = JSON.stringify({ ...body, payload: { blob: 'x'.repeat(2 * 1024 * 1024 + 8 * 1024) } })
    const response = await app.handle(
      new Request('http://localhost/debug-transcripts/intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer acme-key' },
        body: new Blob([big]).stream(),
        duplex: 'half',
      } as RequestInit),
    )
    expect(response.status).toBe(413)
  })

  it('rate limits per client', async () => {
    for (let i = 0; i < 600; i++) {
      expect((await post(JSON.stringify(body), 'acme-key')).status).toBe(201)
    }
    expect((await post(JSON.stringify(body), 'acme-key')).status).toBe(429)
  })

  it('seeds and rotates the self client from settings', async () => {
    const settings = createTestSettings({ debugTranscriptIntakeEnabled: true, debugTranscriptUpstreamKey: 'self-key' })
    await ensureSelfDebugTranscriptClient(db, settings)
    await ensureSelfDebugTranscriptClient(db, { ...settings, debugTranscriptUpstreamKey: 'rotated' })
    const rows = await db.select().from(debugTranscriptClientsTable)
    expect(rows.find((r) => r.id === 'self')?.keyHash).toBe(hashDebugTranscriptClientKey('rotated'))
    expect(rows).toHaveLength(3)
  })

  it('does not seed when the intake is disabled or no key is set', async () => {
    await ensureSelfDebugTranscriptClient(db, createTestSettings({ debugTranscriptUpstreamKey: 'k' }))
    await ensureSelfDebugTranscriptClient(db, createTestSettings({ debugTranscriptIntakeEnabled: true }))
    expect(await db.select().from(debugTranscriptClientsTable)).toHaveLength(2)
  })
  it('enforces the separate 2 MB payload boundary within the whole-request cap', async () => {
    const atLimit = { blob: 'x'.repeat(2 * 1024 * 1024 - JSON.stringify({ blob: '' }).length) }
    expect((await post(JSON.stringify({ ...body, payload: atLimit }), 'acme-key')).status).toBe(201)
    const response = await post(JSON.stringify({ ...body, payload: { blob: atLimit.blob + 'x' } }), 'acme-key')
    expect(response.status).toBe(413)
    expect((await response.json()).code).toBe('DEBUG_TRANSCRIPT_TOO_LARGE')
    expect(await db.select().from(debugTranscriptsTable)).toHaveLength(1)
  })
  it('accepts a self upload that arrives after its account was deleted', async () => {
    const userId = crypto.randomUUID()
    await db.insert(user).values({ id: userId, name: 'Deleted user', email: `${userId}@example.com` })
    await deleteUser(db, userId)
    await ensureSelfDebugTranscriptClient(
      db,
      createTestSettings({ debugTranscriptIntakeEnabled: true, debugTranscriptUpstreamKey: 'self-key' }),
    )
    expect((await post(JSON.stringify({ ...body, userId }), 'self-key')).status).toBe(201)
    expect((await db.select().from(debugTranscriptsTable))[0]).toMatchObject({ clientId: 'self', userId })
  })
})
