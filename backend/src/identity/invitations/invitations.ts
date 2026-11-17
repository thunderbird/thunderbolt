/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getSettings } from '@/config/settings'
import type { db as DbType, QueryableDatabase } from '@/db/client'
import { invitation, orgMembership, user } from '@/db/schema'
import { normalizeEmail } from '@/lib/email'
import type { AppLocale } from '@shared/i18n/locales'
import { and, eq } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import type { AuthAdapter } from '../access'
import { AdmissionError } from '../admission-error'
import { createAuditEvent, insertAuditEvent, recordFailedAttempt } from '../audit/write'
import { getCurrentOrganizationId } from '../current-organization'
import { findOrgDomainForEmail, getOrgDomainForEmail, isClaimedDomain } from '../domains'
import { sendInvitationEmail as defaultSendInvitationEmail } from './email'

/** How long an invitation stays usable. The email says "one week", so change both together. */
export const invitationTtlMs = 7 * 24 * 60 * 60 * 1000

/** What admission reads from an `invitation` row. */
export type InvitationRow = {
  id: string
  email: string
  status: 'pending' | 'accepted' | 'revoked'
  expiresAt: Date
  idpOverride: boolean
}

/** Only this hash is stored; the token itself exists only in the invitation email's link. */
export const hashInvitationToken = (token: string) => createHash('sha256').update(token).digest('hex')

/**
 * Whether an invitation can still admit: pending, unexpired, and not on a domain an IdP claims
 * unless an admin overrode that when inviting. The claim is checked now, not only at creation, so
 * a domain claimed after the invitation was sent closes it.
 */
export const isUsableInvitation = (row: InvitationRow, domainClaimed: boolean, now = new Date()) =>
  row.status === 'pending' && row.expiresAt > now && (row.idpOverride || !domainClaimed)

const pendingInvitationWhere = (email: string) =>
  and(eq(invitation.orgId, getCurrentOrganizationId()), eq(invitation.email, email), eq(invitation.status, 'pending'))

/** Whether a usable invitation exists for this address. The waitlist gate asks; `consumeInvitation` admits. */
export const hasUsableInvitation = async (database: QueryableDatabase, email: string) => {
  const recipient = normalizeEmail(email)
  const [row] = await database.select().from(invitation).where(pendingInvitationWhere(recipient))
  return Boolean(row && isUsableInvitation(row, isClaimedDomain(await getOrgDomainForEmail(database, recipient))))
}

/**
 * Accept the usable invitation for a signing-in user's address, inside the sign-in transaction.
 * The status-guarded update makes it single use: when no pending row matches any more, the
 * invitation was consumed elsewhere and this returns null. Returns the invitation id otherwise.
 */
export const consumeInvitation = async (adapter: AuthAdapter, { id: userId, email }: { id: string; email: string }) => {
  const orgId = getCurrentOrganizationId()
  const recipient = normalizeEmail(email)
  const row = await adapter.findOne<InvitationRow>({
    model: 'invitation',
    where: [
      { field: 'orgId', value: orgId },
      { field: 'email', value: recipient },
      { field: 'status', value: 'pending' },
    ],
  })
  if (!row || !isUsableInvitation(row, isClaimedDomain(await findOrgDomainForEmail(adapter, recipient)))) {
    return null
  }
  const accepted = await adapter.update<InvitationRow>({
    model: 'invitation',
    where: [
      { field: 'id', value: row.id },
      { field: 'status', value: 'pending' },
    ],
    update: { status: 'accepted', acceptedByUserId: userId, acceptedAt: new Date() },
  })
  if (!accepted) {
    return null
  }
  await createAuditEvent(adapter, {
    action: 'invitation.accepted',
    outcome: 'success',
    actor: { type: 'user', id: userId },
    target: { type: 'invitation', id: row.id },
  })
  return row.id
}

/** The invitation a token opens, for the accept screen. Null unless it is still usable. */
export const getInvitationByToken = async (database: QueryableDatabase, token: string) => {
  const [row] = await database
    .select()
    .from(invitation)
    .where(and(eq(invitation.orgId, getCurrentOrganizationId()), eq(invitation.tokenHash, hashInvitationToken(token))))
  if (!row || !isUsableInvitation(row, isClaimedDomain(await getOrgDomainForEmail(database, row.email)))) {
    return null
  }
  return { email: row.email, expiresAt: row.expiresAt }
}

