/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createBetterAuthPlugin } from '@/auth/elysia-plugin'
import { auditEvent, identityConnection, session as sessionTable, user } from '@/db/schema'
import { getSharedIsolatedTestDb } from '@/test-utils/db'
import { authHeaders, createTestApp, type TestAppHandle } from '@/test-utils/e2e'
import { insertTestUsers } from '@/test-utils/identity'
import { createScimClient, entraUser, uniqueSuffix } from '@/test-utils/scim'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { and, eq, inArray } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { createScimConnection, retireScimConnection } from './scim/connections'
import { sessionEndEvent } from './session-audit'

const ended = { id: 'session-1', userId: 'user-1', expiresAt: new Date('2026-01-01') }
const before = new Date('2025-12-01')
const later = new Date('2026-02-01')

describe('sessionEndEvent', () => {
  it('tells explicit logout, revocation and expiry apart', () => {
    expect(sessionEndEvent(ended, { path: '/sign-out' }, before)).toMatchObject({
      action: 'auth.sign_out',
      actor: { type: 'user', id: 'user-1' },
      metadata: { sessionId: 'session-1' },
    })
    for (const path of ['/revoke-session', '/revoke-sessions', '/revoke-other-sessions']) {
      expect(sessionEndEvent(ended, { path }, before)).toMatchObject({ action: 'auth.session_revoked' })
    }
    expect(sessionEndEvent(ended, { path: '/get-session' }, later)).toMatchObject({
      action: 'auth.session_expired',
      actor: { type: 'system' },
    })
  })

  it('records an expired session as expired on any path, a revocation route included', () => {
    for (const path of ['/revoke-sessions', '/sign-out', '/list-sessions', '/passkey/list-user-passkeys']) {
      expect(sessionEndEvent(ended, { path }, later)).toMatchObject({
        action: 'auth.session_expired',
        actor: { type: 'system' },
      })
    }
  })

  it("names the SCIM plugin's server-only operations as the reason, with the system as actor", () => {
    expect(
      sessionEndEvent(ended, { path: 'virtual:', operationId: 'decommissionSCIMManagedConnection' }, before),
    ).toMatchObject({
      action: 'auth.session_revoked',
      actor: { type: 'system' },
      metadata: { sessionId: 'session-1', reason: 'decommissionSCIMManagedConnection' },
    })
    expect(sessionEndEvent(ended, { operationId: 'reconcileSCIMProjection' }, before)).toMatchObject({
      metadata: { reason: 'reconcileSCIMProjection' },
    })
  })

  it("attributes a SCIM request's sign-out to its connection and credential", () => {
    const scimActor = {
      identityConnectionId: 'entra',
      scimConnectionId: 'ba_scim_connection_1',
      credentialId: 'cred-1',
    }

    expect(sessionEndEvent(ended, { path: '/scim/v2/Users/:userId', scimActor }, before)).toMatchObject({
      action: 'auth.session_revoked',
      actor: { type: 'scim_connection', id: 'entra' },
      connectionId: 'entra',
      credentialId: 'cred-1',
      target: { type: 'user', id: 'user-1' },
      metadata: { sessionId: 'session-1' },
    })
    expect(sessionEndEvent(ended, { path: '/scim/v2/Users/:userId', scimActor: null }, before)).toBeNull()
  })

  it('leaves every other caller to write its own event', () => {
    expect(sessionEndEvent(ended, { path: '/get-session' }, before)).toBeNull()
    expect(sessionEndEvent(ended, { operationId: 'someOtherOperation' }, before)).toBeNull()
    expect(sessionEndEvent(ended, null, before)).toBeNull()
  })
})

