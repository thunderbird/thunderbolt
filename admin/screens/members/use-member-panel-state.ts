/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/contexts'
import type { AdminMember, AdminMemberWithWarning } from '@shared/admin-api'
import { adminQueryKeys } from '../../api/query-keys'
import { useAdminApi } from '../../api/use-admin-api'
import { useConnections } from '../../api/use-connections'
import type { ConnectionStatusById } from './member-rules'

/**
 * One member's detail and detaching one of their links, which answers with the member as it now
 * stands; the lists and break-glass refetch. Name, admin grant and groups change through the edit
 * form (`useMemberFormState`); block, unblock and permanent delete are the page's (`memberActions`).
 */
export const useMemberPanelState = (userId: string) => {
  const api = useAdminApi()
  const queryClient = useQueryClient()
  const selfId = useAuth().useSession().data?.user.id ?? null

  const member = useQuery({
    queryKey: adminQueryKeys.members.detail(userId),
    queryFn: () => api.members.get(userId),
  })
  const connections = useConnections()
  const connectionStatusById: ConnectionStatusById = new Map(
    (connections.data ?? []).map((connection) => [connection.id, connection.status]),
  )

  // The page's banner shows a detach that left no local admin, once break-glass refetches.
  const applied = async ({ warning: _warning, ...updated }: AdminMemberWithWarning) => {
    queryClient.setQueryData<AdminMember>(adminQueryKeys.members.detail(userId), updated)
    await Promise.all(
      [adminQueryKeys.members.all, adminQueryKeys.groups.all, adminQueryKeys.breakGlass].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    )
  }

  const detach = useMutation({
    mutationFn: (connectionId: string) => api.members.detachLink(userId, connectionId),
    onSuccess: applied,
  })

  return {
    member,
    selfId,
    connectionStatusById,
    detach,
  }
}

export type MemberPanelState = ReturnType<typeof useMemberPanelState>
