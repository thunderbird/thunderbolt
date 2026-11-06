/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useHttpClient } from '@/contexts'
import type { Device } from '@/dal'
import { approveDevice } from '@/services/encryption'
import { useMutation } from '@tanstack/react-query'

/**
 * Shared mutation for approving a pending device.
 * Used by both the pending device modal and the devices settings page.
 */
export const useApproveDevice = () => {
  const httpClient = useHttpClient()

  return useMutation({
    mutationFn: async ({ device, fingerprint }: { device: Device; fingerprint: string }) => {
      if (!device?.publicKey || !device?.mlkemPublicKey) {
        throw new Error('Device is missing public key(s)')
      }
      await approveDevice(httpClient, device.id, device.publicKey, device.mlkemPublicKey, fingerprint)
    },
  })
}
