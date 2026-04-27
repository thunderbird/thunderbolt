/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import { user } from '@/db/auth-schema'
import { eq } from 'drizzle-orm'

/** Get a user by ID. Returns null if not found. */
export const getUserById = async (database: typeof DbType, id: string) =>
  database
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, id))
    .limit(1)
    .then((rows) => rows[0] ?? null)

/** Get a user by email. Returns null if not found. */
export const getUserByEmail = async (database: typeof DbType, email: string) =>
  database
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1)
    .then((rows) => rows[0] ?? null)

/** Hard-delete a user. Cascades to all related tables via FK constraints. */
export const deleteUser = async (database: typeof DbType, id: string) => database.delete(user).where(eq(user.id, id))

/** Mark a user as no longer new (after first sign-in). */
export const markUserNotNew = async (database: typeof DbType, id: string) =>
  database.update(user).set({ isNew: false }).where(eq(user.id, id))
