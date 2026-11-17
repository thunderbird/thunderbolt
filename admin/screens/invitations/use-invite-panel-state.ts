/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { Invitation } from '@shared/admin-api'
import { AdminApiError } from '../../api/client'
import { adminQueryKeys } from '../../api/query-keys'
import { useAdminApi } from '../../api/use-admin-api'

/**
 * Inviting one address. An address on a domain an identity provider claims is refused; the admin
 * can then invite it anyway, which the backend records in the audit log.
 */
export const useInvitePanelState = (onInvited: (invitation: Invitation) => void) => {
  const api = useAdminApi()
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')

  const invite = useMutation({
    mutationFn: (idpOverride: boolean) =>
      api.invitations.create({ email: email.trim(), ...(idpOverride && { idpOverride }) }),
    onSuccess: async (invitation) => {
      await queryClient.invalidateQueries({ queryKey: adminQueryKeys.invitations.all })
      onInvited(invitation)
    },
  })
  const claimedByIdp = invite.error instanceof AdminApiError && invite.error.code === 'DOMAIN_CLAIMED_BY_IDP'

  return {
    email,
    /** A new address drops the last refusal, so an override is only ever offered for the address it was refused for. */
    setEmail: (value: string) => {
      setEmail(value)
      invite.reset()
    },
    invite: () => invite.mutate(false),
    inviteAnyway: () => invite.mutate(true),
    isPending: invite.isPending,
    claimedByIdp,
    error: claimedByIdp ? null : invite.error,
  }
}
