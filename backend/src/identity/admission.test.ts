/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createAuth } from '@/auth/auth'
import { challengeTokenHeader, testSignInOtp } from '@/auth/otp-constants'
import { clearSettingsCache } from '@/config/settings'
import type { db as DbType } from '@/db/client'
import { identityConnection, membershipSource, orgDomain, orgMembership, user, waitlist } from '@/db/schema'
import { createTestDb } from '@/test-utils/db'
import { createTestChallenge } from '@/test-utils/otp-challenge'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { admitsWithoutWaitlist } from './admission'
import { getCurrentOrganizationId } from './current-organization'
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
})
