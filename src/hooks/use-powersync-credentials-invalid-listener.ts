import { getDevice } from '@/dal'
import { setSyncEnabled } from '@/db/powersync'
import { POWERSYNC_CREDENTIALS_INVALID } from '@/db/powersync/connector'
import { getDeviceId } from '@/lib/auth-token'
import { resetAppDir } from '@/lib/fs'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

/**
 * Performs a full app reset: disable sync, clear localStorage, reset app dir, then reload.
 * Used when account deleted (410), device revoked (403), or devices table shows revoked.
 */
const performCredentialsInvalidReset = async (): Promise<void> => {
  await setSyncEnabled(false)
  localStorage.clear()
  await resetAppDir()
  window.location.reload()
}

/**
 * Listens for credentials-invalid (410/403 on token refresh) and for devices table: when the
 * current device's row has revoked_at set (synced from another device), triggers reset.
 * Uses useQuery so device data refetches when PowerSync invalidates ['devices'].
 */
export const usePowerSyncCredentialsInvalidListener = (): void => {
  const hasTriggeredRef = useRef(false)
  const deviceId = getDeviceId()

  const { data: device } = useQuery({
    queryKey: ['devices', deviceId],
    queryFn: () => getDevice(deviceId),
  })

  useEffect(() => {
    const handler = () => {
      if (hasTriggeredRef.current) return
      hasTriggeredRef.current = true
      void performCredentialsInvalidReset()
    }

    window.addEventListener(POWERSYNC_CREDENTIALS_INVALID, handler)
    return () => window.removeEventListener(POWERSYNC_CREDENTIALS_INVALID, handler)
  }, [])

  useEffect(() => {
    if (!device?.revokedAt || hasTriggeredRef.current) return
    hasTriggeredRef.current = true
    void performCredentialsInvalidReset()
  }, [device?.revokedAt])
}
