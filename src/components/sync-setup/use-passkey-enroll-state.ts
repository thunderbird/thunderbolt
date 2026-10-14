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

/**
 * - `no-prf` — the passkey works for sign-in, but its provider can't produce a
 *   PRF output, so it can't unlock sync.
 * - `needs-reauth` — the session is too old to add a passkey, so the user
 *   confirms it's them first.
 */
type EnrollStatus = 'idle' | 'working' | 'no-prf' | 'needs-reauth' | 'error'

/**
 * State for the sync-setup passkey step: create the account's passkey (or use the
 * one it already has), get its PRF output, and enroll it as the passkey slot.
 */
export const usePasskeyEnrollState = ({ onEnrolled }: { onEnrolled: () => void }) => {
  const authClient = useAuth()
  const httpClient = useHttpClient()
  const queryClient = useQueryClient()
  const { passkey: accountPasskey, isLoading } = useAccountPasskey()
  const [status, setStatus] = useState<EnrollStatus>('idle')

  /** Create the passkey, or reuse the existing one, and return its credential + PRF output. */
  const getCredentialAndPrf = async (): Promise<{ credentialId: string; prfOutput: Uint8Array | null }> => {
    if (accountPasskey) {
      return {
        credentialId: accountPasskey.credentialID,
        prfOutput: await getPasskeyPrfOutput(accountPasskey.credentialID),
      }
    }
    const { passkey, prfOutput } = await registerPasskey(authClient, getDeviceDisplayName())
    await queryClient.invalidateQueries({ queryKey: accountPasskeyQueryKey })
    // Some providers only release the PRF output on an assertion, not at creation.
    return {
      credentialId: passkey.credentialID,
      prfOutput: prfOutput ?? (await getPasskeyPrfOutput(passkey.credentialID)),
    }
  }

  const enroll = async () => {
    setStatus('working')
    try {
      // A re-authentication starts a new session, which must be bound to this
      // device. Done first, so a bind failure can't strand a passkey prompt.
      await ensureSessionBound(httpClient)
      const { credentialId, prfOutput } = await getCredentialAndPrf()
      if (!prfOutput) {
        setStatus('no-prf')
        return
      }
      await enrollPasskey(httpClient, { credentialId, prfOutput })
      onEnrolled()
    } catch (error) {
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
      setStatus('error')
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
