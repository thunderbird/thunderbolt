/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useHttpClient } from '@/contexts'
import { fetchLockoutPending } from '@/api/encryption'
import { useE2eeReady } from '@/hooks/use-e2ee-ready'
import { finishDeviceLockout } from '@/services/encryption'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

const lockoutPendingKey = ['lockout-pending'] as const

/**
 * Revoked devices whose AK rotation never landed, so the account key they hold
 * is still the live one (THU-887).
 *
 * Server-derived rather than remembered locally, which is the whole point: a
 * revocation that failed on a laptop is visible on the phone, and survives the
 * tab being closed. The devices page is otherwise driven entirely by the synced
 * `devices` table; this is the one fact it cannot read from there, because
 * nothing in that table records whether the keyring moved.
 *
 * Gated on local readiness: the endpoint resolves the caller from its bound
 * device, so a pre-E2EE or mid-setup device would only ever get a 403.
 */
export const useLockoutPending = () => {
  const httpClient = useHttpClient()
  const isReady = useE2eeReady()

  const { data } = useQuery({
    queryKey: lockoutPendingKey,
    queryFn: () => fetchLockoutPending(httpClient),
    enabled: isReady,
  })

  return new Set(data?.device_ids ?? [])
}

/**
 * Finish a revocation whose AK rotation never landed: rotate the account key and
 * mint a fresh primary DEK.
 *
 * Explicitly user-triggered. Retrying this automatically off a server-supplied
 * signal would let a malicious server induce endless rotations, and every
 * rotation mints a keyring row — a denial of service invented to fix a
 * visibility bug. See `finishDeviceLockout`.
 */
export const useFinishLockout = () => {
  const httpClient = useHttpClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => finishDeviceLockout(httpClient),
    // The rotation is what clears the owed list, so re-read it rather than
    // assuming success emptied it — a partial failure must stay visible.
    onSettled: () => queryClient.invalidateQueries({ queryKey: lockoutPendingKey }),
  })
}
