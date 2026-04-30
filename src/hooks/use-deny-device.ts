/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useHttpClient } from '@/contexts'
import { denyDeviceWithProof } from '@/services/encryption'
import { useMutation } from '@tanstack/react-query'

/**
 * Mutation for denying a pending device without revoking it.
 * Sets approval_pending = false so the device disappears from the pending list
 * but stays registered and can re-request approval.
 * Requires proof-of-CK-possession (canary secret) to prevent X-Device-ID spoofing.
 */
export const useDenyDevice = () => {
  const httpClient = useHttpClient()

  return useMutation({
    mutationFn: (deviceId: string) => denyDeviceWithProof(httpClient, deviceId),
  })
}
