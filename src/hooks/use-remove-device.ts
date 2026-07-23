/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useHttpClient } from '@/contexts'
import { removeRevokedBridgeDevice } from '@/lib/device-removal'
import { useMutation } from '@tanstack/react-query'

/**
 * Mutation for permanently removing a revoked bridge device.
 */
export const useRemoveDevice = () => {
  const httpClient = useHttpClient()

  return useMutation({
    mutationFn: (deviceId: string) => removeRevokedBridgeDevice(httpClient, deviceId),
  })
}
