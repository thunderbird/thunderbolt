/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect } from 'react'

import { useAuth } from '@/contexts/auth-context'
import { useHttpClient } from '@/contexts/http-client-context'
import { ensureSessionBound } from '@/services/encryption'

/**
 * Keep this device's server-side session binding current (THU-873).
 *
 * Every trust route resolves its caller from `session.deviceId`, which is set
 * only at first registration or by the sealed-nonce bind handshake. A session
 * expiry followed by re-authentication therefore produces a session bound to
 * NOTHING — and that flow never reloads the page, so app-init binding alone
 * would leave the device unable to fetch its keyring, take a challenge, or
 * rotate until the next launch.
 *
 * Legitimate `useEffect`: this synchronizes an external system (the server's
 * session row) with the current auth state. It is not deriving state, and there
 * is no render output. `ensureSessionBound` is idempotent per bearer token, so
 * re-running it after the app-init bind is a no-op rather than a second
 * handshake.
 */
export const useDeviceSessionBinding = (): void => {
  const { data: session } = useAuth().useSession()
  const httpClient = useHttpClient()
  const sessionId = session?.session?.id ?? null

  useEffect(() => {
    if (!sessionId) {
      return
    }
    ensureSessionBound(httpClient).catch((error: unknown) => {
      // Non-fatal: the device keeps working offline and rebinds on the next
      // attempt. Trust routes fail closed in the meantime, which is the point.
      console.warn('[device-binding] failed to bind this session to the device:', error)
    })
  }, [sessionId, httpClient])
}
