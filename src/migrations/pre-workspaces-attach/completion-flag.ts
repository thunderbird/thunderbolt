/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Per-device flags that record progress through the pre-Workspaces v1 data
 * migration (legacy un-namespaced localStorage / `thunderbolt-keys` IDB /
 * `thunderbolt-sync.db` SQLite → per-server namespaced layout + `server-<id>.db`).
 *
 * Stored in localStorage rather than the synced `settings` table because the
 * settings table syncs across devices (`WHERE user_id = bucket.user_id` in
 * config.yaml). A flag written there would propagate to other devices via
 * PowerSync and could race a fresh second device's first-time migration —
 * skipping the migration before it had a chance to read the local legacy file.
 * localStorage is naturally device-scoped and matches the namespacing pattern
 * already used for `thunderbolt_auth_token__<serverId>` and friends.
 *
 * Three flags:
 *
 *  - `global_completed` — DEVICE-GLOBAL (no serverId). Set after the SQLite
 *    migration succeeds for ANY server. Gates all three migration steps
 *    (localStorage / IDB keys / SQLite) on subsequent boots regardless of
 *    which server the user signs into. Without this, a user with cloud
 *    accounts on server A and server B would re-import the device-global
 *    legacy `thunderbolt-sync.db` into BOTH workspaces, bleeding account A's
 *    rows into account B's personal workspace.
 *  - `data_completed` — PER-SERVER. Set immediately after the destructive
 *    `ps_crud` replacement succeeds. Once set, the SQLite migration's retry
 *    on the same server skips the table-copy and queue-replacement steps so
 *    a partial-failure boot (where the later api-key stamp throws) doesn't
 *    re-run the queue replacement and wipe rows the user authored in the
 *    failed-state interim.
 *  - `completed` — PER-SERVER. Set after every step on a given server
 *    (including the api-key stamp) succeeds. Once set, subsequent boots for
 *    the SAME server short-circuit. Set independently of `data_completed` so
 *    the idempotent api-key stamp can keep retrying on later boots without
 *    re-running the destructive queue replacement.
 */

const globalCompletionFlagKey = 'pre_workspaces_attach_completed'

const completionFlagKeyFor = (serverId: string): string => `pre_workspaces_attach_completed__${serverId}`

const dataCompletionFlagKeyFor = (serverId: string): string => `pre_workspaces_attach_data_completed__${serverId}`

export const isGlobalCompletionFlagSet = (): boolean => localStorage.getItem(globalCompletionFlagKey) === '1'

export const setGlobalCompletionFlag = (): void => {
  localStorage.setItem(globalCompletionFlagKey, '1')
}

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
