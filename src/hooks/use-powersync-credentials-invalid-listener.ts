import { useDatabase } from '@/contexts'
import { getDevice } from '@/dal'
import { powersyncCredentialsInvalid } from '@/db/powersync/connector'
import type { CredentialsInvalidReason } from '@/db/powersync/connector'
import { showRevokedDeviceModalEvent } from '@/hooks/use-credential-events'
import { getAuthToken, getDeviceId } from '@/lib/auth-token'
import { clearLocalData } from '@/lib/cleanup'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useEffect, useRef } from 'react'

/**
 * Full app reset when credentials are no longer valid: disable PowerSync sync, clear
 * localStorage (token + device id), reset app directory (DB), then navigate away.
 * Leaves the user in a clean signed-out state so they can sign in again or use the app offline.
 */
const performCredentialsInvalidReset = async (redirectTo: string): Promise<void> => {
  await clearLocalData()
  window.location.replace(redirectTo)
}

/**
 * Listens for "credentials invalid" and triggers a full app reset in two cases:
 *
 * 1. **Event (powersyncCredentialsInvalid)** – Fired when the backend returns 410 (account
 *    deleted), 403 (device revoked), or 409 (device id taken by another user) e.g. from the
 *    account-verify endpoint during app init or from PowerSync token refresh. We just run
 *    the reset handler.
 *
 * 2. **Devices table (synced via PowerSync)** – We have a token and a device id (we consider
 *    ourselves a logged-in device). We watch the current device row:
 *    - **revokedAt set** – User revoked this device from another device; show revoked modal.
 *    - **Device row missing** – Only reset if we had seen the device in this session and it
 *      then disappeared (account deleted elsewhere; PowerSync synced and wiped user data).
 *      We do not reset when the device is missing on first load: the local DB may not have
 *      synced the devices table yet, so "missing" would incorrectly clear storage and log
 *      the user out after a refresh.
 *
 * This hook must be called from AuthProvider (at the top, before the early return). When
 * the account is deleted, sync wipes the DB so settings/cloudUrl disappear, AuthProvider
 * returns null and never renders children. If the listener lived under those children, it
 * would never run. By running it inside AuthProvider before the `if (!value) return null`,
 * the listener stays active and can trigger reset even when the rest of the app doesn't
 * render.
 */
export const usePowerSyncCredentialsInvalidListener = (): void => {
  const db = useDatabase()
  const hasTriggeredResetRef = useRef(false)
  const hasDispatchedRevokedModalRef = useRef(false)
  const hadDeviceOnceRef = useRef(false)
  const deviceId = getDeviceId()

  const { data = [], isFetched } = useQuery({
    queryKey: ['devices', deviceId],
    query: toCompilableQuery(getDevice(db, deviceId)),
  })

  const device = data[0] ?? null

  // Handle 410/403 from verify endpoint or PowerSync token refresh (event-driven).
  useEffect(() => {
    const handler = (event: Event) => {
      if (hasTriggeredResetRef.current) {
        return
      }

      const reason = (event as CustomEvent<{ reason: CredentialsInvalidReason }>).detail?.reason

      if (reason === 'device_revoked') {
        if (!hasDispatchedRevokedModalRef.current) {
          hasDispatchedRevokedModalRef.current = true
          window.dispatchEvent(new CustomEvent(showRevokedDeviceModalEvent))
        }
        return
      }

      hasTriggeredResetRef.current = true
      void performCredentialsInvalidReset(reason === 'account_deleted' ? '/account-deleted' : '/')
    }

    window.addEventListener(powersyncCredentialsInvalid, handler)
    return () => window.removeEventListener(powersyncCredentialsInvalid, handler)
  }, [])

  // Handle device revoked or device row missing (account deleted) from synced devices table.
  useEffect(() => {
    if (device != null) {
      hadDeviceOnceRef.current = true
    }

    const hasToken = Boolean(getAuthToken())

    if (hasTriggeredResetRef.current || !isFetched || !hasToken || !deviceId) {
      return
    }

    const revoked = device?.revokedAt != null
    const missingAfterHavingDevice = hadDeviceOnceRef.current && device == null

    if (revoked) {
      if (!hasDispatchedRevokedModalRef.current) {
        hasDispatchedRevokedModalRef.current = true
        window.dispatchEvent(new CustomEvent(showRevokedDeviceModalEvent))
      }
      return
    }

    if (missingAfterHavingDevice) {
      hasTriggeredResetRef.current = true
      void performCredentialsInvalidReset('/account-deleted')
    }
  }, [isFetched, deviceId, device])
}
