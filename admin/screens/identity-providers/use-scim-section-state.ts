/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useReducer } from 'react'
import type { AdminConnectionDetail } from '@shared/admin-api'
import { toExpiresAt } from './credential-expiry'
import {
  useCreateScimConnection,
  useRetireScim,
  useRevokeScimCredential,
  useRotateScimCredential,
} from './use-connection-queries'

type ScimSectionState = {
  /** The expiry date input (`YYYY-MM-DD`), empty for the server's default. */
  expiry: string
  revokeId: string | null
  confirmingRetire: boolean
}

/**
 * The Provisioning tab: enable SCIM, issue and revoke credentials, retire SCIM. A token lives only
 * in its mutation's result, which `dismissIssued` drops; `secretMutationOptions` keeps no copy. Only
 * one token is ever pending, and the page stays dirty while it shows, so the discard prompt guards
 * leaving before it was copied.
 */
export const useScimSectionState = (detail: Pick<AdminConnectionDetail, 'id'>, onDirty: (dirty: boolean) => void) => {
  const [state, patch] = useReducer(
    (current: ScimSectionState, update: Partial<ScimSectionState>) => ({ ...current, ...update }),
    { expiry: '', revokeId: null, confirmingRetire: false },
  )
  const enable = useCreateScimConnection()
  const rotate = useRotateScimCredential(detail.id)
  const revoke = useRevokeScimCredential(detail.id)
  const retire = useRetireScim(detail.id)

  const issued = enable.data ?? rotate.data ?? null
  const canIssue = !issued && !enable.isPending && !rotate.isPending
  // A token is shown once, when its request returns, so the panel guards against leaving from the moment
  // it's asked for, not only once it arrives.
  const issueOptions = { onSuccess: () => patch({ expiry: '' }), onError: () => onDirty(false) }
  const issue = (send: () => void) => {
    if (canIssue) {
      onDirty(true)
      send()
    }
  }

  return {
    ...state,
    setExpiry: (expiry: string) => patch({ expiry }),
    issued: issued && { token: issued.token, credential: issued.credential },
    dismissIssued: () => {
      enable.reset()
      rotate.reset()
      onDirty(false)
    },
    canIssue,
    enable: () =>
      issue(() =>
        enable.mutate({ identityConnectionId: detail.id, expiresAt: toExpiresAt(state.expiry) }, issueOptions),
      ),
    rotate: () => issue(() => rotate.mutate(toExpiresAt(state.expiry), issueOptions)),
    isIssuing: enable.isPending || rotate.isPending,
    issueError: enable.error ?? rotate.error,
    requestRevoke: (credentialId: string) => {
      revoke.reset()
      patch({ revokeId: credentialId })
    },
    cancelRevoke: () => patch({ revokeId: null }),
    confirmRevoke: () =>
      state.revokeId && revoke.mutate(state.revokeId, { onSuccess: () => patch({ revokeId: null }) }),
    isRevoking: revoke.isPending,
    revokeError: revoke.error,
    requestRetire: () => {
      retire.reset()
      patch({ confirmingRetire: true })
    },
    cancelRetire: () => patch({ confirmingRetire: false }),
    confirmRetire: () => retire.mutate(undefined, { onSuccess: () => patch({ confirmingRetire: false }) }),
    isRetiring: retire.isPending,
    retireError: retire.error,
  }
}
