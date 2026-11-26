/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { QueryableDatabase } from '@/db/client'
import { identityConnection, invitation, orgDomain } from '@/db/schema'
import { and, asc, desc, eq, gt, ilike, lte } from 'drizzle-orm'
import { getCurrentOrganizationId } from '../current-organization'
import { verificationRecordName, verificationRecordValue } from '../domains'
import { escapeLike } from './members'
import { beforeTimestampCursor, exactTimestamp, type Page, toPage } from './pagination'

export type InvitationStatus = (typeof invitation.$inferSelect)['status']

export type InvitationView = {
  id: string
  email: string
  status: InvitationStatus
  expiresAt: Date
  idpOverride: boolean
  invitedBy: string | null
  createdAt: Date
}

/** An invitation row as an admin sees it: never its token hash. */
export const toInvitationView = (row: typeof invitation.$inferSelect): InvitationView => ({
  id: row.id,
  email: row.email,
  status: row.status,
  expiresAt: row.expiresAt,
  idpOverride: row.idpOverride,
  invitedBy: row.invitedBy,
  createdAt: row.createdAt,
})

/** Invitations past their expiry (`true`), before it (`false`), or either (`undefined`). */
const expiryFilter = (expired: boolean | undefined) => {
  if (expired === undefined) {
    return undefined
  }
  const now = new Date()
  return expired ? lte(invitation.expiresAt, now) : gt(invitation.expiresAt, now)
}

/**
 * The org's invitations in one status, newest first, one page at a time. `q` matches part of the
 * email; `expired` keeps only the ones past (`true`) or before (`false`) their expiry.
 */
export const listInvitations = async (
  database: QueryableDatabase,
  {
    status,
    q,
    expired,
    after,
    limit,
  }: { status: InvitationStatus; q?: string; expired?: boolean; after?: [string, string]; limit: number },
): Promise<Page<InvitationView>> => {
  const rows = await database
    .select({ invitation, cursorAt: exactTimestamp(invitation.createdAt) })
    .from(invitation)
    .where(
      and(
        eq(invitation.orgId, getCurrentOrganizationId()),
        eq(invitation.status, status),
        q ? ilike(invitation.email, `%${escapeLike(q)}%`) : undefined,
        expiryFilter(expired),
        after ? beforeTimestampCursor(invitation.createdAt, invitation.id, after) : undefined,
      ),
    )
    .orderBy(desc(invitation.createdAt), desc(invitation.id))
    .limit(limit + 1)
  const page = toPage(rows, limit, (row) => [row.cursorAt, row.invitation.id])
  return { items: page.items.map((row) => toInvitationView(row.invitation)), nextCursor: page.nextCursor }
}

export type DomainView = {
  id: string
  domain: string
  verifiedAt: Date | null
  lastCheckedAt: Date | null
  lastCheckError: string | null
  enrollmentEnabled: boolean
  claimedBy: { id: string; name: string } | null
  /** The TXT record that verifies the domain. */
  record: { name: string; value: string }
  createdAt: Date
}

/** A domain row as an admin sees it, with the record to publish. */
export const toDomainView = (
  row: typeof orgDomain.$inferSelect,
  claimedBy: DomainView['claimedBy'] = null,
): DomainView => ({
  id: row.id,
  domain: row.domain,
  verifiedAt: row.verifiedAt,
  lastCheckedAt: row.lastCheckedAt,
  lastCheckError: row.lastCheckError,
  enrollmentEnabled: row.enrollmentEnabled,
  claimedBy,
  record: { name: verificationRecordName(row.domain), value: verificationRecordValue(row.verificationToken) },
  createdAt: row.createdAt,
})

const selectDomains = async (database: QueryableDatabase, domainId?: string) => {
  const rows = await database
    .select({ domain: orgDomain, connectionName: identityConnection.name })
    .from(orgDomain)
    .leftJoin(identityConnection, eq(identityConnection.id, orgDomain.claimedByConnectionId))
    .where(and(eq(orgDomain.orgId, getCurrentOrganizationId()), domainId ? eq(orgDomain.id, domainId) : undefined))
    .orderBy(asc(orgDomain.domain))
  return rows.map(({ domain, connectionName }) =>
    toDomainView(
      domain,
      domain.claimedByConnectionId && connectionName
        ? { id: domain.claimedByConnectionId, name: connectionName }
        : null,
    ),
  )
}

/** The org's domains, by name. */
export const listDomains = (database: QueryableDatabase) => selectDomains(database)

/** One domain as an admin sees it, after a change. */
export const getDomain = async (database: QueryableDatabase, domainId: string) =>
  (await selectDomains(database, domainId))[0]
