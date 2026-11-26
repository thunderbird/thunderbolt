/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Combobox } from '@/components/ui/combobox'
import { adminQueryKeys } from '../../api/query-keys'
import { useAdminApi } from '../../api/use-admin-api'
import { useDebounce } from '@/hooks/use-debounce'
import { searchDebounceMs } from '../../api/search-debounce'

type AuditActorPickerProps = {
  id: string
  actorId: string | undefined
  onChange: (actorId: string) => void
}

/**
 * Picks a member as the audit actor. Other actors (a SCIM connection) only arrive by a link, and
 * show by their raw id.
 */
export const AuditActorPicker = ({ id, actorId, onChange }: AuditActorPickerProps) => {
  const { t } = useLingui()
  const api = useAdminApi()
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<{ id: string; label: string } | null>(null)
  const q = useDebounce(search.trim(), searchDebounceMs)
  const members = useQuery({
    queryKey: adminQueryKeys.members.list(q),
    queryFn: () => api.members.list({ q }),
  })
  const items = (members.data?.items ?? []).map((member) => ({
    id: member.userId,
    label: member.name || member.email,
    description: member.name ? member.email : undefined,
  }))

  return (
    <Combobox
      id={id}
      items={items}
      value={actorId}
      displayValue={actorId ? (picked?.id === actorId ? picked.label : actorId) : undefined}
      onValueChange={(userId) => {
        setPicked(items.find((item) => item.id === userId) ?? null)
        onChange(userId)
      }}
      searchValue={search}
      onSearchChange={setSearch}
      loading={members.isFetching}
      placeholder={t`Anyone`}
      searchPlaceholder={t`Search by name or email`}
      emptyMessage={t`No matching members.`}
    />
  )
}
