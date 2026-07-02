/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useHttpClient } from '@/contexts'
import { setDeviceNodeIdWithProof } from '@/services/encryption'
import { useMutation } from '@tanstack/react-query'

/**
 * Mutation that binds a device row to an iroh P2P endpoint identity (node_id).
 * Goes through the canary-gated backend route, which writes the value and lets it
 * sync back down via PowerSync (invalidating the `['devices']` query).
 * Requires proof-of-CK-possession (canary secret) to prevent X-Device-ID spoofing.
 */
export const useSetDeviceNodeId = () => {
  const httpClient = useHttpClient()

  return useMutation({
    mutationFn: ({ deviceId, nodeId }: { deviceId: string; nodeId: string }) =>
      setDeviceNodeIdWithProof(httpClient, deviceId, nodeId),
  })
}