const isMember = async (database: QueryableDatabase, email: string) => {
  const [row] = await database
    .select({ id: orgMembership.id })
    .from(orgMembership)
    .innerJoin(user, eq(user.id, orgMembership.userId))
    .where(and(eq(orgMembership.orgId, getCurrentOrganizationId()), eq(user.email, email)))
  return Boolean(row)
}

const revokePending = async (tx: QueryableDatabase, email: string, revokedBy: string) => {
  const revoked = await tx
    .update(invitation)
    .set({ status: 'revoked', revokedAt: new Date(), revokedBy })
    .where(pendingInvitationWhere(email))
    .returning()
  for (const { id } of revoked) {
    await insertAuditEvent(tx, {
      action: 'invitation.revoked',
      outcome: 'success',
      actor: { type: 'user', id: revokedBy },
      target: { type: 'invitation', id },
    })
  }
  return revoked
}

/**
 * Invite one address to the current org and email it a single-use link. An address on a domain an
 * IdP connection claims is refused, and the refusal audited, unless `idpOverride` is set; using
 * the override is audited too. Inviting an address again revokes its pending invitation, because
 * a hashed token can't be resent. `locale` is the language of the email.
 */
export const createInvitation = async (
  database: typeof DbType,
  {
    email,
    invitedBy,
    idpOverride = false,
    locale,
  }: { email: string; invitedBy: string; idpOverride?: boolean; locale: AppLocale },
  sendInvitationEmail = defaultSendInvitationEmail,
) => {
  const recipient = normalizeEmail(email)
  if (await isMember(database, recipient)) {
    throw new AdmissionError('ALREADY_MEMBER')
  }
  const orgDomain = await getOrgDomainForEmail(database, recipient)
  const claimed = isClaimedDomain(orgDomain)
  if (claimed && !idpOverride) {
    await recordFailedAttempt(database, {
      action: 'invitation.created',
      outcome: 'denied',
      reason: 'DOMAIN_CLAIMED_BY_IDP',
      actor: { type: 'user', id: invitedBy },
      target: { type: 'org_domain', id: orgDomain?.id },
      connectionId: orgDomain?.claimedByConnectionId,
    })
    throw new AdmissionError('DOMAIN_CLAIMED_BY_IDP')
  }

  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  const created = await database.transaction(async (tx) => {
    await revokePending(tx, recipient, invitedBy)
    const [row] = await tx
      .insert(invitation)
      .values({
        id: crypto.randomUUID(),
        orgId: getCurrentOrganizationId(),
        email: recipient,
        tokenHash: hashInvitationToken(token),
        expiresAt: new Date(Date.now() + invitationTtlMs),
        // Recorded only when the domain is claimed, the one case the override changes anything.
        idpOverride: claimed,
        invitedBy,
      })
      .returning()
    const event = { actor: { type: 'user', id: invitedBy }, target: { type: 'invitation', id: row.id } } as const
    await insertAuditEvent(tx, { action: 'invitation.created', outcome: 'success', ...event })
    if (claimed) {
      await insertAuditEvent(tx, {
        action: 'invitation.override_used',
        outcome: 'success',
        ...event,
        connectionId: orgDomain?.claimedByConnectionId,
        metadata: { orgDomainId: orgDomain?.id },
      })
    }
    return row
  })

  await sendInvitationEmail({ email: recipient, inviteUrl: `${getSettings().appUrl}/invite/${token}`, locale })
  return created
}

/** Revoke a pending invitation. */
export const revokeInvitation = async (
  database: typeof DbType,
  { invitationId, revokedBy }: { invitationId: string; revokedBy: string },
) =>
  database.transaction(async (tx) => {
    const [row] = await tx
      .select({ email: invitation.email })
      .from(invitation)
      .where(
        and(
          eq(invitation.orgId, getCurrentOrganizationId()),
          eq(invitation.id, invitationId),
          eq(invitation.status, 'pending'),
        ),
      )
    if (!row) {
      throw new AdmissionError('INVITATION_NOT_FOUND')
    }
    await revokePending(tx, row.email, revokedBy)
  })
