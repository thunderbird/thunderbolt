/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useHttpClient } from '@/contexts'
import { isE2eeReady } from '@/hooks/use-e2ee-ready'
import { refreshAK, revokeDeviceAndRotate, revokeDeviceWithProof } from '@/services/encryption'
import { useMutation, useQueryClient } from '@tanstack/react-query'

type UseRevokeDeviceDeps = {
  /** Dependency seams for the service calls (tests). */
  revokeAndRotate?: typeof revokeDeviceAndRotate
  revokePlain?: typeof revokeDeviceWithProof
}

/**
 * Mutation for revoking a device, used by the devices settings page.
 *
 * With E2EE v2 active, revocation cuts server access and then rotates both the
 * Account Key and the DEK, locking the revoked device out of the keyring. The
 * recovery slot is re-anchored to the user's existing recovery public keys, so
 * their phrase keeps working and revocation stays silent. Pre-E2EE accounts get
 * a plain revoke (server access cut only).
 *
 * The error is NOT swallowed and callers must render it (THU-887): a rotation
 * that fails after the cut leaves the removed device holding a usable account
 * key, and this mutation rejecting is the only synchronous signal of that.
 */
/**
 * Mutation for the revoke dialog's explicit "refresh keys" step (THU-872).
 *
 * A revocation deliberately never refreshes this device's account key as a
 * silent side effect — the canary that signs the revoke proof opens only under
 * the CURRENT key, so a device that fell behind a rotation gets
 * `StaleKeyMaterialError` instead, and this mutation is the user-visible
 * remedy: adopt the replaced envelope (witness-gated, `refreshAK`), after which
 * the caller retries the revoke.
 */
export const useRefreshKeys = () => {
  const httpClient = useHttpClient()
  return useMutation({ mutationFn: () => refreshAK(httpClient) })
}

export const useRevokeDevice = (deps: UseRevokeDeviceDeps = {}) => {
  const httpClient = useHttpClient()
  const queryClient = useQueryClient()
  const { revokeAndRotate = revokeDeviceAndRotate, revokePlain = revokeDeviceWithProof } = deps

  return useMutation({
    mutationFn: async (deviceId: string): Promise<void> => {
      if (await isE2eeReady()) {
        await revokeAndRotate(httpClient, deviceId)
        return
      }
      await revokePlain(httpClient, deviceId)
    },
    // On settled, not on error: a revocation whose response was lost looks like
    // a failure here and like a success on the server, and the owed-lockout list
    // is what resolves that — so re-read it either way.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['lockout-pending'] }),
  })
}
