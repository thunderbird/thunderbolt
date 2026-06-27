/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Per-device, per-server flags that record progress through the local SQLite
 * migration (legacy `thunderbolt-sync.db` → new `server-<id>.db`).
 *
 * Stored in localStorage rather than the synced `settings` table because the
 * settings table syncs across devices (`WHERE user_id = bucket.user_id` in
 * config.yaml). A flag written there would propagate to other devices via
 * PowerSync and could race a fresh second device's first-time migration —
 * skipping the migration before it had a chance to read the local legacy file.
 * localStorage is naturally device-scoped and matches the namespacing pattern
 * already used for `thunderbolt_auth_token__<serverId>` and friends.
 *
 * Two flags, set in order:
 *
 *  - `data_completed` — set immediately after the destructive `ps_crud`
 *    replacement succeeds. Once set, subsequent boots skip the table-copy and
 *    queue-replacement steps. Without this, a partial-failure boot (where the
 *    later api-key stamp throws) would re-run the queue replacement on next
 *    boot and wipe any `ps_crud` rows the user authored in the failed-state
 *    interim — that's silent data loss.
 *  - `completed` — set after every step (including the api-key stamp)
 *    succeeds. Once set, subsequent boots short-circuit the whole migration.
 *    Set independently of `data_completed` so the idempotent api-key stamp
 *    can keep retrying on later boots without re-running the destructive
 *    queue replacement.
 */

const completionFlagKeyFor = (serverId: string): string => `pre_workspaces_attach_completed__${serverId}`

const dataCompletionFlagKeyFor = (serverId: string): string => `pre_workspaces_attach_data_completed__${serverId}`

export const isCompletionFlagSet = (serverId: string): boolean =>
  localStorage.getItem(completionFlagKeyFor(serverId)) === '1'

export const setCompletionFlag = (serverId: string): void => {
  localStorage.setItem(completionFlagKeyFor(serverId), '1')
}

export const isDataCompletionFlagSet = (serverId: string): boolean =>
  localStorage.getItem(dataCompletionFlagKeyFor(serverId)) === '1'

export const setDataCompletionFlag = (serverId: string): void => {
  localStorage.setItem(dataCompletionFlagKeyFor(serverId), '1')
}
