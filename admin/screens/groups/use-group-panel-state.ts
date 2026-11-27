/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { adminPageMaxSize, adminRole, type LocalGroup, type LocalGroupMember, type Page } from '@shared/admin-api'
import { adminQueryKeys } from '../../api/query-keys'
import { useAdminApi } from '../../api/use-admin-api'
import { cursorListKey, useCursorList } from '../../api/use-cursor-list'

/**
 * What a group's panels read: the group, its members, and its admin role mapping. Nothing loads
 * for a new group (`groupId` null).
 */
export const useGroupPanelState = (groupId: string | null) => {
  const api = useAdminApi()
  const queryClient = useQueryClient()
  const group = useQuery({
    queryKey: adminQueryKeys.groups.detail(groupId ?? ''),
    queryFn: () => api.groups.get(groupId!),
    enabled: groupId !== null,
    // The list already holds the group, so the panel opens on its name rather than a skeleton. Only
    // the page's paged list: a plain `useQuery` on the list key holds a single page.
    placeholderData: () =>
      queryClient
        .getQueryData<InfiniteData<Page<LocalGroup>>>(cursorListKey(adminQueryKeys.groups.list()))
        ?.pages.flatMap((page) => page.items)
        .find((item) => item.id === groupId),
  })
  const members = useCursorList<LocalGroupMember>({
    queryKey: adminQueryKeys.groups.members(groupId ?? ''),
    fetchPage: (cursor) => api.groups.listMembers(groupId!, { cursor, limit: adminPageMaxSize }),
    enabled: groupId !== null,
  })
  const mappingFilter = { localGroupId: groupId ?? '' }
  const mappings = useQuery({
    queryKey: adminQueryKeys.roleMappings.list(mappingFilter),
    queryFn: () => api.roleMappings.list(mappingFilter),
    enabled: groupId !== null,
  })
  const adminMapping = mappings.data?.find(
    (mapping) =>
      mapping.role === adminRole && mapping.target.kind === 'local_group' && mapping.target.groupId === groupId,
  )

  return { group, members, mappings, adminMapping }
}

export type GroupPanelState = ReturnType<typeof useGroupPanelState>
