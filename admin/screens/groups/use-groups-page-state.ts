/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { adminPageMaxSize, type LocalGroup } from '@shared/admin-api'
import { adminQueryKeys } from '../../api/query-keys'
import { useAdminApi } from '../../api/use-admin-api'
import { useCursorList } from '../../api/use-cursor-list'
import { useResourcePageState } from '../../components/use-resource-page-state'

/** The local groups list, the selected group (`new` while creating one), and deleting a group. */
export const useGroupsPageState = () => {
  const api = useAdminApi()
  const queryClient = useQueryClient()
  const page = useResourcePageState()
  const [search, setSearch] = useState('')
  // The banner follows the server, as on Members: it shows while no admin can sign in without the IdP.
  const breakGlass = useQuery({ queryKey: adminQueryKeys.breakGlass, queryFn: api.breakGlass.get })
  const list = useCursorList<LocalGroup>({
    queryKey: adminQueryKeys.groups.list(),
    fetchPage: (cursor) => api.groups.list({ cursor, limit: adminPageMaxSize }),
  })

  /** Delete a group; the confirm dialog closes the panel. The deleted group's own reads aren't refetched. */
  const remove = async (groupId: string) => {
    await api.groups.remove(groupId)
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.groups.list() }),
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.members.all }),
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.breakGlass }),
    ])
  }

  // Search filters the loaded groups by name, as the Skills page filters its skills.
  const query = search.trim().toLowerCase()
  const groups = query ? list.items.filter((group) => group.name.toLowerCase().includes(query)) : list.items
  // The confirm names the group, from the list or, for one opened by a link, from its own read.
  const removingName = page.removeId
    ? (list.items.find((group) => group.id === page.removeId)?.name ??
      queryClient.getQueryData<LocalGroup>(adminQueryKeys.groups.detail(page.removeId))?.name ??
      '')
    : ''

  return {
    page,
    list,
    groups,
    setSearch,
    isSearching: query !== '',
    breakGlassWarning: breakGlass.data?.allAdminsIdpManaged === true,
    removingName,
    remove,
  }
}
