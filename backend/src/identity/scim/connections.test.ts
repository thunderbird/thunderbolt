/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type Auth, createBetterAuthPlugin } from '@/auth/elysia-plugin'
import { auditEvent, identityConnection, organization, scimManagedConnection, scimManagedCredential } from '@/db/schema'
import { getSharedIsolatedTestDb, type IsolatedTestDb } from '@/test-utils/db'
import { insertTestUsers } from '@/test-utils/identity'
import { createScimClient, uniqueSuffix } from '@/test-utils/scim'
import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { getCurrentOrganizationId } from '../current-organization'
import {
  createScimConnection,
  defaultScimCredentialLifetimeMs,
  getScimConnection,
  resumeScimRetirements,
  retireScimConnection,
  revokeScimCredential,
  rotateScimCredential,
} from './connections'

describe('SCIM connections', () => {
  let db: IsolatedTestDb['db']
  let auth: Auth
  let app: { handle: (request: Request) => Promise<Response> }
  let actorId: string

  const usersStatus = async (token: string) =>
    (await createScimClient((request) => app.handle(request), token).call('GET', '/Users')).status

  const connectionRow = async (id: string) => {
    const [row] = await db.select().from(identityConnection).where(eq(identityConnection.id, id))
    return row
  }

  const auditFor = (connectionId: string) =>
    db.select().from(auditEvent).where(eq(auditEvent.connectionId, connectionId)).orderBy(auditEvent.occurredAt)

  /** Sorted: events written in one transaction can share a timestamp. */
  const auditActions = async (connectionId: string) =>
    (await auditFor(connectionId)).map((event) => event.action).sort()

  const insertConnection = async (values: Partial<typeof identityConnection.$inferInsert> = {}) => {
    const [row] = await db
      .insert(identityConnection)
      .values({ id: crypto.randomUUID(), orgId: getCurrentOrganizationId(), name: `IdP ${uniqueSuffix()}`, ...values })
      .returning()
    return row
  }

  const waitForStatus = async (id: string, status: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await connectionRow(id)).status === status) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`connection ${id} never reached ${status}`)
  }

  beforeAll(async () => {
    ;({ db } = await getSharedIsolatedTestDb())
    const created = createBetterAuthPlugin(db)
    auth = created.auth
    app = new Elysia({ prefix: '/v1' }).use(created.plugin)
    actorId = `scim-admin-${uniqueSuffix()}`
    await insertTestUsers(db, { id: actorId, name: 'Admin', email: `${actorId}@example.com`, emailVerified: true })
  })

  it('creates a SCIM-only connection and returns its token once', async () => {
    const before = Date.now()
    const created = await createScimConnection(auth, { actorId, name: `Entra ${uniqueSuffix()}` })
    expect(created.connection).toMatchObject({ status: 'active', ssoProviderId: null, createdBy: actorId })
    expect(created.connection.scimConnectionId).toStartWith('ba_scim_connection_')
    expect(created.token.startsWith('ba_scim_credential_')).toBe(true)
    expect(await usersStatus(created.token)).toBe(200)

    const state = await getScimConnection(auth, created.connection.id)
    expect(state.credentials).toHaveLength(1)
    const [credential] = state.credentials
    expect(credential.status).toBe('active')
    expect(credential.expiresAt.getTime()).toBeGreaterThanOrEqual(before + defaultScimCredentialLifetimeMs - 1000)
    expect(JSON.stringify(state)).not.toContain(created.token)

    const events = await auditFor(created.connection.id)
    expect(await auditActions(created.connection.id)).toEqual(['connection.created', 'scim_credential.issued'])
    expect(events.find((event) => event.action === 'scim_credential.issued')?.credentialId).toBe(
      credential.credentialId,
    )
    expect(JSON.stringify(events)).not.toContain(created.token)
  })

  it('attaches SCIM to an existing connection row instead of creating a second one', async () => {
    const existing = await insertConnection()
    const created = await createScimConnection(auth, { actorId, identityConnectionId: existing.id })
    expect(created.connection.id).toBe(existing.id)
    expect((await connectionRow(existing.id)).scimConnectionId).toBe(created.connection.scimConnectionId)
    expect(await db.$count(identityConnection, eq(identityConnection.name, existing.name))).toBe(1)
    expect(await auditActions(existing.id)).toEqual(['connection.updated', 'scim_credential.issued'].sort())
  })

  it('refuses to attach to a row that has a SCIM side, or whose SCIM side is retiring or retired', async () => {
    const withScim = (await createScimConnection(auth, { actorId, name: `Has SCIM ${uniqueSuffix()}` })).connection
    const retiring = await insertConnection({ scimConnectionId: `old-${uniqueSuffix()}`, status: 'scim_retiring' })
    const scimRetired = await insertConnection({ scimConnectionId: `old-${uniqueSuffix()}`, status: 'scim_retired' })
    const retired = await insertConnection({ status: 'retired' })
    for (const row of [withScim, retiring, scimRetired, retired]) {
      const before = await connectionRow(row.id)
      await expect(createScimConnection(auth, { actorId, identityConnectionId: row.id })).rejects.toMatchObject({
        body: { code: 'SCIM_CONNECTION_UNAVAILABLE' },
      })
      expect(await connectionRow(row.id)).toEqual(before)
    }
    // A hand-made retiring row has no plugin connection, so the resume test must not find it.
    await db.delete(identityConnection).where(eq(identityConnection.id, retiring.id))
  })

  it("refuses another org's connection row", async () => {
    const orgId = `other-org-${uniqueSuffix()}`
    await db.insert(organization).values({ id: orgId, name: 'Other', slug: orgId })
    const foreign = await insertConnection({ orgId })
    await expect(createScimConnection(auth, { actorId, identityConnectionId: foreign.id })).rejects.toMatchObject({
      body: { code: 'SCIM_CONNECTION_NOT_FOUND' },
    })
    await expect(getScimConnection(auth, foreign.id)).rejects.toMatchObject({
      body: { code: 'SCIM_CONNECTION_NOT_FOUND' },
    })
  })

  it('rotates without a gap, then revokes the old credential', async () => {
    const created = await createScimConnection(auth, { actorId, name: `Rotate ${uniqueSuffix()}` })
    const rotated = await rotateScimCredential(auth, { identityConnectionId: created.connection.id, actorId })
    expect(rotated.token).not.toBe(created.token)
    expect(await usersStatus(created.token)).toBe(200)
    expect(await usersStatus(rotated.token)).toBe(200)

    await revokeScimCredential(auth, {
      identityConnectionId: created.connection.id,
      credentialId: created.credential.credentialId,
      actorId,
    })
    expect(await usersStatus(created.token)).toBe(401)
    expect(await usersStatus(rotated.token)).toBe(200)
    expect(await auditActions(created.connection.id)).toEqual(
      ['connection.created', 'scim_credential.issued', 'scim_credential.rotated', 'scim_credential.revoked'].sort(),
    )
  })

  it('retires: tokens revoked and scim_retiring at once, then scim_retired in the background', async () => {
    const created = await createScimConnection(auth, { actorId, name: `Retire ${uniqueSuffix()}` })
    const rotated = await rotateScimCredential(auth, { identityConnectionId: created.connection.id, actorId })
    const retiring = await retireScimConnection(auth, { identityConnectionId: created.connection.id, actorId })
    expect(retiring.status).toBe('scim_retiring')
    expect(retiring.retiredBy).toBe(actorId)
    // Revoked by the retirement itself, not left to the background decommission.
    const credentials = await db
      .select({ revokedAt: scimManagedCredential.revokedAt, revokedBy: scimManagedCredential.revokedBy })
      .from(scimManagedCredential)
      .innerJoin(scimManagedConnection, eq(scimManagedConnection.id, scimManagedCredential.connectionRecordId))
      .where(eq(scimManagedConnection.connectionId, created.connection.scimConnectionId!))
    expect(credentials).toHaveLength(2)
    expect(credentials.every((credential) => credential.revokedAt !== null && credential.revokedBy === actorId)).toBe(
      true,
    )
    expect(await usersStatus(created.token)).toBe(401)
    expect(await usersStatus(rotated.token)).toBe(401)
    await waitForStatus(created.connection.id, 'scim_retired')

    const row = await connectionRow(created.connection.id)
    expect(row.retiredAt).not.toBeNull()
    expect(row.scimConnectionId).toBe(created.connection.scimConnectionId)
    expect(await usersStatus(created.token)).toBe(401)
    expect(await auditActions(created.connection.id)).toEqual(
      [
        'connection.created',
        'scim_credential.issued',
        'scim_credential.rotated',
        'scim_credential.revoked',
        'scim_credential.revoked',
        'connection.retiring',
        'connection.retired',
      ].sort(),
    )
    await expect(
      rotateScimCredential(auth, { identityConnectionId: created.connection.id, actorId }),
    ).rejects.toMatchObject({
      body: { code: 'SCIM_CONNECTION_NOT_FOUND' },
    })
  })

  it('resumes a retirement a restart interrupted', async () => {
    const created = await createScimConnection(auth, { actorId, name: `Resume ${uniqueSuffix()}` })
    await db
      .update(identityConnection)
      .set({ status: 'scim_retiring', retireRequestedAt: new Date(), retiredBy: actorId })
      .where(eq(identityConnection.id, created.connection.id))
    expect(await usersStatus(created.token)).toBe(200)

    await resumeScimRetirements(auth)
    expect((await connectionRow(created.connection.id)).status).toBe('scim_retired')
    expect(await usersStatus(created.token)).toBe(401)
  })
})
