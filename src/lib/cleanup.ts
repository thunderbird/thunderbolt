/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDbFilenameFor } from '@/db/database-path'
import { broadcastDbLifecycle } from '@/db/db-lifecycle-broadcast'
import { resetDatabase } from '@/db/database'
import { disposeAllAdapters } from '@/acp/adapter-cache'
import { setSyncEnabled } from '@/db/powersync'
import {
  clearAuthToken as defaultClearAuthToken,
  clearDeviceId as defaultClearDeviceId,
  getAuthToken,
  withCapturedAuthToken,
} from '@/lib/auth-token'
import { deleteDbFile } from '@/lib/fs'
import { withTimeout } from '@/lib/timeout'
import { handleFullWipe as defaultHandleFullWipe } from '@/services/encryption'
import { initialLocalSettings, useLocalSettingsStore } from '@/stores/local-settings-store'
import { getActiveTrustDomain, useTrustDomainRegistry } from '@/stores/trust-domain-registry'
import { resetPostAuthBootstrap } from '@/lib/post-auth-bootstrap'

type CleanupDeps = {
  clearAuthToken?: (serverId?: string) => void
  clearDeviceId?: (serverId?: string) => void
  handleFullWipe?: (serverId?: string) => Promise<void>
}

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
 *
 * The `deps` parameter exists for testing: pass mock functions to observe the call
 * sequence without mocking shared modules globally.
 */
/**
 * Reset module-level state that doesn't live in the DB / IDB / localStorage:
 * the active-workspace store (and, transitively via the bootstrap reset, the
 * inflight bootstrap promise). Done early so any concurrent observers can't
 * see a stale workspace id after the wipe begins.
 */
const resetVolatileStores = (): void => {
  resetPostAuthBootstrap()
}

export const clearLocalData = async ({
  clearAuthToken = defaultClearAuthToken,
  clearDeviceId = defaultClearDeviceId,
  handleFullWipe = defaultHandleFullWipe,
}: CleanupDeps = {}): Promise<void> => {
  resetVolatileStores()

  const trustDomain = getActiveTrustDomain()
  // Capture the serverId BEFORE we empty `activeTrustDomain` from the
  // registry (below). The credential clearers default to reading serverId
  // from the registry; once it's cleared they'd no-op and the per-server
  // localStorage keys would survive the wipe.
  const serverIdForClear = trustDomain?.kind === 'server' ? trustDomain.serverId : undefined

  // Tear down every warm ACP connection first so no agent transport survives
  // across user identities (sign-out, account deletion, device revocation all
  // funnel through here).
  try {
    await disposeAllAdapters()
  } catch (error) {
    console.error('[clearLocalData] Failed to dispose ACP adapters:', error)
  }

  // Clear the registry's `activeTrustDomain` BEFORE broadcasting `db-closing`
  // (step 2 below). Other tabs receive the broadcast and reload; on reload
  // they re-read the persisted registry and now see no active trust domain,
  // so boot resolves to `NO_TRUST_DOMAIN` → ModePicker. Without this they'd
  // boot into the same server entry and race our `resetDatabase` /
  // `deleteDbFile` by trying to reopen the same SQLite file. Our own tab
  // continues using the local `trustDomain` capture above, so the rest of
  // the wipe sequence still targets the right server.
  if (trustDomain) {
    useTrustDomainRegistry.setState({ activeTrustDomain: undefined })
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

  // Step 6: clear per-server credentials. No-op in standalone. The
  // `serverIdForClear` capture above feeds the explicit serverId — the
  // registry has already been emptied so the default lookup wouldn't find one.
  clearAuthToken(serverIdForClear)
  clearDeviceId(serverIdForClear)

  // Step 7: clear encryption keys (server-only — `handleFullWipe` throws on standalone
  // via `key-storage.ts`'s active-server guard; we skip it cleanly when there's no server).
  // Pass `serverIdForClear` explicitly because the registry was emptied above —
  // the default lookup inside `clearAllKeys` would no-op and the per-server
  // IDB database with all encryption keys would survive the wipe.
  if (trustDomain?.kind === 'server') {
    try {
      await handleFullWipe(serverIdForClear)
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
  ...deps
}: {
  signOut?: () => Promise<void>
  onComplete: () => void
} & CleanupDeps): Promise<void> => {
  // Two ordering constraints have to hold together:
  //   1. The wipe runs BEFORE signOut so Better Auth's session cache stays
  //      populated during it — otherwise useSession() flips to null mid-wipe
  //      and AuthGate could redirect to /sso-redirect (SSO) or /waitlist
  //      between awaits, kicking off a new IdP sign-in before onComplete()
  //      navigates away.
  //   2. The auth token has to stay present THROUGH signOut() so the HTTP
  //      call to /sign-out is authenticated and the server can revoke the
  //      session row. Clearing it before signOut() (as the previous version
  //      did, inside clearLocalData) sent the request bearer-less and left
  //      the session valid server-side until natural expiry.
  // Resolve below: pass no-op credential-clear callbacks into clearLocalData
  // so the wipe runs in its normal order WITHOUT touching the token, capture
  // the token before the registry is emptied, and replay it via
  // `withCapturedAuthToken` so Better Auth's `auth.token` callback returns it
  // when signOut runs. Then clear credentials ourselves.
  const clearAuthToken = deps.clearAuthToken ?? defaultClearAuthToken
  const clearDeviceId = deps.clearDeviceId ?? defaultClearDeviceId
  // Capture serverId + token BEFORE clearLocalData empties `activeTrustDomain`
  // from the registry. Both are registry-derived: the deferred credential
  // clear below would otherwise no-op, and `getAuthToken()` inside
  // Better Auth's signOut fetch would return null, sending the request
  // bearer-less.
  const trustDomainAtStart = getActiveTrustDomain()
  const serverIdForClear = trustDomainAtStart?.kind === 'server' ? trustDomainAtStart.serverId : undefined
  const tokenAtStart = getAuthToken()

  try {
    await clearLocalData({ ...deps, clearAuthToken: () => {}, clearDeviceId: () => {} })
  } catch (error) {
    console.error('[signOutAndWipe] clearLocalData failed:', error)
  }

  if (signOut) {
    try {
      await withCapturedAuthToken(tokenAtStart, signOut)
    } catch (error) {
      console.error('[signOutAndWipe] signOut failed:', error)
    }
  }

  // Token is no longer useful: signOut() has revoked the session, or
  // RevokedDeviceModal is the caller (server already invalidated). Safe to
  // wipe locally without breaking the revoke call above.
  clearAuthToken(serverIdForClear)
  clearDeviceId(serverIdForClear)

  // onComplete fires synchronously right after the credential clear — no
  // await between them so React cannot schedule a re-render before the
  // hard navigation.
  onComplete()
}
