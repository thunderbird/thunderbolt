/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useDeferredValue, useState } from 'react'
import { useAuth } from '@/contexts'
import { adminPageMaxSize, type CreateGroupBody, type LocalGroup, type LocalGroupMember } from '@shared/admin-api'
import { adminQueryKeys } from '../../api/query-keys'
import { useAdminApi } from '../../api/use-admin-api'
import { useCursorList } from '../../api/use-cursor-list'
import { hasBreakGlassWarning } from '../../components/break-glass-banner'
import { isSelfDemotingGroupRemoval } from '../members/member-rules'

/**
 * One local group, or a new one when `groupId` is null: its details, its members, and a server
 * search for members to add. Adding and removing a member each take effect at once.
 */
export const useGroupPanelState = (groupId: string | null, onCreated: (groupId: string) => void) => {
  const api = useAdminApi()
  const queryClient = useQueryClient()
  const [breakGlassWarning, setBreakGlassWarning] = useState(false)
  const [search, setSearch] = useState('')
  const q = useDeferredValue(search.trim()) || undefined

  const group = useQuery({
    queryKey: adminQueryKeys.groups.detail(groupId ?? ''),
    queryFn: () => api.groups.get(groupId!),
    enabled: groupId !== null,
  })
  const members = useCursorList<LocalGroupMember>({
    queryKey: adminQueryKeys.groups.members(groupId ?? ''),
    fetchPage: (cursor) => api.groups.listMembers(groupId!, { cursor, limit: adminPageMaxSize }),
    enabled: groupId !== null,
  })
  const candidates = useQuery({
    queryKey: adminQueryKeys.members.list(q),
    queryFn: () => api.members.list({ q, limit: adminPageMaxSize }),
    enabled: groupId !== null,
  })
  const memberIds = new Set(members.items.map((member) => member.userId))
  const selfId = useAuth().useSession().data?.user.id ?? null
  const self = useQuery({
    queryKey: adminQueryKeys.members.detail(selfId ?? ''),
    queryFn: () => api.members.get(selfId!),
    enabled: groupId !== null && selfId !== null && memberIds.has(selfId),
  })

  const refresh = () =>
    Promise.all(
      [adminQueryKeys.groups.all, adminQueryKeys.members.all, adminQueryKeys.breakGlass].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    )

  const save = useMutation({
    mutationFn: (body: CreateGroupBody) => (groupId ? api.groups.update(groupId, body) : api.groups.create(body)),
    onSuccess: async (saved: LocalGroup) => {
      queryClient.setQueryData(adminQueryKeys.groups.detail(saved.id), saved)
      if (!groupId) {
        onCreated(saved.id)
      }
      await queryClient.invalidateQueries({ queryKey: adminQueryKeys.groups.all })
    },
  })
  const addMember = useMutation({
    mutationFn: (userId: string) => api.groups.addMember(groupId!, userId),
    onSuccess: refresh,
  })
  const removeMember = useMutation({
    mutationFn: (userId: string) => api.groups.removeMember(groupId!, userId),
    onSuccess: async (result) => {
      setBreakGlassWarning(hasBreakGlassWarning(result))
      await refresh()
    },
  })

  return {
    group,
    members,
    /** Members matching the search who aren't in the group yet, as far as its loaded pages tell. */
    candidates: (candidates.data?.items ?? []).filter((member) => !memberIds.has(member.userId)),
    setSearch,
    /**
     * Whether removing `userId` takes admin away from the signed-in admin. Until their own detail
     * loads, removing themselves counts as demoting, so the confirm errs on the side of asking.
     */
    isSelfDemotingRemoval: (userId: string) =>
      userId === selfId && (!self.data || isSelfDemotingGroupRemoval(self.data, groupId!)),
    breakGlassWarning,
    save,
    addMember,
    removeMember,
  }
}

export type GroupPanelState = ReturnType<typeof useGroupPanelState>
