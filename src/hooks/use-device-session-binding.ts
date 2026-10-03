/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect } from 'react'

import { useAuth } from '@/contexts/auth-context'
import { useHttpClient } from '@/contexts/http-client-context'
import { powersyncCredentialsInvalid } from '@/db/powersync/connector'
import { HttpError } from '@/lib/http'
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
    ensureSessionBound(httpClient).catch(async (error: unknown) => {
      // A revoked device can NEVER bind, so "rebinds on the next attempt" leaves
      // it on "Connecting…" forever: the token route only ever reports
      // DEVICE_NOT_BOUND, which `connector.ts` rightly treats as a retryable
      // defer because that is what it means for every other device. This is the
      // one place the difference is visible, so it hands off to the revocation
      // flow and lets the user choose what happens to their local data.
      const body =
        error instanceof HttpError && error.response.status === 403
          ? ((await error.response
              .clone()
              .json()
              .catch(() => null)) as { code?: string } | null)
          : null
      if (body?.code === 'DEVICE_DISCONNECTED') {
        window.dispatchEvent(new CustomEvent(powersyncCredentialsInvalid, { detail: { reason: 'device_revoked' } }))
        return
      }
      // Everything else is transient: the device keeps working offline and
      // rebinds on the next attempt. Trust routes fail closed in the meantime,
      // which is the point.
      console.warn('[device-binding] failed to bind this session to the device:', error)
    })
  }, [sessionId, httpClient])
}
