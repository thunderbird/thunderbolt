/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { configuredSsoProviderId } from '@/auth/paths'
import { account, auditEvent, membershipSource, orgMembership, organization, user, waitlist } from '@/db/schema'
import { createIsolatedTestDb, type IsolatedTestDb } from '@/test-utils/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { implicitOrganizationId } from './current-organization'
import { ensureImplicitOrganization } from './organization'

describe('ensureImplicitOrganization', () => {
  // Its own database: the shared test database already has the org, so its backfill never runs there.
  let isolated: IsolatedTestDb
  let db: IsolatedTestDb['db']

  beforeAll(async () => {
    isolated = await createIsolatedTestDb()
    db = isolated.db
  }, 60_000)

  afterAll(async () => {
    await isolated.close()
  })

  beforeEach(async () => {
    // Back to a database that predates organizations.
    await db.delete(membershipSource)
    await db.delete(orgMembership)
    await db.delete(auditEvent)
    await db.delete(organization)
    await db.delete(account)
    await db.delete(waitlist)
    await db.delete(user)
  })

  const insertUser = async (email: string, isAnonymous = false) => {
    const id = crypto.randomUUID()
    await db.insert(user).values({ id, name: email, email, isAnonymous })
    return id
  }

  const sourcesByUser = async () => {
    const rows = await db
      .select({ userId: orgMembership.userId, kind: membershipSource.kind, ref: membershipSource.ref })
      .from(membershipSource)
      .innerJoin(orgMembership, eq(orgMembership.id, membershipSource.membershipId))
    return new Map(rows.map((row) => [row.userId, row]))
  }

  it('gives every existing non-anonymous user an active membership, with the kind they most likely came by', async () => {
    const ssoUser = await insertUser('sso@example.com')
    await db.insert(account).values({
      id: crypto.randomUUID(),
      accountId: 'idp-subject',
      providerId: configuredSsoProviderId,
      userId: ssoUser,
      updatedAt: new Date(),
    })
    const waitlistUser = await insertUser('waitlist@example.com')
    const waitlistId = crypto.randomUUID()
    await db.insert(waitlist).values({ id: waitlistId, email: 'waitlist@example.com', status: 'approved' })
    const olderUser = await insertUser('older@example.com')
    const anonymousUser = await insertUser('anon@anonymous.placeholder.invalid', true)

    await ensureImplicitOrganization(db)

    const sources = await sourcesByUser()
    expect(sources.get(ssoUser)).toEqual({ userId: ssoUser, kind: 'sso', ref: null })
    expect(sources.get(waitlistUser)).toEqual({ userId: waitlistUser, kind: 'waitlist', ref: waitlistId })
    expect(sources.get(olderUser)).toEqual({ userId: olderUser, kind: 'open', ref: null })
    expect(sources.has(anonymousUser)).toBe(false)

    const [event] = await db.select().from(auditEvent)
    expect(event).toMatchObject({ action: 'member.admitted', actorType: 'system', metadata: { backfilled: 3 } })
  })

  it('backfills only on the call that creates the organization', async () => {
    await insertUser('first@example.com')
    await ensureImplicitOrganization(db)
    const later = await insertUser('later@example.com')

    await ensureImplicitOrganization(db)

    expect(await db.$count(orgMembership)).toBe(1)
    expect((await sourcesByUser()).has(later)).toBe(false)
    expect(await db.select({ id: organization.id }).from(organization)).toEqual([{ id: implicitOrganizationId }])
  })
})
