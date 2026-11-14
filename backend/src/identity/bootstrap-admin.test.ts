/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createAuth } from '@/auth/auth'
import { challengeTokenHeader, testSignInOtp } from '@/auth/otp-constants'
import { clearSettingsCache } from '@/config/settings'
import type { db as DbType } from '@/db/client'
import { auditEvent, memberRoleGrant, membershipSource, orgMembership, user, waitlist } from '@/db/schema'
import { createTestDb } from '@/test-utils/db'
import { createTestChallenge } from '@/test-utils/otp-challenge'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { admitsWithoutWaitlist } from './admission'

describe('bootstrap admin', () => {
  let db: typeof DbType
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    ;({ db, cleanup } = await createTestDb())
  })

  afterEach(async () => {
    delete process.env.BOOTSTRAP_ADMIN_EMAILS
    clearSettingsCache()
    await cleanup()
  })

  /** Restart with this `BOOTSTRAP_ADMIN_EMAILS`: settings are read fresh and a new auth is built. */
  const restartWith = (emails: string) => {
    process.env.BOOTSTRAP_ADMIN_EMAILS = emails
    clearSettingsCache()
    return createAuth(db)
  }

  const signIn = async (auth: ReturnType<typeof createAuth>, email: string) => {
    await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } })
    return (await auth.api.signInEmailOTP({
      body: { email, otp: testSignInOtp },
      headers: new Headers({ [challengeTokenHeader]: await createTestChallenge(db, email) }),
      asResponse: true,
    })) as Response
  }

  const userIdOf = async (email: string) =>
    (await db.select({ id: user.id }).from(user).where(eq(user.email, email)))[0]?.id

  const adminGrantsOf = async (userId: string) =>
    db
      .select({ source: memberRoleGrant.source })
      .from(memberRoleGrant)
      .innerJoin(orgMembership, eq(orgMembership.id, memberRoleGrant.membershipId))
      .where(and(eq(orgMembership.userId, userId), eq(memberRoleGrant.role, 'admin')))

  it('lets a listed address in without the waitlist and makes it admin at its first sign-in', async () => {
    const auth = restartWith('founder@example.com')
    expect(await admitsWithoutWaitlist(db, 'Founder@Example.com')).toBe(true)
    expect(await admitsWithoutWaitlist(db, 'someone@example.com')).toBe(false)

    const res = await signIn(auth, 'founder@example.com')

    expect(res.status).toBe(200)
    expect(await db.select().from(waitlist).where(eq(waitlist.email, 'founder@example.com'))).toHaveLength(0)
    const userId = (await userIdOf('founder@example.com'))!
    const sources = await db
      .select({ kind: membershipSource.kind, ref: membershipSource.ref })
      .from(membershipSource)
      .innerJoin(orgMembership, eq(orgMembership.id, membershipSource.membershipId))
      .where(eq(orgMembership.userId, userId))
    expect(sources).toEqual([{ kind: 'bootstrap', ref: 'founder@example.com' }])
    expect(await adminGrantsOf(userId)).toEqual([{ source: 'bootstrap' }])
    expect(
      await db
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.action, 'member.bootstrap_admin_granted'), eq(auditEvent.targetId, userId))),
    ).toHaveLength(1)
  })

  it('grants admin once: a removed role or a restart never brings it back, and a newly listed email gets it', async () => {
    let auth = restartWith('founder@example.com')
    await signIn(auth, 'founder@example.com')
    const founder = (await userIdOf('founder@example.com'))!
    await db.delete(memberRoleGrant)

    expect((await signIn(auth, 'founder@example.com')).status).toBe(200)
    expect(await adminGrantsOf(founder)).toEqual([])

    // An existing member, admitted from the waitlist before being listed.
    await db.insert(waitlist).values({ id: crypto.randomUUID(), email: 'second@example.com', status: 'approved' })
    await signIn(auth, 'second@example.com')
    const second = (await userIdOf('second@example.com'))!
    expect(await adminGrantsOf(second)).toEqual([])

    auth = restartWith('')
    await signIn(auth, 'founder@example.com')
    expect(await adminGrantsOf(founder)).toEqual([])

    auth = restartWith('founder@example.com,second@example.com')
    await signIn(auth, 'founder@example.com')
    await signIn(auth, 'second@example.com')
    expect(await adminGrantsOf(founder)).toEqual([])
    expect(await adminGrantsOf(second)).toEqual([{ source: 'bootstrap' }])
  })

  it('queues an address that is no longer listed, as before', async () => {
    const auth = restartWith('')

    await auth.api.sendVerificationOTP({ body: { email: 'founder@example.com', type: 'sign-in' } })

    expect(
      await db.select({ status: waitlist.status }).from(waitlist).where(eq(waitlist.email, 'founder@example.com')),
    ).toEqual([{ status: 'pending' }])
    await expect(signIn(auth, 'founder@example.com')).rejects.toMatchObject({ statusCode: 401 })
  })

  it('still requires the challenge token', async () => {
    const auth = restartWith('founder@example.com')
    await auth.api.sendVerificationOTP({ body: { email: 'founder@example.com', type: 'sign-in' } })

    await expect(
      auth.api.signInEmailOTP({ body: { email: 'founder@example.com', otp: testSignInOtp } }),
    ).rejects.toMatchObject({ statusCode: 401 })
    expect(await userIdOf('founder@example.com')).toBeUndefined()
  })
})
