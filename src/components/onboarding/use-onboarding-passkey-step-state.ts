/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useAuth } from '@/contexts'
import { accountPasskeyQueryKey, isPasskeyCancellation, registerPasskey } from '@/lib/passkey'
import { getDeviceDisplayName } from '@/lib/platform'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

type Status = 'idle' | 'registering' | 'error'

/** State for the onboarding passkey step: create the account's passkey. */
export const useOnboardingPasskeyStepState = () => {
  const authClient = useAuth()
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<Status>('idle')

  const register = async () => {
    setStatus('registering')
    try {
      await registerPasskey(authClient, getDeviceDisplayName())
      // Once the query sees the new passkey the wizard skips past this step,
      // so the spinner stays up until then.
      await queryClient.invalidateQueries({ queryKey: accountPasskeyQueryKey })
    } catch (error) {
      if (isPasskeyCancellation(error)) {
        setStatus('idle')
        return
      }
      console.error('Passkey registration failed:', error)
      setStatus('error')
    }
  }

  return { status, register }
}
