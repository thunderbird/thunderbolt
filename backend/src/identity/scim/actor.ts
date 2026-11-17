/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { tryGetCurrentAuthEndpointContext } from '@better-auth/core/context'
import type { SCIMPrincipal } from '@better-auth/scim'
import type { AuthAdapter } from '../access'
import type { AuditAction } from '../audit/events'
import type { AuditEventInput } from '../audit/write'
import { getCurrentOrganizationId } from '../current-organization'

/**
 * The connection and credential a SCIM request authenticated as. `identityConnectionId` is our
 * `identity_connection.id`, the audit `connectionId`; `scimConnectionId` is the plugin's id for it.
 */
export type ScimActor = { identityConnectionId: string; scimConnectionId: string; credentialId: string }

/**
 * Who is making the current SCIM request. The plugin's auth middleware puts its principal on the
 * endpoint context before the handler runs, so this works inside the SCIM transaction (identity
 * and projection callbacks) as well as in after-hooks. Pass the adapter of the running
 * transaction inside one. Null outside an authenticated SCIM request, such as the decommission walk
 * or a projection replay.
 */
export const getScimActor = async (adapter: Pick<AuthAdapter, 'findOne'>): Promise<ScimActor | null> => {
  const principal = (tryGetCurrentAuthEndpointContext()?.context as { scimPrincipal?: SCIMPrincipal } | undefined)
    ?.scimPrincipal
  if (!principal) {
    return null
  }
  const connection = await adapter.findOne<{ id: string }>({
    model: 'identityConnection',
    where: [
      { field: 'orgId', value: getCurrentOrganizationId() },
      { field: 'scimConnectionId', value: principal.connectionId },
    ],
  })
  return connection
    ? {
        identityConnectionId: connection.id,
        scimConnectionId: principal.connectionId,
        credentialId: principal.credentialId,
      }
    : null
}

/**
 * An audit event attributed to a SCIM connection, never to an upstream person: the connection is
 * the actor, with the credential when the change came from that connection's own request.
 */
export const scimAuditEvent = (
  action: AuditAction,
  {
    identityConnectionId,
    credentialId,
    target,
    metadata,
  }: {
    identityConnectionId: string
    credentialId: string | null
    target?: { type: string; id: string | null }
    metadata?: Record<string, unknown>
  },
): AuditEventInput => ({
  action,
  outcome: 'success',
  actor: { type: 'scim_connection', id: identityConnectionId },
  target,
  connectionId: identityConnectionId,
  credentialId,
  metadata: metadata ?? null,
})
