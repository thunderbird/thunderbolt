import { getDevice } from '@/dal'
import { setSyncEnabled } from '@/db/powersync'
import { POWERSYNC_CREDENTIALS_INVALID } from '@/db/powersync/connector'
import { getAuthToken, getDeviceId } from '@/lib/auth-token'
import { resetAppDir } from '@/lib/fs'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

/**
 * Full app reset when credentials are no longer valid: disable PowerSync sync, clear
 * localStorage (token + device id), reset app directory (DB), then reload. Leaves the user
 * in a clean signed-out state so they can sign in again or use the app offline.
 */
const performCredentialsInvalidReset = async (): Promise<void> => {
  await setSyncEnabled(false)
  await resetAppDir()
  localStorage.clear()
  window.location.reload()
}

/**
 * Listens for "credentials invalid" and triggers a full app reset in two cases:
 *
 * 1. **Event (POWERSYNC_CREDENTIALS_INVALID)** – Fired when the backend returns 410 (account
 *    deleted) or 403 (device revoked) e.g. from the account-verify endpoint during app init
 *    or from PowerSync token refresh. We just run the reset handler.
 *
 * 2. **Devices table (synced via PowerSync)** – We have a token and a device id (we consider
 *    ourselves a logged-in device). We watch the current device row:
 *    - **revokedAt set** – User revoked this device from another device; reset.
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
 * the listener stays active and can trigger reset even when the rest of the app doesn’t
 * render.
 */
export const usePowerSyncCredentialsInvalidListener = (): void => {
  const hasTriggeredRef = useRef(false)
  const hadDeviceOnceRef = useRef(false)
  const deviceId = getDeviceId()

  const { data: device, isFetched } = useQuery({
    queryKey: ['devices', deviceId],
    queryFn: () => getDevice(deviceId),
  })

  // Handle 410/403 from verify endpoint or PowerSync token refresh (event-driven).
  useEffect(() => {
    const handler = () => {
      if (hasTriggeredRef.current) return
      hasTriggeredRef.current = true
      void performCredentialsInvalidReset()
    }

    window.addEventListener(POWERSYNC_CREDENTIALS_INVALID, handler)
    return () => window.removeEventListener(POWERSYNC_CREDENTIALS_INVALID, handler)
  }, [])

  // Handle device revoked or device row missing (account deleted) from synced devices table.
  useEffect(() => {
    if (device != null) hadDeviceOnceRef.current = true

    const hasToken = Boolean(getAuthToken())

    if (hasTriggeredRef.current) return
    if (!isFetched || !hasToken || !deviceId) return
    const revoked = device?.revokedAt != null
    const missingAfterHavingDevice = hadDeviceOnceRef.current && device == null
    const shouldReset = revoked || missingAfterHavingDevice
    if (!shouldReset) return
    hasTriggeredRef.current = true
    void performCredentialsInvalidReset()
  }, [isFetched, deviceId, device])
}
