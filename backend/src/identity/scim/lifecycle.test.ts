/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createPowerSyncRoutes } from '@/api/powersync'
import { type Auth, createAuth } from '@/auth/auth'
import { challengeTokenHeader, testSignInOtp } from '@/auth/otp-constants'
import { authorizeWsBearer, wsCloseUnauthorized } from '@/auth/ws-bearer-auth'
import { getSettings } from '@/config/settings'
import {
  apikey,
  auditEvent,
  devicesTable,
  envelopesTable,
  identityConnection,
  invitation,
  memberRoleGrant,
  membershipSource,
  orgMembership,
  session as sessionTable,
  ssoProvider,
  user,
} from '@/db/schema'
import { getSharedIsolatedTestDb, type IsolatedTestDb } from '@/test-utils/db'
import { authHeaders, createTestApp, type TestAppHandle } from '@/test-utils/e2e'
import { insertTestUsers } from '@/test-utils/identity'
import { createTestChallenge } from '@/test-utils/otp-challenge'
import { encodeWsBearer, wsBearerSubprotocolPrefix } from '@shared/ws-bearer'
import { createScimClient, keycloakUser, type ScimClient, uniqueSuffix } from '@/test-utils/scim'
import { getCurrentAdapter, runWithTransaction } from '@better-auth/core/context'
import { beforeAll, describe, expect, it } from 'bun:test'
import type { DBAdapter } from 'better-auth'
import { and, eq } from 'drizzle-orm'
import { getAccess } from '../access'
import { getCurrentOrganizationId } from '../current-organization'
import { createScimConnection, retireScimConnection } from './connections'
import { createScimLifecycle } from './lifecycle'

const authBase = 'http://localhost/v1/api/auth'

