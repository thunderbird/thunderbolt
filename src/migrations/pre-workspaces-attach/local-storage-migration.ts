/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Step 1 of the pre-Workspaces v1 data migration. Synchronously migrates the
 * un-namespaced auth-token and device-id localStorage keys to the per-server
 * namespaced layout the Workspaces v1 build expects:
 *
 *   thunderbolt_auth_token  → thunderbolt_auth_token__<serverId>
 *   thunderbolt_device_id   → thunderbolt_device_id__<serverId>
 *
 * Copy semantics (NOT move): the legacy value is copied to the new key only
 * when the new key isn't already set — the workspaces build's own value takes
 * priority on any pathological "both keys present" state (e.g. a
 * downgrade/upgrade cycle). The legacy key is **left in place indefinitely**
 * so a rollback to the pre-Workspaces build finds the user's auth state
 * intact. The new build never reads the un-namespaced keys, so leaving them
 * around has zero functional impact (a few hundred bytes of dead weight in
 * localStorage). Same rollback-safety stance as the legacy SQLite file (see
 * `docs/workspaces-v1-data-migration-plan.md`).
 *
 * Without this, a user with auth state from the pre-Workspaces build opens
 * the new build, `getAuthToken()` reads `thunderbolt_auth_token__<serverId>`
 * (empty), and they get bounced to the sign-in screen even though they had a
 * valid session moments ago.
 */

const legacyAuthTokenKey = 'thunderbolt_auth_token'
const legacyDeviceIdKey = 'thunderbolt_device_id'

const namespacedAuthTokenKey = (serverId: string): string => `thunderbolt_auth_token__${serverId}`
const namespacedDeviceIdKey = (serverId: string): string => `thunderbolt_device_id__${serverId}`

/**
 * Per-key sentinel marking that a legacy value has already been promoted to a
 * namespaced slot. Set on the first run that finds the legacy key — even if
 * the namespaced slot was already populated (downgrade/upgrade pathology) —
 * so subsequent runs against different `serverId`s don't bleed the same
 * legacy auth/device id into multiple server namespaces. The legacy key
 * itself stays in place for rollback safety; this just stops re-promotion.
 */
const promotedSentinelKey = (legacyKey: string): string => `${legacyKey}__promoted_to_namespaced`

/**
 * Returns `{ migratedToken, migratedDeviceId }` reflecting whether each legacy
 * key contributed a value to the new namespaced key. Useful for telemetry —
 * see `migration_storage_completed` in the plan.
 *
 * `false` covers both "legacy key absent" (already migrated or fresh install)
 * and "legacy key present but new key already had a value" (no-op promotion;
 * legacy key is preserved either way for rollback safety).
 */
export type LocalStorageMigrationResult = {
  migratedToken: boolean
  migratedDeviceId: boolean
}

const migrateKey = (legacyKey: string, newKey: string): boolean => {
  const sentinelKey = promotedSentinelKey(legacyKey)
  if (localStorage.getItem(sentinelKey) === '1') {
    // Legacy value already promoted to some serverId on a previous boot —
    // don't re-promote into a different serverId's namespace.
    return false
  }
  const legacyValue = localStorage.getItem(legacyKey)
  if (legacyValue === null) {
    return false
  }
  const promoted = localStorage.getItem(newKey) === null
  if (promoted) {
    localStorage.setItem(newKey, legacyValue)
  }
  // Set the sentinel whether or not we actually wrote — the legacy value has
  // logically been bound to a serverId now (this one, or whichever build
  // already populated the namespaced slot). Legacy key itself is preserved.
  localStorage.setItem(sentinelKey, '1')
  return promoted
}

export const migrateLocalStorageIfNeeded = (serverId: string): LocalStorageMigrationResult => ({
  migratedToken: migrateKey(legacyAuthTokenKey, namespacedAuthTokenKey(serverId)),
  migratedDeviceId: migrateKey(legacyDeviceIdKey, namespacedDeviceIdKey(serverId)),
})
