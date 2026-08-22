/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { handleAppVersionUnsupported } from '@/lib/app-version-unsupported'
import { getAuthenticatedHeaders, getAuthToken } from '@/lib/auth-token'
import { isSsoMode } from '@/lib/auth-mode'
import type { AbstractPowerSyncDatabase, PowerSyncBackendConnector, PowerSyncCredentials } from '@powersync/web'
import { encodeForUpload, isEncryptionEnabled } from '@/db/encryption'
import { getAK, getPrimaryKeyId, storePrimaryKeyId } from '@/crypto'
import type { EncryptionMetadataResponse, KeyId } from '@shared/e2ee-types'
import { sanitizeErrorForTracking, trackSyncEvent } from './sync-tracker'

/**
 * Dispatched when the backend rejects credentials. The detail.reason discriminates handling:
 * - 410 (account deleted), 409 + DEVICE_ID_TAKEN, 400 + DEVICE_ID_REQUIRED → full reset
 * - 403 + DEVICE_DISCONNECTED → open revoked-device modal, preserve local data
 * - 401 (session expired) → open sign-in modal, preserve local data
 * - 403 + ANONYMOUS_SYNC_FORBIDDEN → backend says this session may not sync (e.g. anonymous user);
 *   we disable local sync via setSyncEnabled(false)
 */
export const powersyncCredentialsInvalid = 'powersync_credentials_invalid'

export type CredentialsInvalidReason =
  | 'account_deleted'
  | 'device_revoked'
  | 'device_id_taken'
  | 'device_id_required'
  | 'session_expired'
  | 'sync_not_permitted'

type TokenResponse = {
  token: string
  expiresAt: string
  powerSyncUrl: string
}

type ErrorBody = { code?: string; error?: string }

/**
 * Checks if the response indicates credentials are invalid (account deleted, device revoked, etc.).
 * If so, dispatches powersyncCredentialsInvalid and returns true.
 */
const getCredentialsInvalidReason = (status: number, body: ErrorBody): CredentialsInvalidReason | null => {
  if (status === 410) {
    return 'account_deleted'
  }
  if (status === 403 && body.code === 'DEVICE_DISCONNECTED') {
    return 'device_revoked'
  }
  if (status === 403 && body.code === 'ANONYMOUS_SYNC_FORBIDDEN') {
    return 'sync_not_permitted'
  }
  if (status === 409 && body.code === 'DEVICE_ID_TAKEN') {
    return 'device_id_taken'
  }
  if (status === 400 && body.code === 'DEVICE_ID_REQUIRED') {
    return 'device_id_required'
  }
  if (status === 401) {
    return 'session_expired'
  }
  return null
}

export const handleCredentialsInvalidIfNeeded = (status: number, body: ErrorBody): boolean => {
  const reason = getCredentialsInvalidReason(status, body)
  if (reason) {
    window.dispatchEvent(new CustomEvent(powersyncCredentialsInvalid, { detail: { reason } }))
    return true
  }
  return false
}

/**
 * PowerSync connector that handles authentication and data upload.
 * - fetchCredentials: Gets JWT tokens from the backend (requires auth)
 * - uploadData: Sends local changes to the backend for persistence (requires auth)
 *
 * `fetchFn` is injectable for tests; defaults to `globalThis.fetch`.
 */
