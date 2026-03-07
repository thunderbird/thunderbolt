import { useCallback, useEffect, useState } from 'react'

/** Custom event name dispatched by the credentials-invalid listener */
export const showRevokedDeviceModalEvent = 'show_revoked_device_modal'

/**
 * Listens for credential-related custom events and exposes the state
 * needed to render the `RevokedDeviceModal` in `App`.
 */
export const useCredentialEvents = () => {
  const [revokedDeviceOpen, setRevokedDeviceOpen] = useState(false)

  const handleRevokedDevice = useCallback(() => setRevokedDeviceOpen(true), [])

  useEffect(() => {
    window.addEventListener(showRevokedDeviceModalEvent, handleRevokedDevice)
    return () => window.removeEventListener(showRevokedDeviceModalEvent, handleRevokedDevice)
  }, [handleRevokedDevice])

  return { revokedDeviceOpen }
}
