/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { adminPageMaxSize, type LocalGroup } from '@shared/admin-api'
import { adminQueryKeys } from '../../api/query-keys'
import { useAdminApi } from '../../api/use-admin-api'
import { useCursorList } from '../../api/use-cursor-list'
import { hasBreakGlassWarning } from '../../components/break-glass-banner'
import { useResourcePageState } from '../../components/use-resource-page-state'

/** The local groups list, the selected group (`new` while creating one), and deleting a group. */
export const useGroupsPageState = () => {
  const api = useAdminApi()
  const queryClient = useQueryClient()
  const page = useResourcePageState()
  const [breakGlassWarning, setBreakGlassWarning] = useState(false)
  const list = useCursorList<LocalGroup>({
    queryKey: adminQueryKeys.groups.list(),
    fetchPage: (cursor) => api.groups.list({ cursor, limit: adminPageMaxSize }),
  })

  /** Delete a group; the confirm dialog closes the panel. The deleted group's own reads aren't refetched. */
  const remove = async (groupId: string) => {
    setBreakGlassWarning(hasBreakGlassWarning(await api.groups.remove(groupId)))
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.groups.list() }),
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.members.all }),
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.breakGlass }),
    ])
  }

  return { page, list, breakGlassWarning, remove }
}
