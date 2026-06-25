/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Per-device, per-server flag that records whether the local SQLite migration
 * (legacy `thunderbolt-sync.db` → new `server-<id>.db`) has already run.
 *
 * Stored in localStorage rather than the synced `settings` table because the
 * settings table syncs across devices (`WHERE user_id = bucket.user_id` in
 * config.yaml). A flag written there would propagate to other devices via
 * PowerSync and could race a fresh second device's first-time migration —
 * skipping the migration before it had a chance to read the local legacy file.
 * localStorage is naturally device-scoped and matches the namespacing pattern
 * already used for `thunderbolt_auth_token__<serverId>` and friends.
 */

const flagKeyFor = (serverId: string): string => `pre_workspaces_attach_completed__${serverId}`

export const isCompletionFlagSet = (serverId: string): boolean => localStorage.getItem(flagKeyFor(serverId)) === '1'

export const setCompletionFlag = (serverId: string): void => {
  localStorage.setItem(flagKeyFor(serverId), '1')
}
