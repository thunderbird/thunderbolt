/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useQueryClient } from '@tanstack/react-query'
import { useDeferredValue, useState } from 'react'
import { adminPageMaxSize, type AdminMember } from '@shared/admin-api'
import { adminQueryKeys } from '../../api/query-keys'
import { useAdminApi } from '../../api/use-admin-api'
import { useCursorList } from '../../api/use-cursor-list'
import { useResourcePageState } from '../../components/use-resource-page-state'

/** The members list, searched on the server, and the selected member. */
export const useMembersPageState = () => {
  const api = useAdminApi()
  const queryClient = useQueryClient()
  const page = useResourcePageState()
  const [search, setSearch] = useState('')
  const q = useDeferredValue(search.trim()) || undefined
  const list = useCursorList<AdminMember>({
    queryKey: adminQueryKeys.members.list(q),
    fetchPage: (cursor) => api.members.list({ q, cursor, limit: adminPageMaxSize }),
  })

  /** Delete a member for good; the confirm dialog closes the panel. Only the lists refetch: the detail would 404. */
  const purge = async (userId: string) => {
    await api.members.purge(userId)
    await queryClient.invalidateQueries({
      queryKey: adminQueryKeys.members.all,
      predicate: (query) => query.queryKey[2] === 'list',
    })
  }

  return { page, list, setSearch, purge }
}
