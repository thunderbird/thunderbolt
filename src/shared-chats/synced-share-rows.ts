/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getPowerSyncInstance } from '@/db/powersync/sync-state'

/** Longest a share write waits for its change to reach this device's synced lists. */
const syncBackTimeoutMs = 10_000

/**
 * Wait until a query on this device's synced share lists returns what a share
 * write made here should leave behind. Writes go over REST while the lists only
 * come through PowerSync, so without this the lists — and a share dialog opened
 * next — would still show the share as it was. Best-effort, since the write
 * itself already succeeded: it returns at once when PowerSync is not connected,
 * and logs and returns when the lists have not caught up within ten seconds or
 * the watch fails. The lists then catch up whenever sync does.
 */
const waitForSyncedShareRows = async (sql: string, parameters: unknown[], isDone: (rows: unknown[]) => boolean) => {
  const powerSync = getPowerSyncInstance()
  if (!powerSync?.currentStatus.connected) {
    return
  }
  try {
    // On timeout the watch just ends, without throwing.
    for await (const result of powerSync.watch(sql, parameters, { signal: AbortSignal.timeout(syncBackTimeoutMs) })) {
      if (isDone(result.array)) {
        return
      }
    }
    console.warn('[shares] synced share lists did not catch up with a write', sql, parameters)
  } catch (err) {
    console.error('[shares] watching the synced share lists failed', err)
  }
}

/** Wait until this account's synced row of a share has reached `version`. */
export const waitForSentShareVersion = (shareId: string, version: number) =>
  waitForSyncedShareRows(
    'SELECT 1 FROM sent_shares WHERE id = ? AND version >= ?',
    [shareId, version],
    (rows) => rows.length > 0,
  )

/** Wait until a share this account stopped is gone from its synced list. */
export const waitForSentShareGone = (shareId: string) =>
  waitForSyncedShareRows('SELECT 1 FROM sent_shares WHERE id = ?', [shareId], (rows) => rows.length === 0)

/** Wait until a person taken off a share no longer shows on its synced row, or the share is gone. */
export const waitForRecipientGone = (shareId: string, recipientUserId: string) =>
  waitForSyncedShareRows(
    "SELECT 1 FROM sent_shares s, json_each(s.recipients) r WHERE s.id = ? AND json_extract(r.value, '$.userId') = ?",
    [shareId, recipientUserId],
    (rows) => rows.length === 0,
  )

/** Wait until a share this account removed is gone from its synced "Shared with me" list. */
export const waitForReceivedShareGone = (shareId: string) =>
  waitForSyncedShareRows('SELECT 1 FROM received_shares WHERE id = ?', [shareId], (rows) => rows.length === 0)
