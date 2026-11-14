/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createAuth } from '@/auth/auth'
import { challengeTokenHeader, testSignInOtp } from '@/auth/otp-constants'
import { clearSettingsCache } from '@/config/settings'
import type { db as DbType } from '@/db/client'
import {
  auditEvent,
  identityConnection,
  invitation,
  membershipSource,
  orgDomain,
  orgMembership,
  user,
  waitlist,
} from '@/db/schema'
import { addTestMembership } from '@/test-utils/identity'
import { createTestDb } from '@/test-utils/db'
import { createTestChallenge } from '@/test-utils/otp-challenge'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { admitsWithoutWaitlist } from './admission'
import { getCurrentOrganizationId } from './current-organization'
import { consumeInvitation, createInvitation, type InvitationRow } from './invitations/invitations'
import { getMemberAuthorization } from './roles'

describe('native admission', () => {
  let db: typeof DbType
  let cleanup: () => Promise<void>
  let auth: ReturnType<typeof createAuth>
  const orgId = getCurrentOrganizationId()

  beforeEach(async () => {
    ;({ db, cleanup } = await createTestDb())
    auth = createAuth(db)
  })

  afterEach(async () => {
    delete process.env.OPEN_SIGNUP_ENABLED
    delete process.env.WAITLIST_AUTO_APPROVE_DOMAINS
    clearSettingsCache()
    await cleanup()
  })

  /** Request a code and sign in with it, as the app does. The OTP before-hook throws a 401; admission answers 403. */
  const signIn = async (email: string) => {
    await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } })
    return (await auth.api.signInEmailOTP({
      body: { email, otp: testSignInOtp },
      headers: new Headers({ [challengeTokenHeader]: await createTestChallenge(db, email) }),
      asResponse: true,
    })) as Response
  }

  const userIdOf = async (email: string) =>
    (await db.select({ id: user.id }).from(user).where(eq(user.email, email)))[0]?.id

  const sourcesOf = async (email: string) =>
    db
      .select({ kind: membershipSource.kind, ref: membershipSource.ref })
      .from(membershipSource)
      .innerJoin(orgMembership, eq(orgMembership.id, membershipSource.membershipId))
      .innerJoin(user, eq(user.id, orgMembership.userId))
      .where(eq(user.email, email))

  const addDomain = async (
    domain: string,
    { verified = true, enrollment = true, claimedBy = null as string | null, enrollmentRole = 'member' } = {},
  ) => {
    const [row] = await db
      .insert(orgDomain)
      .values({
        id: crypto.randomUUID(),
        orgId,
        domain,
        verificationToken: 'token',
        verifiedAt: verified ? new Date() : null,
        enrollmentEnabled: enrollment,
        enrollmentRole,
        claimedByConnectionId: claimedBy,
      })
      .returning()
    return row
  }

  const addConnection = async (id = 'entra') => {
    await db.insert(identityConnection).values({ id, orgId, name: id })
    return id
  }

  /** Restart with these settings: they are read fresh and a new auth is built. */
  const restartWith = (env: Record<string, string>) => {
    Object.assign(process.env, env)
    clearSettingsCache()
    auth = createAuth(db)
  }

  const approveOnWaitlist = (email: string) =>
    db.insert(waitlist).values({ id: crypto.randomUUID(), email, status: 'approved' })

  describe('approved domains', () => {
    it('admits a verified address on an enrollable domain as an ordinary member', async () => {
      // Even a row edited to name the admin role grants nothing: domain joiners get no role grant.
      const domain = await addDomain('corp.com', { enrollmentRole: 'admin' })
      expect(await admitsWithoutWaitlist(db, 'a@corp.com')).toBe(true)

      const res = await signIn('a@corp.com')

      expect(res.status).toBe(200)
      expect(await sourcesOf('a@corp.com')).toEqual([{ kind: 'domain', ref: domain.id }])
      expect(await db.$count(waitlist, eq(waitlist.email, 'a@corp.com'))).toBe(0)
      const { roles } = await getMemberAuthorization(
        { adapter: (await auth.$context).adapter, database: db },
        (await userIdOf('a@corp.com'))!,
      )
      expect([...roles]).toEqual(['member'])
    })

    it('never admits through a domain that is unverified, closed, claimed, a parent or a lookalike', async () => {
      await addConnection()
      await addDomain('unverified.com', { verified: false })
      await addDomain('closed.com', { enrollment: false })
      await addDomain('claimed.com', { claimedBy: 'entra' })
      await addDomain('corp.com')

      for (const email of [
        'a@unverified.com',
        'a@closed.com',
        'a@claimed.com',
        'a@eu.corp.com',
        'a@corp.com.evil.net',
      ]) {
        expect(await admitsWithoutWaitlist(db, email)).toBe(false)
        await expect(signIn(email)).rejects.toMatchObject({ statusCode: 401 })
        expect(await userIdOf(email)).toBeUndefined()
      }
    })
  })

  describe('claimed domains and the waitlist', () => {
    it('refuses an approved waitlist row on a domain an IdP claims', async () => {
      await addConnection()
      await addDomain('corp.com', { claimedBy: 'entra', enrollment: false })
      await approveOnWaitlist('a@corp.com')

      const res = await signIn('a@corp.com')

      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ code: 'ACCESS_NOT_MEMBER' })
      expect(await sourcesOf('a@corp.com')).toEqual([])
    })

    it('still admits an approved waitlist row on an unclaimed domain', async () => {
      await addDomain('corp.com', { enrollment: false })
      await approveOnWaitlist('a@corp.com')

      expect((await signIn('a@corp.com')).status).toBe(200)
      expect(await sourcesOf('a@corp.com')).toMatchObject([{ kind: 'waitlist' }])
    })
  })

  describe('open sign-up', () => {
    it('is off by default: an address nothing admits joins the waitlist and cannot sign in', async () => {
      expect(await admitsWithoutWaitlist(db, 'new@example.com')).toBe(false)

      await expect(signIn('new@example.com')).rejects.toMatchObject({ statusCode: 401 })
      expect(
        await db.select({ status: waitlist.status }).from(waitlist).where(eq(waitlist.email, 'new@example.com')),
      ).toEqual([{ status: 'pending' }])
      expect(await userIdOf('new@example.com')).toBeUndefined()
    })

    it('admits any address that verifies its email, as `open`, without a waitlist row', async () => {
      restartWith({ OPEN_SIGNUP_ENABLED: 'true' })
      expect(await admitsWithoutWaitlist(db, 'new@example.com')).toBe(true)

      expect((await signIn('new@example.com')).status).toBe(200)
      expect(await sourcesOf('new@example.com')).toEqual([{ kind: 'open', ref: null }])
      expect(await db.$count(waitlist, eq(waitlist.email, 'new@example.com'))).toBe(0)
    })

    it('does not open a domain an IdP claims', async () => {
      restartWith({ OPEN_SIGNUP_ENABLED: 'true' })
      await addConnection()
      await addDomain('corp.com', { claimedBy: 'entra', enrollment: false })

      expect(await admitsWithoutWaitlist(db, 'a@corp.com')).toBe(false)
      await expect(signIn('a@corp.com')).rejects.toMatchObject({ statusCode: 401 })
    })
  })

  describe('WAITLIST_AUTO_APPROVE_DOMAINS', () => {
    it('still skips the waitlist, and creates no org domain', async () => {
      restartWith({ WAITLIST_AUTO_APPROVE_DOMAINS: 'auto.example' })
      expect(await admitsWithoutWaitlist(db, 'a@auto.example')).toBe(false)

      expect((await signIn('a@auto.example')).status).toBe(200)
      expect(await sourcesOf('a@auto.example')).toMatchObject([{ kind: 'waitlist' }])
      expect(await db.$count(orgDomain)).toBe(0)
    })
  })

  describe('invitations', () => {
    const adminId = 'admin-user'

    beforeEach(async () => {
      await db.insert(user).values({ id: adminId, name: 'Admin', email: 'admin@example.com', emailVerified: true })
    })

    const invite = (email: string, idpOverride = false) =>
      createInvitation(db, { email, invitedBy: adminId, idpOverride, locale: 'en' }, async () => {})

    const invitationOf = async (id: string) => (await db.select().from(invitation).where(eq(invitation.id, id)))[0]

    it('admits an invited contractor off any approved domain, and consumes the invitation', async () => {
      const row = await invite('contractor@gmail.com')
      expect(await admitsWithoutWaitlist(db, 'contractor@gmail.com')).toBe(true)

      expect((await signIn('contractor@gmail.com')).status).toBe(200)

      const userId = await userIdOf('contractor@gmail.com')
      expect(await sourcesOf('contractor@gmail.com')).toEqual([{ kind: 'invitation', ref: row.id }])
      expect(await invitationOf(row.id)).toMatchObject({ status: 'accepted', acceptedByUserId: userId })
      expect(await db.$count(waitlist, eq(waitlist.email, 'contractor@gmail.com'))).toBe(0)
      for (const action of ['invitation.accepted', 'member.admitted']) {
        expect(await db.$count(auditEvent, and(eq(auditEvent.action, action), eq(auditEvent.actorId, userId!)))).toBe(1)
      }
      expect(await admitsWithoutWaitlist(db, 'contractor@gmail.com')).toBe(false)
    })

    it('admits an overridden invitation on a domain an IdP claims', async () => {
      await addConnection()
      await addDomain('corp.com', { claimedBy: 'entra', enrollment: false })
      const row = await invite('a@corp.com', true)

      expect((await signIn('a@corp.com')).status).toBe(200)
      expect(await sourcesOf('a@corp.com')).toEqual([{ kind: 'invitation', ref: row.id }])
    })

    it('does not admit through an invitation that expired, was revoked, or names another address', async () => {
      const expired = await invite('expired@gmail.com')
      await db
        .update(invitation)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(invitation.id, expired.id))
      const revoked = await invite('revoked@gmail.com')
      await db.update(invitation).set({ status: 'revoked' }).where(eq(invitation.id, revoked.id))
      await invite('invited@gmail.com')

      for (const email of ['expired@gmail.com', 'revoked@gmail.com', 'someone-else@gmail.com']) {
        expect(await admitsWithoutWaitlist(db, email)).toBe(false)
        await expect(signIn(email)).rejects.toMatchObject({ statusCode: 401 })
      }
    })

    it('admits nothing when the invitation was consumed between the lookup and the update', async () => {
      const row = await invite('a@gmail.com')
      const stale = (await invitationOf(row.id)) as InvitationRow
      await db.update(invitation).set({ status: 'accepted' }).where(eq(invitation.id, row.id))
      const adapter = (await auth.$context).adapter
      const staleAdapter = {
        ...adapter,
        findOne: (async (query: Parameters<typeof adapter.findOne>[0]) =>
          query.model === 'invitation' ? stale : adapter.findOne(query)) as typeof adapter.findOne,
      }

      expect(await consumeInvitation(staleAdapter, { id: 'someone', email: 'a@gmail.com' })).toBeNull()
      expect(await invitationOf(row.id)).toMatchObject({ status: 'accepted', acceptedByUserId: null })
      expect(await db.$count(auditEvent, eq(auditEvent.action, 'invitation.accepted'))).toBe(0)
    })
  })

  describe('precedence', () => {
    const email = 'back@corp.com'

    /** An existing member, with every native way back in laid out: an invitation, an open domain and open sign-up. */
    const memberWithEveryWayBack = async () => {
      restartWith({ OPEN_SIGNUP_ENABLED: 'true' })
      await db.insert(user).values({ id: 'member', name: 'Member', email, emailVerified: true })
      const membership = await addTestMembership(db, 'member', 'invitation')
      await addDomain('corp.com')
      const [pending] = await db
        .insert(invitation)
        .values({
          id: crypto.randomUUID(),
          orgId,
          email,
          tokenHash: crypto.randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
        })
        .returning()
      return { membership, pending }
    }

    const addScimSource = async (membershipId: string, status: 'suspended' | 'removed') => {
      await addConnection()
      await db
        .insert(membershipSource)
        .values({ id: crypto.randomUUID(), orgId, membershipId, kind: 'scim', status, identityConnectionId: 'entra' })
    }

    const expectRefusedWith = async (code: string, pendingId: string) => {
      const before = await sourcesOf(email)
      const res = await signIn(email)
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ code })
      expect(await sourcesOf(email)).toEqual(before)
      expect((await db.select().from(invitation).where(eq(invitation.id, pendingId)))[0].status).toBe('pending')
    }

    for (const status of ['suspended', 'removed'] as const) {
      it(`keeps a member their IdP deprovisioned (${status}) out through an invitation, their domain and open sign-up`, async () => {
        const { membership, pending } = await memberWithEveryWayBack()
        await addScimSource(membership.id, status)

        await expectRefusedWith('ACCESS_DEPROVISIONED', pending.id)
      })
    }

    it('keeps a blocked member out through an invitation, their domain and open sign-up', async () => {
      const { membership, pending } = await memberWithEveryWayBack()
      await db.update(orgMembership).set({ blockedAt: new Date() }).where(eq(orgMembership.id, membership.id))

      await expectRefusedWith('ACCESS_BLOCKED', pending.id)
    })
  })
})
