import { useCallback, useEffect, useState } from 'react'

/** Custom event names dispatched by the credentials-invalid listener */
export const showRevokedDeviceModalEvent = 'show_revoked_device_modal'
export const showResetOverlayEvent = 'show_reset_overlay'

type ResetOverlayState = { open: boolean; title: string; description: string }

/**
 * Listens for credential-related custom events (`show_revoked_device_modal`,
 * `show_reset_overlay`) and exposes the state needed to render the
 * `RevokedDeviceModal` and `ResetOverlay` components in `App`.
 */
export const useCredentialEvents = () => {
  const [revokedDeviceOpen, setRevokedDeviceOpen] = useState(false)
  const [resetOverlay, setResetOverlay] = useState<ResetOverlayState>({ open: false, title: '', description: '' })

  const handleRevokedDevice = useCallback(() => setRevokedDeviceOpen(true), [])
  const handleResetOverlay = useCallback((e: Event) => {
    const { title, description } = (e as CustomEvent<{ title: string; description: string }>).detail
    setResetOverlay({ open: true, title, description })
  }, [])

  useEffect(() => {
    window.addEventListener(showRevokedDeviceModalEvent, handleRevokedDevice)
    window.addEventListener(showResetOverlayEvent, handleResetOverlay)
    return () => {
      window.removeEventListener(showRevokedDeviceModalEvent, handleRevokedDevice)
      window.removeEventListener(showResetOverlayEvent, handleResetOverlay)
    }
  }, [handleRevokedDevice, handleResetOverlay])

  return { revokedDeviceOpen, resetOverlay }
}
