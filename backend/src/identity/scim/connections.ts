/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/auth'
import type { identityConnectionStatuses } from '@/db/schema'
import { getCurrentAdapter, runWithTransaction } from '@better-auth/core/context'
import { APIError } from 'better-auth'
import type { AuthAdapter } from '../access'
import { createAuditEvent } from '../audit/write'
import { getCurrentOrganizationId } from '../current-organization'

/*
 * The server API for an org's SCIM connections, for the admin routes to wrap. A connection is the
 * SCIM side of an `identity_connection` row (one row per IdP, its SSO side set by the SSO
 * connection code); `scim_connection_id` names the plugin's managed connection, and only this
 * module writes it. Tokens are returned once, by create and rotate, and never stored or audited.
 */

export type IdentityConnectionRow = {
  id: string
  orgId: string
  name: string
  ssoProviderId: string | null
  scimConnectionId: string | null
  status: (typeof identityConnectionStatuses)[number]
  retireRequestedAt: Date | null
  retiredAt: Date | null
  retiredBy: string | null
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

const scimScopes = ['scim.users.read', 'scim.users.write', 'scim.groups.read', 'scim.groups.write'] as const

/** Every credential expires: the plugin requires it. */
export const defaultScimCredentialLifetimeMs = 365 * 24 * 60 * 60 * 1000

const defaultExpiry = () => new Date(Date.now() + defaultScimCredentialLifetimeMs)

const notFound = () =>
  new APIError('NOT_FOUND', { message: 'SCIM connection not found', code: 'SCIM_CONNECTION_NOT_FOUND' })

const findConnection = (adapter: AuthAdapter, identityConnectionId: string) =>
  adapter.findOne<IdentityConnectionRow>({
    model: 'identityConnection',
    where: [
      { field: 'id', value: identityConnectionId },
      { field: 'orgId', value: getCurrentOrganizationId() },
    ],
  })

/** The row, when its SCIM side is live: `active`, with a managed connection. */
const findActiveScimConnection = async (adapter: AuthAdapter, identityConnectionId: string) => {
  const row = await findConnection(adapter, identityConnectionId)
  if (!row?.scimConnectionId || row.status !== 'active') {
    throw notFound()
  }
  return { ...row, scimConnectionId: row.scimConnectionId }
}

/** Run `callback` in one transaction, which the plugin's own writes join. */
const inTransaction = async <T>(auth: Auth, callback: (tx: AuthAdapter) => Promise<T>) => {
  const { adapter } = await auth.$context
  return runWithTransaction(adapter, async () => callback(await getCurrentAdapter(adapter)))
}

type CreateScimConnectionInput = { actorId: string; expiresAt?: Date } & (
  | { name: string; identityConnectionId?: undefined }
  | { identityConnectionId: string; name?: undefined }
)

/**
 * Create a SCIM connection: attached to an existing `identity_connection` (an IdP that already has
 * its SSO side), or as a new SCIM-only row. Only a row that is `active` and has no SCIM side can
 * take one. A row whose SCIM side was retired never gets a new one: that would make the retired
 * connection's members count again. Returns the token, which is shown only here.
 */
export const createScimConnection = (auth: Auth, input: CreateScimConnectionInput) =>
  inTransaction(auth, async (tx) => {
    const orgId = getCurrentOrganizationId()
    const existing = input.identityConnectionId ? await findConnection(tx, input.identityConnectionId) : null
    if (input.identityConnectionId) {
      if (!existing) {
        throw notFound()
      }
      if (existing.status !== 'active' || existing.scimConnectionId !== null) {
        throw new APIError('CONFLICT', {
          message: 'This connection cannot take a SCIM side',
          code: 'SCIM_CONNECTION_UNAVAILABLE',
        })
      }
    }
    const identityConnectionId = existing?.id ?? crypto.randomUUID()
    const created = await auth.api.createSCIMManagedConnection({
      body: {
        creationRequestId: `identity-connection:${identityConnectionId}`,
        provisioningDomainId: orgId,
        actorId: input.actorId,
        scopes: scimScopes,
        expiresAt: input.expiresAt ?? defaultExpiry(),
      },
    })
    const scimConnectionId = created.connection.connectionId
    const connection = existing
      ? await tx.update<IdentityConnectionRow>({
          model: 'identityConnection',
          where: [{ field: 'id', value: existing.id }],
          update: { scimConnectionId },
        })
      : await tx.create<Record<string, unknown>, IdentityConnectionRow>({
          model: 'identityConnection',
          data: { id: identityConnectionId, orgId, name: input.name, scimConnectionId, createdBy: input.actorId },
          forceAllowId: true,
        })
    const audit = {
      outcome: 'success',
      actor: { type: 'user', id: input.actorId },
      connectionId: identityConnectionId,
    } as const
    await createAuditEvent(tx, {
      ...audit,
      action: existing ? 'connection.updated' : 'connection.created',
      target: { type: 'identity_connection', id: identityConnectionId },
      metadata: { side: 'scim', scimConnectionId },
    })
    await createAuditEvent(tx, {
      ...audit,
      action: 'scim_credential.issued',
      target: { type: 'scim_credential', id: created.credential.credentialId },
      credentialId: created.credential.credentialId,
    })
    return { connection: connection as IdentityConnectionRow, credential: created.credential, token: created.token }
  })

/**
 * Issue another credential. The old one keeps working until it is revoked or expires, so the IdP
 * can be switched over without a gap. Returns the token, which is shown only here.
 */
export const rotateScimCredential = (
  auth: Auth,
  input: { identityConnectionId: string; actorId: string; expiresAt?: Date },
) =>
  inTransaction(auth, async (tx) => {
    const row = await findActiveScimConnection(tx, input.identityConnectionId)
    const rotated = await auth.api.rotateSCIMManagedCredential({
      body: {
        connectionId: row.scimConnectionId,
        provisioningDomainId: getCurrentOrganizationId(),
        actorId: input.actorId,
        scopes: scimScopes,
        expiresAt: input.expiresAt ?? defaultExpiry(),
      },
    })
    await createAuditEvent(tx, {
      action: 'scim_credential.rotated',
      outcome: 'success',
      actor: { type: 'user', id: input.actorId },
      target: { type: 'scim_credential', id: rotated.credential.credentialId },
      connectionId: row.id,
      credentialId: rotated.credential.credentialId,
    })
    return { credential: rotated.credential, token: rotated.token }
  })

/** Revoke one credential; its token stops working at once. */
export const revokeScimCredential = (
  auth: Auth,
  input: { identityConnectionId: string; credentialId: string; actorId: string },
) =>
  inTransaction(auth, async (tx) => {
    const row = await findActiveScimConnection(tx, input.identityConnectionId)
    await auth.api.revokeSCIMManagedCredential({
      body: {
        connectionId: row.scimConnectionId,
        provisioningDomainId: getCurrentOrganizationId(),
        credentialId: input.credentialId,
        actorId: input.actorId,
      },
    })
    await createAuditEvent(tx, {
      action: 'scim_credential.revoked',
      outcome: 'success',
      actor: { type: 'user', id: input.actorId },
      target: { type: 'scim_credential', id: input.credentialId },
      connectionId: row.id,
      credentialId: input.credentialId,
    })
  })

/** A connection and its credentials (status, `expiresAt`, last use), for the admin screen. Never a token. */
export const getScimConnection = async (auth: Auth, identityConnectionId: string) => {
  const { adapter } = await auth.$context
  const row = await findConnection(adapter, identityConnectionId)
  if (!row?.scimConnectionId) {
    throw notFound()
  }
  const state = await auth.api.getSCIMManagedConnection({
    body: { connectionId: row.scimConnectionId, provisioningDomainId: getCurrentOrganizationId() },
  })
  return { connection: row, scimConnection: state.connection, credentials: state.credentials }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Finish retiring one connection's SCIM side: run the plugin's decommission, which walks every
 * SCIM user in the org in leased batches, until it completes, then mark the row `scim_retired`.
 * Safe to run on several workers at once and to resume after a crash: the plugin's lease and
 * checkpoint make concurrent and repeated runs converge.
 */
export const runScimRetirement = async (
  auth: Auth,
  identityConnectionId: string,
  wait: (ms: number) => Promise<unknown> = sleep,
) => {
  const { adapter } = await auth.$context
  const row = await findConnection(adapter, identityConnectionId)
  if (row?.status !== 'scim_retiring' || !row.scimConnectionId) {
    return
  }
  const actorId = row.retiredBy ?? 'system'
  const decommission = async (): Promise<void> => {
    const result = await auth.api.decommissionSCIMManagedConnection({
      body: { connectionId: row.scimConnectionId!, provisioningDomainId: getCurrentOrganizationId(), actorId },
    })
    if (result.decommission.status === 'complete') {
      return
    }
    // Another worker holds the lease; try again once it would have expired.
    const retryAfter = result.decommission.retryAfter
    await wait(retryAfter ? Math.max(0, retryAfter.getTime() - Date.now()) : 1000)
    return decommission()
  }
  await decommission()
  await inTransaction(auth, async (tx) => {
    await tx.update({
      model: 'identityConnection',
      where: [
        { field: 'id', value: row.id },
        { field: 'status', value: 'scim_retiring' },
      ],
      update: { status: 'scim_retired', retiredAt: new Date() },
    })
    await createAuditEvent(tx, {
      action: 'connection.retired',
      outcome: 'success',
      actor: row.retiredBy ? { type: 'user', id: row.retiredBy } : { type: 'system' },
      target: { type: 'identity_connection', id: row.id },
      connectionId: row.id,
      metadata: { side: 'scim' },
    })
  })
}

const logRetirementFailure = (identityConnectionId: string) => (error: unknown) =>
  console.error(`Retiring SCIM connection ${identityConnectionId} failed; the next sweep resumes it`, error)

/**
 * Retire a connection's SCIM side. In one transaction, its credentials are revoked, so its tokens
 * stop at once, and the row moves to `scim_retiring`, so the access check ignores its members'
 * SCIM sources. The plugin's decommission then runs in the background, because it walks every
 * user and group.
 */
export const retireScimConnection = async (auth: Auth, input: { identityConnectionId: string; actorId: string }) => {
  const row = await inTransaction(auth, async (tx) => {
    const current = await findActiveScimConnection(tx, input.identityConnectionId)
    const provisioningDomainId = getCurrentOrganizationId()
    const { credentials } = await auth.api.getSCIMManagedConnection({
      body: { connectionId: current.scimConnectionId, provisioningDomainId },
    })
    for (const credential of credentials.filter((candidate) => candidate.status === 'active')) {
      await auth.api.revokeSCIMManagedCredential({
        body: {
          connectionId: current.scimConnectionId,
          provisioningDomainId,
          credentialId: credential.credentialId,
          actorId: input.actorId,
        },
      })
      await createAuditEvent(tx, {
        action: 'scim_credential.revoked',
        outcome: 'success',
        actor: { type: 'user', id: input.actorId },
        target: { type: 'scim_credential', id: credential.credentialId },
        connectionId: current.id,
        credentialId: credential.credentialId,
        metadata: { reason: 'connection_retiring' },
      })
    }
    const retiring = await tx.update<IdentityConnectionRow>({
      model: 'identityConnection',
      where: [{ field: 'id', value: current.id }],
      update: { status: 'scim_retiring', retireRequestedAt: new Date(), retiredBy: input.actorId },
    })
    await createAuditEvent(tx, {
      action: 'connection.retiring',
      outcome: 'success',
      actor: { type: 'user', id: input.actorId },
      target: { type: 'identity_connection', id: current.id },
      connectionId: current.id,
      metadata: { side: 'scim' },
    })
    return retiring as IdentityConnectionRow
  })
  void runScimRetirement(auth, row.id).catch(logRetirementFailure(row.id))
  return row
}

/** Resume every retirement a restart or failure interrupted. Runs at boot and on the hourly sweep. */
export const resumeScimRetirements = async (auth: Auth) => {
  const { adapter } = await auth.$context
  const retiring = await adapter.findMany<IdentityConnectionRow>({
    model: 'identityConnection',
    where: [
      { field: 'orgId', value: getCurrentOrganizationId() },
      { field: 'status', value: 'scim_retiring' },
    ],
  })
  await Promise.all(retiring.map((row) => runScimRetirement(auth, row.id).catch(logRetirementFailure(row.id))))
}
