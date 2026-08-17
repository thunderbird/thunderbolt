/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useHttpClient } from '@/contexts'
import { isE2eeReady } from '@/hooks/use-e2ee-ready'
import { revokeDeviceAndRotate, revokeDeviceWithProof } from '@/services/encryption'
import { useMutation } from '@tanstack/react-query'

type UseRevokeDeviceDeps = {
  /** Dependency seams for the service calls (tests). */
  revokeAndRotate?: typeof revokeDeviceAndRotate
  revokePlain?: typeof revokeDeviceWithProof
}

/**
 * Mutation for revoking a device, used by the devices settings page.
 *
 * With E2EE v2 active, revocation rotates both the Account Key and the DEK
 * (locking the revoked device out of the keyring) and resolves with the NEW
 * 24-word recovery phrase — the caller MUST display it (the old phrase is
 * dead). Pre-E2EE accounts get a plain revoke (server access cut only) and
 * resolve with null.
 */
export const useRevokeDevice = (deps: UseRevokeDeviceDeps = {}) => {
  const httpClient = useHttpClient()
  const { revokeAndRotate = revokeDeviceAndRotate, revokePlain = revokeDeviceWithProof } = deps

  return useMutation({
    mutationFn: async (deviceId: string): Promise<string | null> => {
      if (await isE2eeReady()) {
        return revokeAndRotate(httpClient, deviceId)
      }
      await revokePlain(httpClient, deviceId)
      return null
    },
  })
}
