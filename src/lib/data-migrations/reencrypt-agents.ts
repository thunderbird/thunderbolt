/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { eq } from 'drizzle-orm'
import { createSetting, hasSetting } from '@/dal/settings'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { hasStagedAK } from '@/db/encryption/codec'
import { getPowerSyncInstance } from '@/db/powersync/sync-state'
import { agentsTable } from '@/db/tables'
import type { DataMigration } from './index'

/**
 * Synced settings key marking that this account's agents rows have been
 * re-saved through the encrypting upload path. Synced (not local) on purpose:
 * one device doing the work spares the rest, and the identical-value races a
 * missing marker allows are harmless (the re-save is idempotent).
 */
export const agentsReencryptedMarker = 'agents_reencrypted_v2'

/**
 * Re-encrypt the account's `agents` rows (THU-874 enabler).
 *
 * `agents` synced in production BEFORE its columns joined `encryptedColumnsMap`
 * (THU-870 added them with v2), so every pre-v2 agents row sits PLAINTEXT on
 * the server in columns the download quarantine now refuses. Left alone, those
 * rows would be quarantined on every device enrolled after v2 setup — the
 * user's own agents silently missing. This migration removes the last
 * legitimate author of plaintext-in-a-mapped-column, which is exactly what
 * makes the quarantine a sound rule instead of a heuristic.
 *
 * Mechanism: DELETE + re-INSERT of each row (same values) in one local
 * transaction. Not an UPDATE, deliberately — PowerSync records update CRUD ops
 * as a diff of changed columns (`powersync_diff`), so re-saving identical
 * values produces an empty patch and the server copy never changes. The
 * delete+insert pair forces a full-row PUT, which the upload encoder encrypts.
 * The DELETE leg is the sanctioned PowerSync hard-delete exception: the net
 * effect is a rewrite of the same row, both ops ride one local transaction so
 * they upload as one batch, and remote devices converge through the same
 * DELETE→PUT sequence.
 *
 * Gates, each of which SKIPS WITHOUT MARKING so the migration retries on a
 * later launch:
 * - No staged AK: the account is not (yet) on E2EE — re-saving would upload
 *   plaintext again, and marking done would strand the rows when E2EE arrives.
 * - No completed sync: the device may not hold the account's agents rows yet.
 * - Zero local rows: indistinguishable from "this device never received them"
 *   (a fresh migrator's downloads were quarantined before landing). An
 *   agentless account pays one cheap SELECT per launch; an account whose rows
 *   live only on another device converges when that device runs this.
 *
 * TODO: delete this file once telemetry shows the active population carries
 * the marker (tracked on THU-874).
 */
type ReencryptAgentsGates = {
  /** The device holds a staged Account Key (the account writes encrypted). */
  hasStagedAK: () => Promise<boolean>
  /** This device has completed a full sync, so the account's rows are local. */
  hasCompletedSync: () => boolean
}

const defaultGates: ReencryptAgentsGates = {
  hasStagedAK,
  hasCompletedSync: () => getPowerSyncInstance()?.currentStatus?.hasSynced ?? false,
}

/** Gates injectable for tests (R-DITEST) — production uses `reencryptAgents` below. */
export const createReencryptAgents = (gates: ReencryptAgentsGates = defaultGates): DataMigration => ({
  id: 'reencrypt-agents',
  run: async (db: AnyDrizzleDatabase) => {
    if (await hasSetting(db, agentsReencryptedMarker)) {
      return
    }
    if (!(await gates.hasStagedAK())) {
      return
    }
    if (!gates.hasCompletedSync()) {
      return
    }

    // Soft-deleted rows included: their name/url are just as plaintext.
    const rows = await db.select().from(agentsTable)
    if (rows.length === 0) {
      return
    }

    for (const row of rows) {
      await db.transaction(async (tx) => {
        await tx.delete(agentsTable).where(eq(agentsTable.id, row.id))
        await tx.insert(agentsTable).values(row)
      })
    }

    await createSetting(db, agentsReencryptedMarker, new Date().toISOString())
    console.warn(`[reencrypt-agents] re-saved ${rows.length} agents row(s) through the encrypting upload path`)
  },
})

export const reencryptAgents = createReencryptAgents()
