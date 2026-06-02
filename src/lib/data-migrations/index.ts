/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { automationsToSkills } from './automations-to-skills'

/**
 * Runtime data migrations.
 *
 * SQL schema migrations live on the backend / in Drizzle; this is for
 * transformations that need to *read or write user content*. We can't do
 * those server-side because `name` / `description` / `instruction` /
 * `prompt` / `title` columns are end-to-end encrypted — only the user's
 * device has the key. Anything that needs to understand content has to
 * run on the device, per-user, at app init.
 *
 * Contract for each migration:
 * - **Idempotent.** It runs on every app launch. A second pass after a
 *   successful first pass must be a no-op.
 * - **Forward-compatible across devices.** Two devices running the same
 *   migration on the same input must converge on the same result. Use
 *   deterministic ids and let PowerSync's `onConflictDoNothing` settle
 *   the cross-device race.
 * - **Atomic per unit of work.** Wrap the smallest meaningful unit (one
 *   row → one row) in a Drizzle transaction. PowerSync uploads each row
 *   independently, so cross-device the two halves replicate eventually;
 *   on a single device the tx guarantees no half-written state.
 * - **Self-deleting once it's done its job.** Once the migration has run
 *   on every active user (confirm via telemetry), the migration code can
 *   be deleted in a follow-up PR. Add a `DELETE ME` note pointing at the
 *   cleanup ticket so future maintainers know when it's safe.
 */
export type DataMigration = {
  /** Stable identifier — appears in logs and telemetry, never reused. */
  id: string
  run: (db: AnyDrizzleDatabase) => Promise<void>
}

const migrations: readonly DataMigration[] = [automationsToSkills] as const

/**
 * Run every registered migration in order. One migration failing logs and
 * is reported but does NOT block subsequent migrations — each runs again
 * on the next launch.
 */
export const runDataMigrations = async (db: AnyDrizzleDatabase): Promise<void> => {
  for (const migration of migrations) {
    try {
      await migration.run(db)
    } catch (error) {
      console.error(`Data migration "${migration.id}" failed:`, error)
    }
  }
}
