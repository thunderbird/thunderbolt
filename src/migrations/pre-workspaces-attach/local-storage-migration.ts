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
 * Move semantics: copy the legacy value to the new key (only when the new
 * key isn't already set — the workspaces build's own value takes priority on
 * any pathological "both keys present" state, e.g. a downgrade/upgrade
 * cycle), then delete the legacy key so future boots short-circuit cleanly.
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
 * Returns `{ migratedToken, migratedDeviceId }` reflecting whether each legacy
 * key contributed a value to the new namespaced key. Useful for telemetry —
 * see `migration_storage_completed` in the plan.
 *
 * `false` covers both "legacy key absent" (already migrated or fresh install)
 * and "legacy key present but new key already had a value" (no-op promotion;
 * legacy key is still deleted).
 */
export type LocalStorageMigrationResult = {
  migratedToken: boolean
  migratedDeviceId: boolean
}

const migrateKey = (legacyKey: string, newKey: string): boolean => {
  const legacyValue = localStorage.getItem(legacyKey)
  if (legacyValue === null) {
    return false
  }
  const promoted = localStorage.getItem(newKey) === null
  if (promoted) {
    localStorage.setItem(newKey, legacyValue)
  }
  localStorage.removeItem(legacyKey)
  return promoted
}

export const migrateLocalStorageIfNeeded = (serverId: string): LocalStorageMigrationResult => ({
  migratedToken: migrateKey(legacyAuthTokenKey, namespacedAuthTokenKey(serverId)),
  migratedDeviceId: migrateKey(legacyDeviceIdKey, namespacedDeviceIdKey(serverId)),
})
