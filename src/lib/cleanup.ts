/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDbFilenameFor } from '@/db/database-path'
import { broadcastDbLifecycle } from '@/db/db-lifecycle-broadcast'
import { resetDatabase } from '@/db/database'
import { disposeAllAdapters } from '@/acp/adapter-cache'
import { setSyncEnabled } from '@/db/powersync'
import { clearAuthToken, clearDeviceId } from '@/lib/auth-token'
import { deleteDbFile } from '@/lib/fs'
import { withTimeout } from '@/lib/timeout'
import { handleFullWipe } from '@/services/encryption'
import { initialLocalSettings, useLocalSettingsStore } from '@/stores/local-settings-store'
import { getActiveTrustDomain } from '@/stores/trust-domain-registry'

/**
 * Unconditional wipe of the active trust domain's local data.
 *
 * Sequence (matches THU-549 ticket §5 / addendum decision #16):
 *   1. Disconnect PowerSync (best-effort — log + continue on failure).
 *   2. Broadcast `db-closing` so other tabs drop their handles before the file disappears.
 *   3. Close the DB connection in this tab.
 *   4. Delete the active trust domain's DB file from OPFS / Tauri app data.
 *   5. Broadcast `db-deleted` (informational — other tabs already reloaded on step 2).
 *   6. Clear the active server's namespaced auth token + device ID.
 *   7. Clear `thunderbolt-keys__<serverId>` encryption keys + reset codec cache.
 *
 * Standalone trust domains skip the auth-token / encryption-key steps (no server →
 * nothing namespaced). The DB file (`standalone.db`) is still removed.
 *
 * Does NOT reload or navigate — callers do that explicitly.
 */
export const clearLocalData = async (): Promise<void> => {
  const trustDomain = getActiveTrustDomain()

  // Tear down every warm ACP connection first so no agent transport survives
  // across user identities (sign-out, account deletion, device revocation all
  // funnel through here).
  try {
    await disposeAllAdapters()
  } catch (error) {
    console.error('[clearLocalData] Failed to dispose ACP adapters:', error)
  }

  // Step 1: flip the persisted `syncEnabled` flag to false and disconnect. The flag
  // matters as much as the disconnect: after `window.location.replace('/signed-out')`
  // the next page load runs the boot init, which background-connects sync when the
  // flag is true. Without an auth token (we clear it below) that connect would 401-loop
  // until `waitForFirstSync` hits its 10s ceiling — the `step3_waitForInitialSync: 10003ms`
  // shape. Calling `setSyncEnabled(false)` covers both: state + connection.
  try {
    await setSyncEnabled(false)
  } catch (error) {
    console.error('[clearLocalData] Failed to disable sync:', error)
  }

  // Step 2: tell other tabs before we yank the file out from under them.
  if (trustDomain) {
    broadcastDbLifecycle({ kind: 'db-closing', trustDomain })
  }

  // Step 3: close our own DB handle and clear the module-level reference. The
  // 10s timeout mirrors the old `resetAppDir` guard — if PowerSync's close hangs
  // (e.g. a locked OPFS handle from another tab) we don't block the rest of the wipe.
  try {
    await withTimeout(resetDatabase(), 10_000, 'resetDatabase')
  } catch (error) {
    console.error('[clearLocalData] Failed to close database:', error)
  }

  // Step 4: delete the active trust domain's DB file. Best-effort — `deleteDbFile`
  // already logs on failure, so a hung remote tab doesn't break the rest of the wipe.
  if (trustDomain) {
    await deleteDbFile(getDbFilenameFor(trustDomain))
    // Step 5: informational broadcast. Other tabs already reloaded on `db-closing`,
    // but this lets late subscribers (e.g. a tab woken by visibility change) skip
    // re-opening the now-deleted file.
    broadcastDbLifecycle({ kind: 'db-deleted', trustDomain })
  }

  // Reset local settings to defaults. Pre-trust-domain these lived in the SQLite DB
  // and disappeared with `resetAppDir`; now that they're in their own Zustand store,
  // the wipe has to clear them explicitly so theme/sync/native-fetch/etc. don't survive
  // a logout into the next user's session.
  useLocalSettingsStore.setState(initialLocalSettings)

  // Step 6: clear per-server credentials. No-op in standalone.
  clearAuthToken()
  clearDeviceId()

  // Step 7: clear encryption keys (server-only — `handleFullWipe` throws on standalone
  // via `key-storage.ts`'s active-server guard; we skip it cleanly when there's no server).
  if (trustDomain?.kind === 'server') {
    try {
      await handleFullWipe()
    } catch (error) {
      console.error('[clearLocalData] Failed to clear encryption keys:', error)
    }
  }
}

/**
 * Run the unconditional wipe, then hand off to `onComplete` (typically a hard
 * `window.location.*` call so the next paint is a fresh boot).
 *
 * Used by:
 *   - LogoutModal — pass `signOut` for the Better Auth call. `onComplete` branches
 *     SSO vs. consumer: SSO lands on `/signed-out` (no auto-redirect back to the
 *     IdP), consumer reloads (the unauth landing is sign-in / waitlist).
 *   - RevokedDeviceModal — no `signOut` (the server already invalidated the
 *     session); `onComplete` replaces to `/` and re-boots into the unauth landing.
 *
 * Each step swallows its own failure so `onComplete` always fires.
 */
export const signOutAndWipe = async ({
  signOut,
  onComplete,
}: {
  signOut?: () => Promise<void>
  onComplete: () => void
}): Promise<void> => {
  if (signOut) {
    try {
      await signOut()
    } catch (error) {
      console.error('[signOutAndWipe] signOut failed:', error)
    }
  }

  try {
    await clearLocalData()
  } catch (error) {
    console.error('[signOutAndWipe] clearLocalData failed:', error)
  }

  onComplete()
}