export class ThunderboltConnector implements PowerSyncBackendConnector {
  constructor(
    private backendUrl: string,
    private fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  /**
   * Fetch credentials (JWT token) from the backend.
   * Returns null if unable to get credentials (e.g., not authenticated or PowerSync not configured).
   */
  async fetchCredentials(): Promise<PowerSyncCredentials | null> {
    const hadToken = Boolean(getAuthToken())
    const ssoMode = isSsoMode()
    const startedAt = performance.now()
    try {
      if (!hadToken && !ssoMode) {
        return null
      }

      if (!(await this.canDecryptAccountData())) {
        console.info('[PowerSync] Encryption keys not on this device yet — deferring sync')
        trackSyncEvent('sync_credentials_error', { error_code: 'KEYRING_MISSING', had_token: hadToken })
        return null
      }

      const tokenRequestStartedAt = performance.now()
      const response = await this.fetchFn(`${this.backendUrl}/powersync/token`, {
        headers: getAuthenticatedHeaders(),
        credentials: ssoMode ? 'include' : undefined,
      })
      console.info(`[PowerSync] /powersync/token: ${Math.round(performance.now() - tokenRequestStartedAt)}ms`)

      if (!response.ok) {
        const status = response.status
        let body: ErrorBody = {}
        try {
          body = (await response.json()) as ErrorBody
        } catch {
          // ignore
        }
        handleCredentialsInvalidIfNeeded(status, body)
        handleAppVersionUnsupported(status, body)
        // 401 surfaces as session_expired (modal opens) and DEVICE_NOT_TRUSTED is expected during setup,
        // so we don't pollute the console with those. ANONYMOUS_SYNC_FORBIDDEN is also quieted: the
        // listener immediately disables sync in response, so further requests don't happen — the log
        // would be the single transition event, which is fine to suppress. 503 is also quieted in
        // dev (fires repeatedly when POWERSYNC_URL is unset and is surfaced via doctor checks), but
        // in production a 503 is a real outage signal operators need to see.
        const isQuietStatus =
          status === 401 ||
          body.code === 'DEVICE_NOT_TRUSTED' ||
          body.code === 'ANONYMOUS_SYNC_FORBIDDEN' ||
          (status === 503 && import.meta.env.DEV)
        if (!isQuietStatus) {
          console.error('Failed to fetch PowerSync credentials:', status, body)
        }
        trackSyncEvent('sync_credentials_error', {
          status,
          error_code: body.code,
          had_token: hadToken,
        })
        return null
      }

      const data: TokenResponse = (await response.json()) as TokenResponse
      const expiresAt = new Date(data.expiresAt)
      trackSyncEvent('sync_credentials_fetch', {
        expires_in_ms: expiresAt.getTime() - Date.now(),
      })
      return {
        endpoint: data.powerSyncUrl,
        token: data.token,
        expiresAt,
      }
    } catch (error) {
      console.error('Error fetching PowerSync credentials:', error)
      trackSyncEvent('sync_credentials_error', { had_token: hadToken, error: sanitizeErrorForTracking(error) })
      return null
    } finally {
      console.info(`[PowerSync] fetchCredentials: ${Math.round(performance.now() - startedAt)}ms`)
    }
  }

  /**
   * Whether this device can read what the account's sync stream will deliver.
   *
   * The download counterpart to {@link ensureUploadEncryptionReady}. Decode runs
   * in the SharedWorker and its result is PERSISTED into local SQLite, so when a
   * keyless device receives encrypted rows the codec's pre-unlock passthrough
   * stores raw `__enc:…` strings as if they were values: the UI renders
   * ciphertext, and writing such a row back re-encrypts the ciphertext. There is
   * no way to defer a single value once the row is in the stream — so the fix is
   * to not open the stream at all until the keyring is present.
   *
   * Returning null credentials is the established "not ready, keep retrying"
   * channel here (the same one `DEVICE_NOT_TRUSTED` uses during setup), so sync
   * resumes on PowerSync's own retry once keys land — no extra wiring needed.
   *
   * An AK on this device is enough: a missing individual DEK is the codec's
   * key-request/self-heal case, not a reason to withhold the stream.
   */
  private async canDecryptAccountData(): Promise<boolean> {
    if (!isEncryptionEnabled() || (await getAK())) {
      return true
    }
    const account = await this.probeAccountEncryption()
    // 'absent' = the account never enabled E2EE, so its rows are plaintext and
    // readable. 'unknown' withholds the stream: an unprovable state must not be
    // treated as "nothing to decrypt".
    return account.status === 'absent'
  }

  /**
   * Whether the ACCOUNT has E2EE set up, independent of what this device holds.
   * `GET /encryption/canary` answers 200 with the metadata, or 404 ("Encryption
   * not set up") for an account that never enabled it.
   *
   * A failed probe (offline, 401/403/5xx) is `unknown`, never `absent` — "not
   * encrypted" may only be concluded from an explicit 404.
   */
  private async probeAccountEncryption(): Promise<
    { status: 'set-up'; primaryKeyId: KeyId } | { status: 'absent' } | { status: 'unknown' }
  > {
    try {
      const response = await this.fetchFn(`${this.backendUrl}/encryption/canary`, {
        headers: getAuthenticatedHeaders(),
        credentials: isSsoMode() ? 'include' : undefined,
      })
      if (response.status === 404) {
        return { status: 'absent' }
      }
      if (!response.ok) {
        return { status: 'unknown' }
      }
      const metadata = (await response.json()) as Pick<EncryptionMetadataResponse, 'primary_key_id'>
      return { status: 'set-up', primaryKeyId: metadata.primary_key_id }
    } catch {
      return { status: 'unknown' }
    }
  }
  /**
   * Guarantee this batch can be encrypted before `encodeForUpload` touches it.
   *
   * Encryption happens at upload time, so a CRUD op sits in `ps_crud` as
   * plaintext until it flushes. `codec.encode` fails OPEN when no primary key_id
   * resolves (`encodeWithoutKeys`) — correct for an account that never enabled
   * E2EE, catastrophic for one that did but whose keyring has not reached this
   * device yet: the queue flushes as plaintext the moment sync connects, before
   * the setup wizard runs. That is how a stale client's backlog leaks after an
   * upgrade.
   *
   * The codec cannot make this call itself — it also runs in the SharedWorker,
   * which has no auth token — so the connector resolves account state here and
   * THROWS rather than letting a batch through unencrypted. Throwing skips
   * `transaction.complete()`, so PowerSync simply retries: the writes wait,
   * intact, until the keyring lands.
   *
   * A stored primary key_id means setup completed and `codec.encode` enforces
   * its own fail-closed rule, so no probe is needed.
   */
  private async ensureUploadEncryptionReady(): Promise<void> {
    if (!isEncryptionEnabled() || (await getPrimaryKeyId()) !== null) {
      return
    }
    const account = await this.probeAccountEncryption()
    if (account.status === 'absent') {
      return // Genuinely pre-E2EE account — plaintext passthrough is by design.
    }
    if (account.status === 'unknown') {
      throw new Error('Cannot confirm account encryption state — deferring upload instead of risking plaintext')
    }
    if (!(await getAK())) {
      throw new Error('Account is E2EE but this device holds no access key — deferring upload instead of plaintext')
    }
    await storePrimaryKeyId(account.primaryKeyId)
  }

  /**
   * Upload local changes to the backend.
   * This is called by PowerSync when there are pending changes in the upload queue.
   */
  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    // Get the next batch of changes from the upload queue
    const transaction = await database.getNextCrudTransaction()

    if (!transaction) {
      return // No changes to upload
    }

    try {
      // Inside the try so a refusal is tracked and, crucially, leaves the
      // transaction uncompleted for PowerSync to retry.
      await this.ensureUploadEncryptionReady()

      // Convert CRUD operations to our API format (encrypt encrypted columns)
      const operations = await Promise.all(
        transaction.crud.map((op) =>
          encodeForUpload({
            op: op.op.toUpperCase() as 'PUT' | 'PATCH' | 'DELETE',
            type: op.table,
            id: op.id,
            data: op.opData,
          }),
        ),
      )

      console.info(`Uploading ${operations.length} operations to backend`)

      const response = await this.fetchFn(`${this.backendUrl}/powersync/upload`, {
        method: 'PUT',
        headers: { ...getAuthenticatedHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ operations }),
        credentials: isSsoMode() ? 'include' : undefined,
      })

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ErrorBody
        handleCredentialsInvalidIfNeeded(response.status, body)
        handleAppVersionUnsupported(response.status, body)
        throw new Error(`Upload failed: ${response.status} ${JSON.stringify(body)}`)
      }

      await transaction.complete()
      console.info('PowerSync upload completed successfully')
      trackSyncEvent('sync_upload', { operation_count: operations.length })
    } catch (error) {
      console.error('PowerSync upload failed:', error)
      trackSyncEvent('sync_upload_error', {
        error: sanitizeErrorForTracking(error),
        operation_count: transaction.crud.length,
      })
      // Don't call complete() - PowerSync will retry the upload
      throw error
    }
  }
}
