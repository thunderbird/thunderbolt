/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import { waitlist } from '@/db/schema'
import { eq } from 'drizzle-orm'

/** Get a waitlist entry by email. Returns null if not found. */
export const getWaitlistByEmail = async (database: typeof DbType, email: string) =>
  database
    .select({ id: waitlist.id, status: waitlist.status })
    .from(waitlist)
    .where(eq(waitlist.email, email))
    .limit(1)
    .then((rows) => rows[0] ?? null)

/** Create a new waitlist entry. Uses onConflictDoNothing for race-condition safety. */
export const createWaitlistEntry = async (
  database: typeof DbType,
  entry: { id: string; email: string; status: 'pending' | 'approved' },
) => database.insert(waitlist).values(entry).onConflictDoNothing()

/** Approve a waitlist entry by ID. */
export const approveWaitlistEntry = async (database: typeof DbType, id: string) =>
  database.update(waitlist).set({ status: 'approved' }).where(eq(waitlist.id, id))
