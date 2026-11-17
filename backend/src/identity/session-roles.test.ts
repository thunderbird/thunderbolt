/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createAuth } from '@/auth/auth'
import { memberRoleGrant, orgMembership, user } from '@/db/schema'
import { authHeaders, createTestApp, type TestAppHandle } from '@/test-utils/e2e'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { eq } from 'drizzle-orm'
import { getCurrentOrganizationId } from './current-organization'
import * as roles from './roles'
import { getSessionRoles } from './session-roles'

const authBase = 'http://localhost/v1/api/auth'

describe('session roles', () => {
  let harness: TestAppHandle
  let userId: string

  beforeEach(async () => {
    harness = await createTestApp()
    const [row] = await harness.db.select({ id: user.id }).from(user).where(eq(user.email, harness.email))
    userId = row.id
  })

  afterEach(async () => {
    await harness.cleanup()
  })

  const getSession = async () => {
    const res = await harness.app.handle(
      new Request(`${authBase}/get-session`, { headers: authHeaders(harness.bearerToken) }),
    )
    return (await res.json()) as { user: { id: string; roles?: string[] } } | null
  }

  const grantAdmin = async () => {
    const [membership] = await harness.db
      .select({ id: orgMembership.id })
      .from(orgMembership)
      .where(eq(orgMembership.userId, userId))
    await harness.db.insert(memberRoleGrant).values({
      id: crypto.randomUUID(),
      orgId: getCurrentOrganizationId(),
      membershipId: membership.id,
      role: roles.adminRole,
      source: 'local',
    })
  }

  it('reads the roles live on every HTTP session read, so a revoke needs no new sign-in', async () => {
    const lookup = spyOn(roles, 'getMemberAuthorization')
    expect((await getSession())?.user.roles).toEqual(['member'])
    expect(lookup).toHaveBeenCalled()
    lookup.mockRestore()

    await grantAdmin()
    expect((await getSession())?.user.roles).toContain('admin')

    await harness.db.delete(memberRoleGrant)
    expect((await getSession())?.user.roles).toEqual(['member'])
  })

  it('still reads a blocked member as signed out', async () => {
    await grantAdmin()
    await harness.db.update(orgMembership).set({ blockedAt: new Date() }).where(eq(orgMembership.userId, userId))

    expect(await getSession()).toBeNull()
  })

  it('skips the lookup for server-side session reads', async () => {
    await grantAdmin()
    const auth = createAuth(harness.db)
    const lookup = spyOn(roles, 'getMemberAuthorization')

    const session = await auth.api.getSession({ headers: new Headers(authHeaders(harness.bearerToken)) })

    expect(session?.user.id).toBe(userId)
    expect(session?.user.roles).toBeUndefined()
    expect(lookup).not.toHaveBeenCalled()
    lookup.mockRestore()
  })

  it('gives an anonymous user no roles without a lookup', async () => {
    const lookup = spyOn(roles, 'getMemberAuthorization')

    expect(
      await getSessionRoles({ adapter: null as never, database: harness.db }, { id: 'anon', isAnonymous: true }),
    ).toEqual([])
    expect(lookup).not.toHaveBeenCalled()
    lookup.mockRestore()
  })

  it('keeps the other plugins’ session fields in the session type', () => {
    type Session = NonNullable<Awaited<ReturnType<ReturnType<typeof createAuth>['api']['getSession']>>>
    const fields = (session: Session) => [session.session.deviceId, session.user.isAnonymous, session.user.isNew]
    expect(fields).toBeFunction()
  })
})