describe('session audit', () => {
  let harness: TestAppHandle
  let userId: string

  beforeEach(async () => {
    harness = await createTestApp()
    ;[{ id: userId }] = await harness.db.select({ id: user.id }).from(user).where(eq(user.email, harness.email))
  })

  afterEach(async () => {
    await harness.cleanup()
  })

  const sessionEvents = () =>
    harness.db
      .select()
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.targetId, userId),
          inArray(auditEvent.action, ['auth.sign_out', 'auth.session_revoked', 'auth.session_expired']),
        ),
      )

  const post = (path: string, body: unknown = {}) =>
    harness.app.handle(
      new Request(`http://localhost/v1/api/auth${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(harness.bearerToken) },
        body: JSON.stringify(body),
      }),
    )

  const sessionId = async () =>
    (
      await harness.db
        .select({ id: sessionTable.id })
        .from(sessionTable)
        .where(eq(sessionTable.token, harness.bearerToken.split('.')[0]))
    )[0].id

  it('records a sign-out by its session id, never its token', async () => {
    const id = await sessionId()
    expect((await post('/sign-out')).status).toBe(200)

    const events = await sessionEvents()
    expect(events).toMatchObject([{ action: 'auth.sign_out', actorId: userId, metadata: { sessionId: id } }])
    expect(JSON.stringify(events)).not.toContain(harness.bearerToken.split('.')[0])
  })

  it("records the user's own revocation of their other sessions", async () => {
    const now = new Date()
    await harness.db.insert(sessionTable).values({
      id: `other-${uniqueSuffix()}`,
      token: `other-token-${uniqueSuffix()}`,
      userId,
      expiresAt: new Date(now.getTime() + 3600_000),
      createdAt: now,
      updatedAt: now,
    })

    expect((await post('/revoke-other-sessions')).status).toBe(200)

    expect(await sessionEvents()).toMatchObject([{ action: 'auth.session_revoked', actorId: userId }])
  })

  it('records an expired session when a request finds it', async () => {
    await harness.db
      .update(sessionTable)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessionTable.userId, userId))

    await harness.app.handle(
      new Request('http://localhost/v1/api/auth/get-session', { headers: authHeaders(harness.bearerToken) }),
    )

    expect(await sessionEvents()).toMatchObject([{ action: 'auth.session_expired', actorType: 'system' }])
  })

  it("records an expired caller's session as expired when a revocation route finds it", async () => {
    await harness.db
      .update(sessionTable)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessionTable.userId, userId))

    expect((await post('/revoke-other-sessions')).status).toBe(401)

    expect(await sessionEvents()).toMatchObject([{ action: 'auth.session_expired', actorType: 'system' }])
  })
})

describe('session audit of SCIM', () => {
  let db: Awaited<ReturnType<typeof getSharedIsolatedTestDb>>['db']
  let auth: ReturnType<typeof createBetterAuthPlugin>['auth']
  let app: { handle: (request: Request) => Promise<Response> }
  let actorId: string

  beforeAll(async () => {
    ;({ db } = await getSharedIsolatedTestDb())
    const created = createBetterAuthPlugin(db)
    auth = created.auth
    app = new Elysia({ prefix: '/v1' }).use(created.plugin)
    actorId = `scim-admin-${uniqueSuffix()}`
    await insertTestUsers(db, { id: actorId, name: 'Admin', email: `${actorId}@example.com`, emailVerified: true })
  })

  /** A SCIM connection with one provisioned member holding `sessions` sessions. */
  const provisionWithSessions = async (sessions: number) => {
    const created = await createScimConnection(auth, { actorId, name: `IdP ${uniqueSuffix()}` })
    const scim = createScimClient((request) => app.handle(request), created.token)
    const email = `ada-${uniqueSuffix()}@example.com`
    const provisioned = await scim.call('POST', '/Users', { body: entraUser(email, `oid-${uniqueSuffix()}`) })
    expect(provisioned.status).toBe(201)
    const [{ id: memberId }] = await db.select({ id: user.id }).from(user).where(eq(user.email, email))
    const now = new Date()
    const sessionIds = Array.from({ length: sessions }, () => `scim-session-${uniqueSuffix()}`)
    for (const id of sessionIds) {
      await db.insert(sessionTable).values({
        id,
        token: `scim-token-${uniqueSuffix()}`,
        userId: memberId,
        expiresAt: new Date(now.getTime() + 3600_000),
        createdAt: now,
        updatedAt: now,
      })
    }
    return { created, scim, scimId: provisioned.body.id!, memberId, sessionIds }
  }

  const revocationsOn = (connectionId: string) =>
    db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, 'auth.session_revoked'), eq(auditEvent.connectionId, connectionId)))

  it('records each session active:false signs out, attributed to the connection and credential', async () => {
    const { created, scim, scimId, memberId, sessionIds } = await provisionWithSessions(2)

    const patched = await scim.patch(`/Users/${scimId}`, [{ op: 'replace', path: 'active', value: false }])

    expect(patched.status).toBe(200)
    expect(await db.$count(sessionTable, eq(sessionTable.userId, memberId))).toBe(0)
    const revocations = await revocationsOn(created.connection.id)
    expect(revocations.map((event) => (event.metadata as { sessionId: string }).sessionId).sort()).toEqual(
      [...sessionIds].sort(),
    )
    for (const event of revocations) {
      expect(event).toMatchObject({
        actorType: 'scim_connection',
        actorId: created.connection.id,
        credentialId: created.credential.credentialId,
        targetType: 'user',
        targetId: memberId,
      })
    }
  })

  it('records exactly one revocation per session a SCIM DELETE ends', async () => {
    const { created, scim, scimId, memberId, sessionIds } = await provisionWithSessions(2)

    expect((await scim.call('DELETE', `/Users/${scimId}`)).status).toBe(204)

    // One shape whoever writes it: the member as target, the session in metadata.
    const revocations = await revocationsOn(created.connection.id)
    expect(revocations.map((event) => (event.metadata as { sessionId: string }).sessionId).sort()).toEqual(
      [...sessionIds].sort(),
    )
    expect(revocations.every((event) => event.targetType === 'user' && event.targetId === memberId)).toBe(true)
  })

  it('records the sessions the decommission walk ends, with the system as actor', async () => {
    const created = await createScimConnection(auth, { actorId, name: `Retire ${uniqueSuffix()}` })
    const scim = createScimClient((request) => app.handle(request), created.token)
    const email = `ada-${uniqueSuffix()}@example.com`
    const provisioned = await scim.call('POST', '/Users', { body: entraUser(email, `oid-${uniqueSuffix()}`) })
    expect(provisioned.status).toBe(201)
    const [{ id: memberId }] = await db.select({ id: user.id }).from(user).where(eq(user.email, email))
    const now = new Date()
    const id = `scim-session-${uniqueSuffix()}`
    await db.insert(sessionTable).values({
      id,
      token: `scim-token-${uniqueSuffix()}`,
      userId: memberId,
      expiresAt: new Date(now.getTime() + 3600_000),
      createdAt: now,
      updatedAt: now,
    })

    await retireScimConnection(auth, { identityConnectionId: created.connection.id, actorId })
    for (let attempt = 0; attempt < 100; attempt++) {
      const [row] = await db
        .select({ status: identityConnection.status })
        .from(identityConnection)
        .where(eq(identityConnection.id, created.connection.id))
      if (row.status === 'scim_retired') {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    expect(await db.$count(sessionTable, eq(sessionTable.id, id))).toBe(0)
    expect(
      await db
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.action, 'auth.session_revoked'), eq(auditEvent.targetId, memberId))),
    ).toMatchObject([
      {
        actorType: 'system',
        metadata: { sessionId: id, reason: 'decommissionSCIMManagedConnection' },
      },
    ])
  })
})
