/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useState } from 'react'

/** Custom event name dispatched by the credentials-invalid listener */
export const showRevokedDeviceModalEvent = 'show_revoked_device_modal'

/** Dispatched when a session has expired and the user should be prompted to sign in again. */
export const showSignInModalEvent = 'show_sign_in_modal'

/** Dispatched after a successful re-authentication so listeners can reset their dedup state. */
export const signInSuccessEvent = 'sign_in_success'

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