describe('SCIM lifecycle', () => {
  let db: IsolatedTestDb['db']
  let harness: TestAppHandle
  let auth: Auth
  let actorId: string

  beforeAll(async () => {
    ;({ db } = await getSharedIsolatedTestDb())
    harness = await createTestApp({ database: db })
    auth = createAuth(db)
    actorId = `scim-admin-${uniqueSuffix()}`
    await insertTestUsers(db, { id: actorId, name: 'Admin', email: `${actorId}@example.com`, emailVerified: true })
  })

  /** A new SCIM-only connection and a client holding its token. */
  const newConnection = async () => {
    const { connection, token, credential } = await createScimConnection(auth, {
      actorId,
      name: `IdP ${uniqueSuffix()}`,
    })
    return { connection, credential, scim: createScimClient((request) => harness.app.handle(request), token) }
  }

  /** Provision a user; returns the SCIM resource id and the Better Auth user id. */
  const provision = async (scim: ScimClient, externalId = crypto.randomUUID(), email?: string) => {
    const address = email ?? `scim-${uniqueSuffix()}@example.com`
    const created = await scim.call('POST', '/Users', { body: keycloakUser(address, address, externalId) })
    expect(created.status).toBe(201)
    const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, address))
    return { scimId: created.body.id!, userId: row.id, email: address, externalId }
  }

  const sourcesOf = (userId: string) =>
    db
      .select({
        kind: membershipSource.kind,
        status: membershipSource.status,
        ref: membershipSource.ref,
        connectionId: membershipSource.identityConnectionId,
      })
      .from(membershipSource)
      .innerJoin(orgMembership, eq(orgMembership.id, membershipSource.membershipId))
      .where(eq(orgMembership.userId, userId))

  const actionsFor = async (userId: string) =>
    (await db.select().from(auditEvent).where(eq(auditEvent.targetId, userId))).map((event) => event.action).sort()

  const access = async (userId: string) => getAccess((await auth.$context).adapter, userId)

  /** Sign a provisioned user in by email code; returns their bearer token. */
  const signIn = async (email: string) => {
    await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } })
    const response = (await auth.api.signInEmailOTP({
      body: { email, otp: testSignInOtp },
      headers: new Headers({ [challengeTokenHeader]: await createTestChallenge(db, email) }),
      asResponse: true,
    })) as Response
    expect(response.status).toBe(200)
    return response.headers.get('set-auth-token')!
  }

  /** A trusted device with its envelope, and an API key, for a signed-in member. */
  const addDeviceAndKey = async (userId: string) => {
    const deviceId = crypto.randomUUID()
    await db.insert(devicesTable).values({ id: deviceId, userId, trusted: true, nodeId: `node-${deviceId}` })
    await db.insert(envelopesTable).values({ deviceId, userId, wrappedCk: 'wrapped' })
    const { key } = await auth.api.createApiKey({ body: { userId } })
    return { deviceId, key }
  }

  const getSession = async (headers: Record<string, string>) =>
    harness.app.handle(new Request(`${authBase}/get-session`, { headers }))

  /** Retire a connection's SCIM side and wait for the background decommission to finish. */
  const retire = async (identityConnectionId: string) => {
    await retireScimConnection(auth, { identityConnectionId, actorId })
    for (let attempt = 0; attempt < 100; attempt++) {
      const [row] = await db.select().from(identityConnection).where(eq(identityConnection.id, identityConnectionId))
      if (row.status === 'scim_retired') {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`connection ${identityConnectionId} never retired`)
  }

  const deactivate = (scim: ScimClient, scimId: string, active = false) =>
    scim.patch(`/Users/${scimId}`, [{ op: 'replace', path: 'active', value: active }])

  it('admits a provisioned user as a member through their SCIM source, attributed to the connection', async () => {
    const { connection, credential, scim } = await newConnection()
    const { scimId, userId } = await provision(scim)

    expect(await sourcesOf(userId)).toEqual([
      { kind: 'scim', status: 'active', ref: scimId, connectionId: connection.id },
    ])
    expect(await access(userId)).toEqual({ allowed: true })
    const [created] = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, 'scim.user_created'), eq(auditEvent.targetId, userId)))
    expect(created).toMatchObject({
      actorType: 'scim_connection',
      actorId: connection.id,
      connectionId: connection.id,
      credentialId: credential.credentialId,
    })
    expect(await actionsFor(userId)).toEqual(['member.admitted', 'scim.user_created'])
  })

  it('suspends on active:false and keeps devices, envelopes and API keys, so reactivation is seamless', async () => {
    const { scim } = await newConnection()
    const { scimId, userId, email } = await provision(scim)
    const bearer = await signIn(email)
    const { deviceId, key } = await addDeviceAndKey(userId)

    expect((await deactivate(scim, scimId)).status).toBe(200)

    expect((await sourcesOf(userId))[0].status).toBe('suspended')
    expect(await access(userId)).toEqual({ allowed: false, reason: 'deprovisioned' })
    expect((await getSession(authHeaders(bearer))).status).toBe(200)
    expect(await (await getSession(authHeaders(bearer))).json()).toBeNull()
    expect((await getSession({ 'x-api-key': key })).status).toBe(403)
    const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
    expect(device).toMatchObject({ revokedAt: null, trusted: true })
    expect(await db.$count(envelopesTable, eq(envelopesTable.userId, userId))).toBe(1)
    expect(await db.$count(apikey, eq(apikey.referenceId, userId))).toBe(1)

    expect((await deactivate(scim, scimId, true)).status).toBe(200)

    expect(await access(userId)).toEqual({ allowed: true })
    expect((await getSession({ 'x-api-key': key })).status).toBe(200)
    expect(await actionsFor(userId)).toContain('scim.user_reactivated')
    expect(await actionsFor(userId)).toContain('scim.user_deactivated')
  })

  it('closes the WebSocket of a deactivated member', async () => {
    const { scim } = await newConnection()
    const { scimId, email } = await provision(scim)
    const subprotocols = `thunderbolt.v1, ${wsBearerSubprotocolPrefix}${encodeWsBearer(await signIn(email))}`
    expect(await authorizeWsBearer(auth, subprotocols)).toMatchObject({ ok: true })

    await deactivate(scim, scimId)

    // What the socket guard polls every few seconds; a refusal closes the socket.
    expect(await authorizeWsBearer(auth, subprotocols)).toMatchObject({ ok: false, closeCode: wsCloseUnauthorized })
  })

  it.each(['active:false', 'DELETE'] as const)(
    'refuses email-code sign-in after %s, even with a pending invitation',
    async (operation) => {
      const { scim } = await newConnection()
      const { scimId, email } = await provision(scim)
      if (operation === 'DELETE') {
        await scim.call('DELETE', `/Users/${scimId}`)
      } else {
        await deactivate(scim, scimId)
      }
      await db.insert(invitation).values({
        id: crypto.randomUUID(),
        orgId: getCurrentOrganizationId(),
        email,
        tokenHash: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      })

      await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } })
      const response = (await auth.api.signInEmailOTP({
        body: { email, otp: testSignInOtp },
        headers: new Headers({ [challengeTokenHeader]: await createTestChallenge(db, email) }),
        asResponse: true,
      })) as Response
      expect(response.status).toBe(403)
      expect(((await response.json()) as { code: string }).code).toBe('ACCESS_DEPROVISIONED')
    },
  )

  it('on DELETE removes the membership source and revokes devices, envelopes, sessions and API keys', async () => {
    const { connection, credential, scim } = await newConnection()
    const { scimId, userId, email } = await provision(scim)
    const bearer = await signIn(email)
    const { deviceId, key } = await addDeviceAndKey(userId)
    const settings = {
      ...getSettings(),
      powersyncJwtSecret: 'powersync-secret-0123456789abcdef',
      powersyncUrl: 'https://powersync.example.com',
      powersyncJwtKid: 'test-kid',
    }
    const requestSyncToken = () =>
      createPowerSyncRoutes(auth, settings, db).handle(
        new Request('http://localhost/powersync/token', {
          headers: { ...authHeaders(bearer), 'x-device-id': deviceId },
        }),
      )
    // Past authentication before the DELETE: this test's session was never bound to the device.
    expect(await (await requestSyncToken()).json()).toEqual({ code: 'DEVICE_NOT_BOUND' })

    const sessionsBefore = await db
      .select({ id: sessionTable.id })
      .from(sessionTable)
      .where(eq(sessionTable.userId, userId))
    expect((await scim.call('DELETE', `/Users/${scimId}`)).status).toBe(204)

    expect(await sourcesOf(userId)).toEqual([
      { kind: 'scim', status: 'removed', ref: scimId, connectionId: connection.id },
    ])
    expect(await db.$count(user, eq(user.id, userId))).toBe(1)
    const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
    expect(device.revokedAt).not.toBeNull()
    expect(device).toMatchObject({ trusted: false, approvalPending: false, nodeId: null, nodeIdAttestedAt: null })
    expect(await db.$count(sessionTable, eq(sessionTable.userId, userId))).toBe(0)
    expect(await db.$count(apikey, eq(apikey.referenceId, userId))).toBe(0)
    expect((await getSession({ 'x-api-key': key })).status).not.toBe(200)

    // The reconnecting device is told to wipe itself, and sync refuses the old bearer.
    const check = await getSession({ ...authHeaders(bearer), 'x-device-id': deviceId })
    expect(check.status).toBe(403)
    expect(await check.json()).toEqual({ code: 'DEVICE_DISCONNECTED' })
    const sync = await requestSyncToken()
    expect(sync.status).toBe(401)
    // A PowerSync token issued before the DELETE outlives it by at most this long.
    expect(settings.powersyncTokenExpirySeconds).toBeLessThanOrEqual(300)

    expect(await actionsFor(userId)).toEqual([
      'auth.session_revoked',
      'auth.sign_in',
      'member.admitted',
      'scim.user_created',
      'scim.user_deleted',
    ])
    // The envelopes go right after the SCIM transaction commits.
    expect(await db.$count(envelopesTable, eq(envelopesTable.userId, userId))).toBe(0)
    // One revocation event per session this deleted, attributed to the connection and credential.
    const revocations = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, 'auth.session_revoked'), eq(auditEvent.connectionId, connection.id)))
    const [{ id: sessionId }] = sessionsBefore
    expect(revocations).toHaveLength(1)
    expect(revocations[0]).toMatchObject({
      actorType: 'scim_connection',
      targetType: 'user',
      targetId: userId,
      credentialId: credential.credentialId,
      metadata: { sessionId },
    })
  })

  it('brings the same user back with no trusted devices when the same externalId is provisioned again', async () => {
    const { scim } = await newConnection()
    const first = await provision(scim)
    const { deviceId } = await addDeviceAndKey(first.userId)
    await scim.call('DELETE', `/Users/${first.scimId}`)

    const again = await provision(scim, first.externalId, first.email)

    expect(again.userId).toBe(first.userId)
    expect(again.scimId).not.toBe(first.scimId)
    expect((await sourcesOf(first.userId))[0]).toMatchObject({ status: 'active', ref: again.scimId })
    expect(await access(first.userId)).toEqual({ allowed: true })
    const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
    expect(device.revokedAt).not.toBeNull()
    expect(await db.$count(envelopesTable, eq(envelopesTable.userId, first.userId))).toBe(0)
    expect(
      await db.$count(devicesTable, and(eq(devicesTable.userId, first.userId), eq(devicesTable.trusted, true))),
    ).toBe(0)
    const [reactivated] = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, 'scim.user_reactivated'), eq(auditEvent.targetId, first.userId)))
    expect(reactivated.metadata).toEqual({ reprovisioned: true })
  })

  it('keeps devices while another IdP still vouches for the member, and revokes when the last one deletes', async () => {
    const first = await newConnection()
    const second = await newConnection()
    const { scimId, userId } = await provision(first.scim)
    const { deviceId } = await addDeviceAndKey(userId)
    // Linking one person to a second IdP is not built yet, so the plugin's state is replayed here.
    // The instance's adapter is typed with its own options; the callback takes the default ones.
    const adapter = (await auth.$context).adapter as unknown as DBAdapter
    const source = (connectionId: string, id: string) => ({
      id,
      connectionId,
      provisioningDomainId: getCurrentOrganizationId(),
      active: true,
    })
    const firstSource = source(first.connection.scimConnectionId!, scimId)
    const secondSource = source(second.connection.scimConnectionId!, crypto.randomUUID())
    const reconcile = (sources: ReturnType<typeof source>[]) =>
      runWithTransaction(adapter, async () =>
        createScimLifecycle(db).reconcileUser(
          { userId, active: sources.length > 0, sources },
          { database: await getCurrentAdapter(adapter) },
        ),
      )
    const revokedAt = async () =>
      (await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId)))[0].revokedAt

    await reconcile([firstSource, secondSource])
    await reconcile([secondSource])

    expect((await sourcesOf(userId)).map((row) => row.status).sort()).toEqual(['active', 'removed'])
    expect(await access(userId)).toEqual({ allowed: true })
    expect(await revokedAt()).toBeNull()

    await reconcile([])

    expect(await access(userId)).toEqual({ allowed: false, reason: 'deprovisioned' })
    expect(await revokedAt()).not.toBeNull()
  })

  it('leaves the sources and devices of a retired connection untouched', async () => {
    const { connection, scim } = await newConnection()
    const { userId } = await provision(scim)
    const { deviceId } = await addDeviceAndKey(userId)

    await retire(connection.id)

    expect((await sourcesOf(userId))[0].status).toBe('active')
    const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
    expect(device.revokedAt).toBeNull()
    expect(await actionsFor(userId)).toEqual(['member.admitted', 'scim.user_created'])
  })

  /** Give a SCIM-only connection an SSO side, as pairing it with an SSO provider would. */
  const addSsoSide = async (identityConnectionId: string) => {
    const providerId = crypto.randomUUID()
    await db.insert(ssoProvider).values({ id: providerId, providerId, issuer: 'https://idp.test', domain: '' })
    await db
      .update(identityConnection)
      .set({ ssoProviderId: providerId })
      .where(eq(identityConnection.id, identityConnectionId))
  }

  const signInByCode = async (email: string) => {
    await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } })
    return (await auth.api.signInEmailOTP({
      body: { email, otp: testSignInOtp },
      headers: new Headers({ [challengeTokenHeader]: await createTestChallenge(db, email) }),
      asResponse: true,
    })) as Response
  }

  it('refuses email-code sign-in to a member whose IdP has an SSO side, and records it', async () => {
    const { connection, scim } = await newConnection()
    const { userId, email } = await provision(scim)
    await addSsoSide(connection.id)

    const response = await signInByCode(email)

    expect(response.status).toBe(403)
    expect(((await response.json()) as { code: string }).code).toBe('ACCESS_SSO_REQUIRED')
    const [refused] = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, 'auth.sign_in'), eq(auditEvent.targetId, userId)))
    expect(refused).toMatchObject({ outcome: 'failure', reason: 'ACCESS_SSO_REQUIRED' })
  })

  it('keeps email-code sign-in for a member of a connection with only a SCIM side', async () => {
    const { scim } = await newConnection()
    const { email } = await provision(scim)

    expect((await signInByCode(email)).status).toBe(200)
  })

  it('refuses account deletion to an IdP-managed member, before any code is sent', async () => {
    const { connection, scim } = await newConnection()
    const { userId, email } = await provision(scim)
    const call = (method: string, path: string, bearer: string) =>
      harness.app.handle(
        new Request(`http://localhost/v1/account${path}`, {
          method,
          headers: { ...authHeaders(bearer), 'content-type': 'application/json' },
          body: '{}',
        }),
      )
    const bearer = await signIn(email)

    for (const [method, path] of [
      ['POST', '/deletion/step-up/request'],
      ['DELETE', '/'],
    ] as const) {
      const response = await call(method, path, bearer)
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ code: 'ACCOUNT_IDP_MANAGED' })
    }
    expect(await db.$count(user, eq(user.id, userId))).toBe(1)

    // Once the connection's SCIM side retires, no IdP manages them, and they may delete. The
    // retirement signed them out, and their source no longer counts, so they need another way in.
    await retire(connection.id)
    const [membership] = await db.select().from(orgMembership).where(eq(orgMembership.userId, userId))
    await db.insert(membershipSource).values({
      id: crypto.randomUUID(),
      orgId: getCurrentOrganizationId(),
      membershipId: membership.id,
      kind: 'local',
    })
    expect((await call('POST', '/deletion/step-up/request', await signIn(email))).status).toBe(200)
  })

  it('revokes every session and envelope of a member with more than a page of them', async () => {
    const { connection, scim } = await newConnection()
    const { scimId, userId } = await provision(scim)
    const count = 101
    const now = new Date()
    const deviceIds = Array.from({ length: count }, () => crypto.randomUUID())
    await db.insert(devicesTable).values(deviceIds.map((id) => ({ id, userId, trusted: true })))
    await db.insert(envelopesTable).values(deviceIds.map((deviceId) => ({ deviceId, userId, wrappedCk: 'wrapped' })))
    await db.insert(sessionTable).values(
      deviceIds.map((id) => ({
        id,
        token: crypto.randomUUID(),
        userId,
        expiresAt: new Date(now.getTime() + 60_000),
        updatedAt: now,
      })),
    )

    expect((await scim.call('DELETE', `/Users/${scimId}`)).status).toBe(204)

    expect(await db.$count(envelopesTable, eq(envelopesTable.userId, userId))).toBe(0)
    expect(
      await db.$count(
        auditEvent,
        and(eq(auditEvent.action, 'auth.session_revoked'), eq(auditEvent.connectionId, connection.id)),
      ),
    ).toBe(count)
  })

  it('keeps email-code sign-in for a break-glass admin no IdP manages, while SSO is required of IdP members', async () => {
    const { connection, scim } = await newConnection()
    const managed = await provision(scim)
    await addSsoSide(connection.id)
    const adminId = `break-glass-${uniqueSuffix()}`
    const adminEmail = `${adminId}@example.com`
    await insertTestUsers(db, { id: adminId, name: 'Break glass', email: adminEmail, emailVerified: true })
    const [membership] = await db.select().from(orgMembership).where(eq(orgMembership.userId, adminId))
    await db.insert(memberRoleGrant).values({
      id: crypto.randomUUID(),
      orgId: getCurrentOrganizationId(),
      membershipId: membership.id,
      role: 'admin',
      source: 'local',
    })

    expect((await signInByCode(managed.email)).status).toBe(403)
    expect((await signInByCode(adminEmail)).status).toBe(200)
  })
})
