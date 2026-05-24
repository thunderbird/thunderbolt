/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Single source of truth for the authenticated User shape, shared by backend and frontend.
 *
 * The backend Drizzle schema in `backend/src/db/auth-schema.ts` is the canonical definition;
 * this type mirrors `typeof user.$inferSelect` so frontend code can import it without
 * depending on Drizzle or the backend package.
 *
 * Drift between this type and the Drizzle schema is caught at compile time by the
 * `_userTypeDriftCheck` assertion in `backend/src/db/auth-schema.ts` — if the schema
 * changes, update this type in lockstep or the backend type-check will fail.
 */
export type User = {
  id: string
  name: string
  email: string
  emailVerified: boolean
  image: string | null
  isNew: boolean
  isAnonymous: boolean
  createdAt: Date
  updatedAt: Date
}
