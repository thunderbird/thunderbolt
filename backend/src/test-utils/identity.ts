/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { QueryableDatabase } from '@/db/client'
import type { membershipSourceKinds } from '@/db/schema'
import { membershipSource, orgMembership, user } from '@/db/schema'
import { getCurrentOrganizationId } from '@/identity/current-organization'

/**
 * Give a user inserted straight into `user` an active membership, as admission would at sign-in.
 * Without one, real Better Auth treats their session, bearer and API key as signed out.
 */
export const addTestMembership = async (
  db: QueryableDatabase,
  userId: string,
  kind: (typeof membershipSourceKinds)[number] = 'local',
) => {
  const orgId = getCurrentOrganizationId()
  const [membership] = await db.insert(orgMembership).values({ id: crypto.randomUUID(), orgId, userId }).returning()
  await db.insert(membershipSource).values({ id: crypto.randomUUID(), orgId, membershipId: membership.id, kind })
  return membership
}

/**
 * Insert users the way the tests' direct `insert(user)` did, and give each non-anonymous one a
 * membership, so real Better Auth lets them in.
 */
export const insertTestUsers = async (
  db: QueryableDatabase,
  values: typeof user.$inferInsert | (typeof user.$inferInsert)[],
) => {
  const rows = Array.isArray(values) ? values : [values]
  await db.insert(user).values(rows)
  for (const row of rows.filter((candidate) => !candidate.isAnonymous)) {
    await addTestMembership(db, row.id)
  }
}
