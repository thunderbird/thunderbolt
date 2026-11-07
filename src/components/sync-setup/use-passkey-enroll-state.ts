/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useAuth, useHttpClient } from '@/contexts'
import {
  accountPasskeyQueryKey,
  getPasskeyPrfOutput,
  isPasskeyCancellation,
  isSessionNotFresh,
  registerPasskey,
  useAccountPasskey,
} from '@/lib/passkey'
import { getDeviceDisplayName } from '@/lib/platform'
import { enrollPasskey, ensureSessionBound } from '@/services/encryption'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useAsyncAttempt } from '@/hooks/use-async-attempt'

/**
 * - `no-prf` — the passkey works for sign-in, but its provider can't produce a
 *   PRF output, so it can't unlock sync.
 * - `needs-reauth` — the session is too old to add a passkey, so the user
 *   confirms it's them first.
 */
type EnrollStatus = 'idle' | 'working' | 'no-prf' | 'needs-reauth' | 'error'

/**
 * State for the passkey step: create the account's passkey (or use the one it
 * already has) and, when `unlocksSync`, get its PRF output and enroll it as the
 * passkey slot. Otherwise the passkey is for sign-in only.
 */
export const usePasskeyEnrollState = ({
  unlocksSync,
  onEnrolled,
  onBusyChange,
}: {
  /** Enroll the passkey slot; needs this device's sync keys (an AK rotation). */
  unlocksSync: boolean
  onEnrolled: () => void
  /** Lets the modal block dismissal while an enrollment is in flight. */
  onBusyChange: (isBusy: boolean) => void
}) => {
  const authClient = useAuth()
  const httpClient = useHttpClient()
  const queryClient = useQueryClient()
  const { passkey: accountPasskey, isLoading } = useAccountPasskey()
  const [status, setStatus] = useState<EnrollStatus>('idle')
  const operation = useAsyncAttempt()

  const createPasskey = async () => {
    const result = await registerPasskey(authClient, getDeviceDisplayName())
    await queryClient.invalidateQueries({ queryKey: accountPasskeyQueryKey })
    return result
  }

  /** Create the passkey, or reuse the existing one, and return its credential + PRF output. */
  const getCredentialAndPrf = async (
    isCurrent: () => boolean,
  ): Promise<{ credentialId: string; prfOutput: Uint8Array | null } | null> => {
    if (accountPasskey) {
      return {
        credentialId: accountPasskey.credentialID,
        prfOutput: await getPasskeyPrfOutput(accountPasskey.credentialID),
      }
    }
    const { passkey, prfOutput } = await createPasskey()
    if (!isCurrent()) {
      return null
    }
    // Some providers only release the PRF output on an assertion, not at creation.
    return {
      credentialId: passkey.credentialID,
      prfOutput: prfOutput ?? (await getPasskeyPrfOutput(passkey.credentialID)),
    }
  }

  const enroll = async () => {
    const attempt = operation.begin()
    if (!attempt) {
      return
    }
    setStatus('working')
    onBusyChange(true)
    try {
      if (!unlocksSync) {
        if (!accountPasskey) {
          await createPasskey()
        }
        if (attempt.isCurrent()) {
          onEnrolled()
        }
        return
      }
      // A re-authentication starts a new session, which must be bound to this
      // device. Done first, so a bind failure can't strand a passkey prompt.
      await ensureSessionBound(httpClient)
      if (!attempt.isCurrent()) {
        return
      }
      const credential = await getCredentialAndPrf(attempt.isCurrent)
      if (!credential || !attempt.isCurrent()) {
        return
      }
      const { credentialId, prfOutput } = credential
      if (!prfOutput) {
        setStatus('no-prf')
        return
      }
      await enrollPasskey(httpClient, { credentialId, prfOutput })
      if (attempt.isCurrent()) {
        onEnrolled()
      }
    } catch (error) {
      if (!attempt.isCurrent()) {
        return
      }
      if (isPasskeyCancellation(error)) {
        setStatus('idle')
        return
      }
      if (isSessionNotFresh(error)) {
        setStatus('needs-reauth')
        return
      }
      console.error('Passkey enrollment failed:', error)
      // A failure may mean the account gained a passkey elsewhere (registration
      // refused as a duplicate): refresh, so a retry uses it instead of looping.
      await queryClient.invalidateQueries({ queryKey: accountPasskeyQueryKey })
      if (attempt.isCurrent()) {
        setStatus('error')
      }
    } finally {
      if (attempt.isCurrent()) {
        onBusyChange(false)
      }
      attempt.finish()
    }
  }

  return {
    hasPasskey: !!accountPasskey,
    isLoading,
    status,
    enroll,
    // Back to the step after confirming: the passkey prompt needs a fresh tap.
    onReauthenticated: () => setStatus('idle'),
  }
}
