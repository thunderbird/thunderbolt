/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/auth'
import type { QueryableDatabase } from '@/db/client'
import { identityConnection, type identityConnectionStatuses, orgDomain, ssoProvider } from '@/db/schema'
import { APIError } from 'better-auth'
import { and, asc, eq, isNotNull, type SQL } from 'drizzle-orm'
import { getCurrentOrganizationId } from '../current-organization'
import { getScimConnection } from '../scim/connections'
import { envSsoConnectionId } from '../sso-connections'

export type ConnectionView = {
  id: string
  name: string
  status: (typeof identityConnectionStatuses)[number]
  matchClaim: string
  /** Never the client secret or the certificate: only what names the IdP. */
  sso: { providerId: string; protocol: 'oidc' | 'saml'; issuer: string; envOwned: boolean } | null
  scim: { scimConnectionId: string } | null
  claimedDomains: string[]
  createdAt: Date
}

const selectConnections = async (database: QueryableDatabase, filter?: SQL): Promise<ConnectionView[]> => {
  const orgId = getCurrentOrganizationId()
  const [rows, claims] = await Promise.all([
    database
      .select({
        id: identityConnection.id,
        name: identityConnection.name,
        status: identityConnection.status,
        matchClaim: identityConnection.matchClaim,
        scimConnectionId: identityConnection.scimConnectionId,
        createdAt: identityConnection.createdAt,
        providerId: ssoProvider.providerId,
        issuer: ssoProvider.issuer,
        oidcConfig: ssoProvider.oidcConfig,
      })
      .from(identityConnection)
      .leftJoin(ssoProvider, eq(ssoProvider.id, identityConnection.ssoProviderId))
      .where(and(eq(identityConnection.orgId, orgId), filter))
      .orderBy(asc(identityConnection.name)),
    database
      .select({ connectionId: orgDomain.claimedByConnectionId, domain: orgDomain.domain })
      .from(orgDomain)
      .where(and(eq(orgDomain.orgId, orgId), isNotNull(orgDomain.claimedByConnectionId))),
  ])
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    matchClaim: row.matchClaim,
    createdAt: row.createdAt,
    sso:
      row.providerId && row.issuer !== null
        ? {
            providerId: row.providerId,
            protocol: row.oidcConfig ? 'oidc' : 'saml',
            issuer: row.issuer,
            envOwned: row.id === envSsoConnectionId,
          }
        : null,
    scim: row.scimConnectionId ? { scimConnectionId: row.scimConnectionId } : null,
    claimedDomains: claims.filter((claim) => claim.connectionId === row.id).map((claim) => claim.domain),
  }))
}

/** The org's identity connections, each with its SSO and SCIM sides. */
export const listConnections = (database: QueryableDatabase) => selectConnections(database)

/** One connection, with its SCIM credentials' state (never a token). */
export const getConnection = async (auth: Auth, database: QueryableDatabase, identityConnectionId: string) => {
  const [connection] = await selectConnections(database, eq(identityConnection.id, identityConnectionId))
  if (!connection) {
    throw new APIError('NOT_FOUND', { message: 'Connection not found', code: 'CONNECTION_NOT_FOUND' })
  }
  const credentials = connection.scim ? (await getScimConnection(auth, identityConnectionId)).credentials : []
  return { ...connection, scimCredentials: credentials }
}
