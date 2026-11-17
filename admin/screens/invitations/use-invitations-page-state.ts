/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { adminPageMaxSize, type Invitation, type InvitationStatus } from '@shared/admin-api'
import { adminQueryKeys } from '../../api/query-keys'
import { useAdminApi } from '../../api/use-admin-api'
import { useCursorList } from '../../api/use-cursor-list'
import { useResourcePageState } from '../../components/use-resource-page-state'

/** Invitations in one status (pending first), the invite panel (`?edit=new`), and revoking one. */
export const useInvitationsPageState = () => {
  const api = useAdminApi()
  const queryClient = useQueryClient()
  const page = useResourcePageState()
  const [status, setStatus] = useState<InvitationStatus>('pending')
  const [lastInvited, setLastInvited] = useState<string | null>(null)
  const list = useCursorList<Invitation>({
    queryKey: adminQueryKeys.invitations.list(status),
    fetchPage: (cursor) => api.invitations.list({ status, cursor, limit: adminPageMaxSize }),
  })

  const revoke = async (invitationId: string) => {
    await api.invitations.revoke(invitationId)
    await queryClient.invalidateQueries({ queryKey: adminQueryKeys.invitations.all })
  }

  /** After an invite: close the panel and show the pending list, where it now is. */
  const invited = (invitation: Invitation) => {
    setLastInvited(invitation.email)
    setStatus('pending')
    page.select(null)
  }

  return { page, status, setStatus, list, revoke, invited, lastInvited }
}
