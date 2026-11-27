/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createPowerSyncRoutes } from '@/api/powersync'
import { type Auth, createAuth } from '@/auth/auth'
import { challengeTokenHeader, testSignInOtp } from '@/auth/otp-constants'
import { getSettings } from '@/config/settings'
import {
  apikey,
  auditEvent,
  devicesTable,
  identityConnection,
  memberRoleGrant,
  membershipSource,
  orgDomain,
  orgMembership,
  session as sessionTable,
  user,
} from '@/db/schema'
import { getSharedIsolatedTestDb, type IsolatedTestDb } from '@/test-utils/db'
import { authHeaders, createTestApp, type TestAppHandle } from '@/test-utils/e2e'
import { insertTestUsers } from '@/test-utils/identity'
import { createTestChallenge } from '@/test-utils/otp-challenge'
import { createScimClient, keycloakUser, type ScimClient, scimGroupSchema, uniqueSuffix } from '@/test-utils/scim'
import { beforeAll, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { getCurrentOrganizationId } from '../current-organization'
import { claimOrgDomain } from '../domains'
import { createScimConnection } from '../scim/connections'

/** The admin API against members a real SCIM connection provisions. */
describe('admin API with IdP-managed members', () => {
  let db: IsolatedTestDb['db']
  let harness: TestAppHandle
  let auth: Auth
  let adminId: string

  beforeAll(async () => {
    ;({ db } = await getSharedIsolatedTestDb())
    harness = await createTestApp({ database: db })
    auth = createAuth(db)
    const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, harness.email))
    adminId = row.id
    const [membership] = await db.select().from(orgMembership).where(eq(orgMembership.userId, adminId))
    await db.insert(memberRoleGrant).values({
      id: crypto.randomUUID(),
      orgId: getCurrentOrganizationId(),
      membershipId: membership.id,
      role: 'admin',
      source: 'local',
    })
  })

  const call = (method: string, path: string, body?: unknown) =>
    harness.app.handle(
      new Request(`http://localhost/v1${path}`, {
        method,
        headers: {
          ...authHeaders(harness.bearerToken),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    )

  const newConnection = async () => {
    const { connection, token } = await createScimConnection(auth, { actorId: adminId, name: `IdP ${uniqueSuffix()}` })
    return { connection, scim: createScimClient((request) => harness.app.handle(request), token) }
  }

  const provision = async (scim: ScimClient) => {
    const email = `employee-${uniqueSuffix()}@example.com`
    const created = await scim.call('POST', '/Users', { body: keycloakUser(email, email, crypto.randomUUID()) })
    expect(created.status).toBe(201)
    const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email))
    return { scimId: created.body.id!, userId: row.id, email }
  }

  const createGroup = async (scim: ScimClient, displayName: string, members: string[]) => {
    const created = await scim.call('POST', '/Groups', {
      body: { schemas: [scimGroupSchema], displayName, members: members.map((value) => ({ value })) },
    })
    expect(created.status).toBe(201)
    return created.body.id!
  }

  const sendCode = async (email: string) => {
    await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } })
    return (await auth.api.signInEmailOTP({
      body: { email, otp: testSignInOtp },
      headers: new Headers({ [challengeTokenHeader]: await createTestChallenge(db, email) }),
      asResponse: true,
    })) as Response
  }

  const signIn = async (email: string) => {
    const response = await sendCode(email)
    expect(response.status).toBe(200)
    return response.headers.get('set-auth-token')!
  }

  const getSession = (headers: Record<string, string>) =>
    harness.app.handle(new Request('http://localhost/v1/api/auth/get-session', { headers }))

  it('blocks an IdP-active member: sign-in, API keys and sync are refused, and the IdP cannot lift it', async () => {
    const { scim } = await newConnection()
    const { scimId, userId, email } = await provision(scim)
    const bearer = await signIn(email)
    const deviceId = crypto.randomUUID()
    await db.insert(devicesTable).values({ id: deviceId, userId, trusted: true, nodeId: `node-${deviceId}` })
    const { key } = await auth.api.createApiKey({ body: { userId } })
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
    // Past authentication before the block: this session was never bound to the device.
    expect(await (await requestSyncToken()).json()).toEqual({ code: 'DEVICE_NOT_BOUND' })

    const blocked = await call('POST', `/admin/members/${userId}/block`, { reason: 'Investigation' })
    expect(blocked.status).toBe(200)
    expect(await blocked.json()).toMatchObject({ access: { allowed: false, reason: 'blocked' }, idpManaged: {} })

    expect(await (await getSession(authHeaders(bearer))).json()).toBeNull()
    expect(await db.$count(sessionTable, eq(sessionTable.userId, userId))).toBe(0)
    expect((await requestSyncToken()).status).toBe(401)
    expect((await getSession({ 'x-api-key': key })).status).toBe(403)
    const refused = await sendCode(email)
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ code: 'ACCESS_BLOCKED' })
    // Devices and keys stay, so unblocking is seamless.
    const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
    expect(device).toMatchObject({ revokedAt: null, trusted: true })
    expect(await db.$count(apikey, eq(apikey.referenceId, userId))).toBe(1)

    // The IdP reasserting the member changes nothing: the block is ours.
    expect((await scim.patch(`/Users/${scimId}`, [{ op: 'replace', path: 'active', value: true }])).status).toBe(200)
    expect((await sendCode(email)).status).toBe(403)

    expect((await call('POST', `/admin/members/${userId}/unblock`)).status).toBe(200)
    expect((await getSession({ 'x-api-key': key })).status).toBe(200)
    await signIn(email)
  })

  it('refuses edits to what the IdP manages, with the reason', async () => {
    const { connection, scim } = await newConnection()
    const { scimId, userId } = await provision(scim)
    const groupName = `Admins ${uniqueSuffix()}`
    const groupId = await createGroup(scim, groupName, [scimId])

    // A group named "Admins" grants nothing on its own.
    expect(await (await call('GET', `/admin/members/${userId}`)).json()).toMatchObject({ roles: [] })

    const mapping = await call('POST', '/admin/role-mappings', {
      identityConnectionId: connection.id,
      scimGroupId: groupId,
      role: 'admin',
    })
    expect(await mapping.json()).toMatchObject({
      target: { kind: 'scim_group', connectionId: connection.id, scimGroupId: groupId },
    })
    expect(await (await call('GET', `/admin/members/${userId}`)).json()).toMatchObject({
      roles: [{ role: 'admin', from: 'scim', groupId, groupName, connectionId: connection.id }],
      idpManaged: { connections: [{ id: connection.id }] },
    })
    expect(await (await call('GET', `/admin/connections/${connection.id}/scim-groups`)).json()).toMatchObject({
      items: [{ id: groupId, memberCount: 1, roles: ['admin'] }],
    })

    const revoke = await call('DELETE', `/admin/members/${userId}/roles/admin`)
    expect(revoke.status).toBe(409)
    expect(await revoke.json()).toMatchObject({
      code: 'ROLE_MANAGED_BY_IDP',
      managedBy: [{ connectionId: connection.id, scimGroupId: groupId }],
    })
    const rename = await call('PATCH', `/admin/members/${userId}`, { name: 'Someone else' })
    expect(rename.status).toBe(409)
    expect(await rename.json()).toMatchObject({ code: 'FIELD_MANAGED_BY_IDP', field: 'name' })
    expect((await call('GET', `/admin/groups/${groupId}/members`)).status).toBe(404)

    // A local grant on top is the admin's to remove; the IdP's grant stays.
    await call('POST', `/admin/members/${userId}/roles`, { role: 'admin' })
    expect(await (await call('DELETE', `/admin/members/${userId}/roles/admin`)).json()).toMatchObject({
      roles: [{ role: 'admin', from: 'scim' }],
    })
  })

  it('lets only one of two concurrent claims on a domain win', async () => {
    const [first, second] = await Promise.all([newConnection(), newConnection()])
    const [domain] = await db
      .insert(orgDomain)
      .values({
        id: crypto.randomUUID(),
        orgId: getCurrentOrganizationId(),
        domain: `claim-${uniqueSuffix()}.test`,
        verificationToken: 'token',
        verifiedAt: new Date(),
      })
      .returning()

    const results = await Promise.allSettled(
      [first, second].map(({ connection }) =>
        claimOrgDomain(db, { domainId: domain.id, identityConnectionId: connection.id, actorId: adminId }),
      ),
    )

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ code: 'DOMAIN_CLAIMED_BY_IDP' })
    const winner = (
      results.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<{
        claimedByConnectionId: string
      }>
    ).value
    const [row] = await db.select().from(orgDomain).where(eq(orgDomain.id, domain.id))
    expect(row.claimedByConnectionId).toBe(winner.claimedByConnectionId)
    expect(
      await db.$count(auditEvent, and(eq(auditEvent.action, 'domain.claimed'), eq(auditEvent.targetId, domain.id))),
    ).toBe(1)
  })

  it('retiring an SSO connection takes access from the members only it let in', async () => {
    const created = await call('POST', '/admin/connections/sso', {
      name: `Okta ${uniqueSuffix()}`,
      providerId: `okta-${uniqueSuffix()}`,
      protocol: { oidc: { issuer: 'https://okta.test', clientId: 'thunderbolt', clientSecret: 'secret' } },
    })
    const { id: connectionId } = (await created.json()) as { id: string }
    const addSsoMember = async (extraKind?: 'invitation') => {
      const id = `sso-${uniqueSuffix()}`
      const email = `${id}@example.com`
      await insertTestUsers(db, { id, name: 'SSO member', email, emailVerified: true })
      const [membership] = await db.select().from(orgMembership).where(eq(orgMembership.userId, id))
      await db
        .update(membershipSource)
        .set({ kind: extraKind ?? 'sso', identityConnectionId: extraKind ? null : connectionId })
        .where(eq(membershipSource.membershipId, membership.id))
      if (extraKind) {
        await db.insert(membershipSource).values({
          id: crypto.randomUUID(),
          orgId: getCurrentOrganizationId(),
          membershipId: membership.id,
          kind: 'sso',
          identityConnectionId: connectionId,
        })
      }
      return { id, email }
    }
    const ssoOnly = await addSsoMember()
    const invited = await addSsoMember('invitation')
    const bearer = await signIn(ssoOnly.email)

    expect((await call('POST', `/admin/connections/${connectionId}/retire`)).status).toBe(200)

    expect(await (await getSession(authHeaders(bearer))).json()).toBeNull()
    const refused = await sendCode(ssoOnly.email)
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ code: 'ACCESS_NO_LIVE_SOURCE' })
    expect(await (await call('GET', `/admin/members/${ssoOnly.id}`)).json()).toMatchObject({
      access: { allowed: false, reason: 'no_live_source' },
    })
    expect(await (await call('GET', `/admin/members/${invited.id}`)).json()).toMatchObject({
      access: { allowed: true },
    })
    await signIn(invited.email)
    const [row] = await db.select().from(identityConnection).where(eq(identityConnection.id, connectionId))
    expect(row.status).toBe('retired')
    expect(
      await db.$count(
        auditEvent,
        and(eq(auditEvent.action, 'connection.retired'), eq(auditEvent.connectionId, connectionId)),
      ),
    ).toBe(1)
  })
})
