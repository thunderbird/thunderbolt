/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import { auditEvent, identityConnection, invitation, orgDomain, user } from '@/db/schema'
import { createTestDb } from '@/test-utils/db'
import { addTestMembership } from '@/test-utils/identity'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { getCurrentOrganizationId } from '../current-organization'
import type { SendInvitationEmailParams } from './email'
import {
  createInvitation,
  getInvitationByToken,
  hasUsableInvitation,
  hashInvitationToken,
  invitationTtlMs,
  revokeInvitation,
} from './invitations'
import { createInvitationRoutes } from './routes'

describe('invitations', () => {
  let db: typeof DbType
  let cleanup: () => Promise<void>
  let sent: SendInvitationEmailParams[]
  const orgId = getCurrentOrganizationId()
  const adminId = 'admin-user'

  beforeEach(async () => {
    ;({ db, cleanup } = await createTestDb())
    sent = []
    await db.insert(user).values({ id: adminId, name: 'Admin', email: 'admin@corp.com', emailVerified: true })
  })

  afterEach(async () => {
    await cleanup()
  })

  const captureEmail = async (params: SendInvitationEmailParams) => {
    sent.push(params)
  }

  const invite = (email: string, options: { idpOverride?: boolean } = {}) =>
    createInvitation(db, { email, invitedBy: adminId, locale: 'de', ...options }, captureEmail)

  /** The token from the last email's link. */
  const lastToken = () => sent.at(-1)!.inviteUrl.split('/invite/')[1]

  const claimDomain = async (domain: string) => {
    await db.insert(identityConnection).values({ id: 'entra', orgId, name: 'Entra' })
    const [row] = await db
      .insert(orgDomain)
      .values({ id: crypto.randomUUID(), orgId, domain, verificationToken: 't', claimedByConnectionId: 'entra' })
      .returning()
    return row
  }

  const auditOf = (action: string) => db.select().from(auditEvent).where(eq(auditEvent.action, action))

  it('stores only the token hash, expires in a week, and emails the link in the given language', async () => {
    const before = Date.now()
    const row = await invite(' Contractor@Gmail.com ')

    expect(row).toMatchObject({
      email: 'contractor@gmail.com',
      status: 'pending',
      idpOverride: false,
      invitedBy: adminId,
    })
    expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(before + invitationTtlMs)
    expect(sent).toEqual([
      { email: 'contractor@gmail.com', inviteUrl: expect.stringMatching(/\/invite\/[A-Za-z0-9_-]{43}$/), locale: 'de' },
    ])
    const token = lastToken()
    expect(row.tokenHash).toBe(hashInvitationToken(token))
    expect(JSON.stringify(await db.select().from(invitation))).not.toContain(token)
    expect(await auditOf('invitation.created')).toMatchObject([
      { outcome: 'success', actorId: adminId, targetType: 'invitation', targetId: row.id },
    ])
  })

  it('refuses an address on a domain an IdP claims, and audits the refusal', async () => {
    const domain = await claimDomain('corp.com')

    await expect(invite('a@corp.com')).rejects.toMatchObject({ code: 'DOMAIN_CLAIMED_BY_IDP' })

    expect(await db.$count(invitation)).toBe(0)
    expect(sent).toEqual([])
    expect(await auditOf('invitation.created')).toMatchObject([
      {
        outcome: 'denied',
        reason: 'DOMAIN_CLAIMED_BY_IDP',
        actorId: adminId,
        targetId: domain.id,
        connectionId: 'entra',
      },
    ])
  })

  it('invites a claimed-domain address with the override, and audits the override', async () => {
    const domain = await claimDomain('corp.com')

    const row = await invite('a@corp.com', { idpOverride: true })

    expect(row.idpOverride).toBe(true)
    expect(await auditOf('invitation.override_used')).toMatchObject([
      {
        outcome: 'success',
        actorId: adminId,
        targetId: row.id,
        connectionId: 'entra',
        metadata: { orgDomainId: domain.id },
      },
    ])
    expect(await hasUsableInvitation(db, 'a@corp.com')).toBe(true)
  })

  it('records no override where none was needed', async () => {
    expect((await invite('a@gmail.com', { idpOverride: true })).idpOverride).toBe(false)
    expect(await auditOf('invitation.override_used')).toEqual([])
  })

  it('stops a non-overridden invitation once its domain is claimed', async () => {
    await invite('a@corp.com')
    const token = lastToken()
    await claimDomain('corp.com')

    expect(await hasUsableInvitation(db, 'a@corp.com')).toBe(false)
    expect(await getInvitationByToken(db, token)).toBeNull()
  })

  it('refuses to invite an existing member', async () => {
    await db.insert(user).values({ id: 'member', name: 'M', email: 'm@gmail.com', emailVerified: true })
    await addTestMembership(db, 'member')

    await expect(invite('m@gmail.com')).rejects.toMatchObject({ code: 'ALREADY_MEMBER' })
  })

  it('revokes the pending invitation when the address is invited again', async () => {
    const first = await invite('a@gmail.com')
    const firstToken = lastToken()
    const second = await invite('a@gmail.com')

    const rows = await db
      .select({ id: invitation.id, status: invitation.status, revokedBy: invitation.revokedBy })
      .from(invitation)
    expect(rows).toContainEqual({ id: first.id, status: 'revoked', revokedBy: adminId })
    expect(rows).toContainEqual({ id: second.id, status: 'pending', revokedBy: null })
    expect(await getInvitationByToken(db, firstToken)).toBeNull()
    expect(await getInvitationByToken(db, lastToken())).toMatchObject({ email: 'a@gmail.com' })
    expect(await auditOf('invitation.revoked')).toMatchObject([{ targetId: first.id }])
  })

  it('revokes a pending invitation, and refuses one that is not pending', async () => {
    const row = await invite('a@gmail.com')

    await revokeInvitation(db, { invitationId: row.id, revokedBy: adminId })

    expect(await hasUsableInvitation(db, 'a@gmail.com')).toBe(false)
    await expect(revokeInvitation(db, { invitationId: row.id, revokedBy: adminId })).rejects.toMatchObject({
      code: 'INVITATION_NOT_FOUND',
    })
  })

  it('treats an expired invitation as unusable', async () => {
    const row = await invite('a@gmail.com')
    await db
      .update(invitation)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitation.id, row.id))

    expect(await hasUsableInvitation(db, 'a@gmail.com')).toBe(false)
    expect(await getInvitationByToken(db, lastToken())).toBeNull()
  })

  describe('GET /invitations/:token', () => {
    const get = (token: string) =>
      createInvitationRoutes({ database: db }).handle(new Request(`http://localhost/invitations/${token}`))

    it('returns the address of a usable invitation', async () => {
      const row = await invite('a@gmail.com')

      const res = await get(lastToken())

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ email: 'a@gmail.com', expiresAt: row.expiresAt.toISOString() })
    })

    it('answers 404 for an unknown token and for an invitation that is no longer pending', async () => {
      expect((await get('unknown')).status).toBe(404)

      const row = await invite('a@gmail.com')
      await db.update(invitation).set({ status: 'accepted' }).where(eq(invitation.id, row.id))
      const res = await get(lastToken())
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ code: 'INVITATION_NOT_FOUND' })
    })
  })
})
