/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createAuth } from '@/auth/auth'
import { session as sessionTable, user as userTable } from '@/db/auth-schema'
import { deviceApprovalSessionsTable } from '@/db/encryption-schema'
import { devicesTable } from '@/db/schema'
import { createTestDb } from '@/test-utils/db'
import { createHmac } from 'crypto'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { createDeviceApprovalSessionRoutes } from './device-approval-sessions'

const baseUrl = 'http://localhost'
const betterAuthSecret = 'better-auth-secret-12345678901234567890'
const signToken = (token: string): string =>
  `${token}.${createHmac('sha256', betterAuthSecret).update(token).digest('base64')}`

const counterKey = Symbol.for('device-approval-sessions-test-runId')
;(globalThis as Record<symbol, number>)[counterKey] ??= 0

const sessionId = '0123456789abcdef0123456789abcdef'
const otherSessionId = 'fedcba9876543210fedcba9876543210'
const commitment = 'c'.repeat(64)
const challenge = 'a'.repeat(64)
const reveal = 'b'.repeat(64)

describe('Device approval session routes', () => {
  let app: Pick<ReturnType<typeof createDeviceApprovalSessionRoutes>, 'handle'>
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  let p: (id: string) => string

  const now = new Date()
  const expiresAt = new Date(now.getTime() + 3600 * 1000)

  const createUser = async (userId: string) => {
    await db.insert(userTable).values({
      id: userId,
      name: 'Test User',
      email: `${userId}@test.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
  }

  /** One bound session per device, as `POST /devices/me/bind` leaves it in production. */
  const createDevice = async (userId: string, deviceId: string, options: { trusted: boolean }) => {
    await db.insert(devicesTable).values({
      id: deviceId,
      userId,
      name: 'Test Device',
      trusted: options.trusted,
      approvalPending: !options.trusted,
      publicKey: 'pk-test',
      mlkemPublicKey: 'mlkem-pk-test',
      lastSeen: now,
      createdAt: now,
    })
    await db.insert(sessionTable).values({
      id: `session-${deviceId}`,
      expiresAt,
      token: `tok-${deviceId}`,
      createdAt: now,
      updatedAt: now,
      userId,
      deviceId,
    })
  }

  const call = (deviceId: string, method: 'GET' | 'POST', path: string, body?: Record<string, string>) =>
    app.handle(
      new Request(`${baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${signToken(`tok-${deviceId}`)}`,
          'X-Device-ID': deviceId,
        },
        body: body && JSON.stringify(body),
      }),
    )

  const start = (pending: string, id = sessionId) =>
    call(pending, 'POST', '/devices/me/approval-session', { sessionId: id, commitment })
  const readMine = (pending: string) => call(pending, 'GET', '/devices/me/approval-session')
  const revealAs = (pending: string, id = sessionId) =>
    call(pending, 'POST', '/devices/me/approval-session/reveal', { sessionId: id, reveal })
  const readPending = (trusted: string, pending: string) => call(trusted, 'GET', `/devices/${pending}/approval-session`)
  const challengeAs = (trusted: string, pending: string, id = sessionId, value = challenge) =>
    call(trusted, 'POST', `/devices/${pending}/approval-session/challenge`, { sessionId: id, challenge: value })

  beforeEach(async () => {
    const rid = ++(globalThis as Record<symbol, number>)[counterKey]
    p = (id: string) => `das-${rid}-${id}`
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    app = new Elysia().use(createDeviceApprovalSessionRoutes(createAuth(db), db))
    await createUser(p('u'))
    await createDevice(p('u'), p('trusted'), { trusted: true })
    await createDevice(p('u'), p('pending'), { trusted: false })
  })

  afterEach(async () => {
    await cleanup()
  })

  it('lets the pending device start a session and read it back', async () => {
    expect((await start(p('pending'))).status).toBe(204)
    const response = await readMine(p('pending'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ sessionId, challenge: null, challengerDeviceId: null, expired: false })
  })

  it('rejects malformed session ids and commitments', async () => {
    const response = await call(p('pending'), 'POST', '/devices/me/approval-session', {
      sessionId: 'not-hex',
      commitment: 'C'.repeat(64),
    })
    expect(response.status).toBe(422)
  })

  it('refuses a session from a trusted device', async () => {
    expect((await start(p('trusted'))).status).toBe(409)
  })

  it('refuses an unbound session', async () => {
    await db
      .update(sessionTable)
      .set({ deviceId: null })
      .where(eq(sessionTable.id, `session-${p('pending')}`))
    expect((await start(p('pending'))).status).toBe(403)
  })

  it('serves the commitment to a trusted device of the same account', async () => {
    await start(p('pending'))
    const response = await readPending(p('trusted'), p('pending'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ sessionId, commitment, reveal: null, expired: false })
  })

  it('refuses a pending device reading another device session', async () => {
    await createDevice(p('u'), p('pending-2'), { trusted: false })
    await start(p('pending'))
    expect((await readPending(p('pending-2'), p('pending'))).status).toBe(403)
    expect((await challengeAs(p('pending-2'), p('pending'))).status).toBe(403)
  })

  it("hides another account's pending device", async () => {
    await createUser(p('u2'))
    await createDevice(p('u2'), p('other-trusted'), { trusted: true })
    await start(p('pending'))
    expect((await readPending(p('other-trusted'), p('pending'))).status).toBe(404)
    expect((await challengeAs(p('other-trusted'), p('pending'))).status).toBe(404)
  })

  it('accepts only the first challenge, for the current session', async () => {
    await createDevice(p('u'), p('trusted-2'), { trusted: true })
    await start(p('pending'))
    expect((await challengeAs(p('trusted'), p('pending'), otherSessionId)).status).toBe(409)
    expect((await challengeAs(p('trusted'), p('pending'))).status).toBe(204)
    expect((await challengeAs(p('trusted-2'), p('pending'), sessionId, 'd'.repeat(64))).status).toBe(409)
    expect(await (await readMine(p('pending'))).json()).toEqual({
      sessionId,
      challenge,
      challengerDeviceId: p('trusted'),
      expired: false,
    })
  })

  it('reveals once, and only after a challenge', async () => {
    await start(p('pending'))
    expect((await revealAs(p('pending'))).status).toBe(409)
    await challengeAs(p('trusted'), p('pending'))
    expect((await revealAs(p('pending'), otherSessionId)).status).toBe(409)
    expect((await revealAs(p('pending'))).status).toBe(204)
    expect((await revealAs(p('pending'))).status).toBe(409)
    expect((await (await readPending(p('trusted'), p('pending'))).json()).reveal).toBe(reveal)
  })

  it('stops accepting a challenge or a reveal once expired', async () => {
    await start(p('pending'))
    await db
      .update(deviceApprovalSessionsTable)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(deviceApprovalSessionsTable.deviceId, p('pending')))
    expect((await challengeAs(p('trusted'), p('pending'))).status).toBe(409)
    expect((await revealAs(p('pending'))).status).toBe(409)
    expect((await (await readMine(p('pending'))).json()).expired).toBe(true)
    expect((await (await readPending(p('trusted'), p('pending'))).json()).expired).toBe(true)
  })

  it('keeps the challenge when the same session is posted again', async () => {
    await start(p('pending'))
    await challengeAs(p('trusted'), p('pending'))
    expect((await start(p('pending'))).status).toBe(204)
    expect((await (await readMine(p('pending'))).json()).challenge).toBe(challenge)
  })

  it('starts clean when a new session replaces the old one', async () => {
    await start(p('pending'))
    await challengeAs(p('trusted'), p('pending'))
    await revealAs(p('pending'))
    expect((await start(p('pending'), otherSessionId)).status).toBe(204)
    expect(await (await readMine(p('pending'))).json()).toEqual({
      sessionId: otherSessionId,
      challenge: null,
      challengerDeviceId: null,
      expired: false,
    })
    expect((await (await readPending(p('trusted'), p('pending'))).json()).reveal).toBeNull()
  })

  it('answers 404 before any session exists', async () => {
    expect((await readMine(p('pending'))).status).toBe(404)
    expect((await readPending(p('trusted'), p('pending'))).status).toBe(404)
  })

  it('drops the session with its device', async () => {
    await start(p('pending'))
    await db.delete(devicesTable).where(eq(devicesTable.id, p('pending')))
    const rows = await db
      .select()
      .from(deviceApprovalSessionsTable)
      .where(eq(deviceApprovalSessionsTable.deviceId, p('pending')))
    expect(rows).toEqual([])
  })
})
