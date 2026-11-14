/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AuditEventInput } from './audit/write'
import { type ScimActor, scimAuditEvent } from './scim/actor'

type EndedSession = { id: string; userId: string; expiresAt: Date }

/**
 * What a database hook sees of the endpoint that deletes a session, plus, on a SCIM request, the
 * connection and credential it authenticated as (`getScimActor`).
 */
type DeletingEndpoint = { path?: string; operationId?: string; scimActor?: ScimActor | null } | null | undefined

/** Better Auth's path prefix for every SCIM route. */
export const scimPathPrefix = '/scim/v2/'

const userRevocationPaths = new Set(['/revoke-session', '/revoke-sessions', '/revoke-other-sessions'])

/** Server-only SCIM plugin operations that end the sessions of users left with no active source. */
const scimSystemOperations = new Set(['decommissionSCIMManagedConnection', 'reconcileSCIMProjection'])

/**
 * The audit event for a session Better Auth is about to delete, or null when the deleting caller
 * is not one we classify: that caller writes its own event. Explicit logout, revocation and expiry
 * stay distinct actions. Only the session id is kept, never its token.
 */
export const sessionEndEvent = (
  session: EndedSession,
  endpoint: DeletingEndpoint,
  now = new Date(),
): AuditEventInput | null => {
  const base = {
    outcome: 'success',
    target: { type: 'user', id: session.userId },
    metadata: { sessionId: session.id },
  } as const
  // An expired session is deleted by whichever session-gated endpoint finds it: `getSession` runs
  // under the outer path, so a revocation route that finds its caller expired is still an expiry.
  if (session.expiresAt <= now) {
    return { ...base, action: 'auth.session_expired', actor: { type: 'system' } }
  }
  const path = endpoint?.path
  if (path === '/sign-out') {
    return { ...base, action: 'auth.sign_out', actor: { type: 'user', id: session.userId } }
  }
  if (path && userRevocationPaths.has(path)) {
    return { ...base, action: 'auth.session_revoked', actor: { type: 'user', id: session.userId } }
  }
  // The plugin signs a user out when a SCIM write leaves them no active source (`active: false`).
  const scimActor = endpoint?.scimActor
  if (path?.startsWith(scimPathPrefix) && scimActor) {
    return scimAuditEvent('auth.session_revoked', { ...scimActor, target: base.target, metadata: base.metadata })
  }
  // Server-only endpoints have no route; their path is a `virtual:` placeholder.
  const operation = endpoint?.operationId
  if ((!path || path.startsWith('virtual:')) && operation && scimSystemOperations.has(operation)) {
    return {
      ...base,
      action: 'auth.session_revoked',
      actor: { type: 'system' },
      metadata: { ...base.metadata, reason: operation },
    }
  }
  return null
}
