/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useAuth } from '@/contexts'
import { adminRole, type AdminMember, type AdminMemberWithWarning } from '@shared/admin-api'
import { adminQueryKeys } from '../../api/query-keys'
import { useAdminApi } from '../../api/use-admin-api'
import { hasBreakGlassWarning } from '../../components/break-glass-banner'
import type { ConnectionStatusById } from './member-rules'

/**
 * One member's detail and every change an admin can make to them. Each change answers with the
 * member as it now stands, which replaces the cached detail; the lists and break-glass refetch.
 */
export const useMemberPanelState = (userId: string) => {
  const api = useAdminApi()
  const queryClient = useQueryClient()
  const selfId = useAuth().useSession().data?.user.id ?? null
  const [breakGlassWarning, setBreakGlassWarning] = useState(false)

  const member = useQuery({
    queryKey: adminQueryKeys.members.detail(userId),
    queryFn: () => api.members.get(userId),
  })
  const connections = useQuery({
    queryKey: adminQueryKeys.connections.list(),
    queryFn: () => api.connections.list(),
  })
  const connectionStatusById: ConnectionStatusById = new Map(
    (connections.data ?? []).map((connection) => [connection.id, connection.status]),
  )

  const applied = async ({ warning, ...updated }: AdminMemberWithWarning) => {
    queryClient.setQueryData<AdminMember>(adminQueryKeys.members.detail(userId), updated)
    setBreakGlassWarning(hasBreakGlassWarning({ warning }))
    await Promise.all(
      [adminQueryKeys.members.all, adminQueryKeys.groups.all, adminQueryKeys.breakGlass].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    )
  }

  const rename = useMutation({ mutationFn: (name: string) => api.members.update(userId, { name }), onSuccess: applied })
  const block = useMutation({
    mutationFn: (reason: string) => api.members.block(userId, reason ? { reason } : {}),
    onSuccess: applied,
  })
  const unblock = useMutation({ mutationFn: () => api.members.unblock(userId), onSuccess: applied })
  const grantAdmin = useMutation({ mutationFn: () => api.members.grantRole(userId, adminRole), onSuccess: applied })
  const revokeAdmin = useMutation({ mutationFn: () => api.members.revokeRole(userId, adminRole), onSuccess: applied })
  const detach = useMutation({
    mutationFn: (connectionId: string) => api.members.detachLink(userId, connectionId),
    onSuccess: applied,
  })

  return {
    member,
    selfId,
    connectionStatusById,
    breakGlassWarning,
    rename,
    block,
    unblock,
    grantAdmin,
    revokeAdmin,
    detach,
  }
}

export type MemberPanelState = ReturnType<typeof useMemberPanelState>
