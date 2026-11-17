/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { adminRole, type BreakGlassWarning, type RoleMapping } from '@shared/admin-api'
import { getAdminErrorMessage } from '../api/error-messages'
import { adminQueryKeys } from '../api/query-keys'
import { useAdminApi } from '../api/use-admin-api'
import { BreakGlassBanner, hasBreakGlassWarning } from './break-glass-banner'

export type RoleMappingTarget = { localGroupId: string } | { identityConnectionId: string; scimGroupId: string }

const isMappingOf = (mapping: RoleMapping, target: RoleMappingTarget) =>
  'localGroupId' in target
    ? mapping.target.kind === 'local_group' && mapping.target.groupId === target.localGroupId
    : mapping.target.kind === 'scim_group' &&
      mapping.target.connectionId === target.identityConnectionId &&
      mapping.target.scimGroupId === target.scimGroupId

type RoleMappingControlProps = {
  target: RoleMappingTarget
  /** Names the group in the switch's accessible label. */
  groupName: string
  disabled?: boolean
}

/**
 * Maps a local or SCIM group to the admin role, so every member of the group is an admin. Shows the
 * break-glass banner when removing the mapping left no admin who can sign in without the IdP.
 */
export const RoleMappingControl = ({ target, groupName, disabled = false }: RoleMappingControlProps) => {
  const { t, i18n } = useLingui()
  const switchId = useId()
  const api = useAdminApi()
  const queryClient = useQueryClient()
  const [warning, setWarning] = useState(false)
  const filter =
    'localGroupId' in target ? { localGroupId: target.localGroupId } : { connectionId: target.identityConnectionId }

  const mappings = useQuery({
    queryKey: adminQueryKeys.roleMappings.list(filter),
    queryFn: () => api.roleMappings.list(filter),
  })
  const mapping = mappings.data?.find((item) => item.role === adminRole && isMappingOf(item, target))

  const change = useMutation({
    mutationFn: (enabled: boolean): Promise<BreakGlassWarning> =>
      enabled
        ? api.roleMappings.create({ ...target, role: adminRole })
        : mapping
          ? api.roleMappings.remove(mapping.id)
          : Promise.resolve({}),
    onSuccess: async (result) => {
      setWarning(hasBreakGlassWarning(result))
      await Promise.all(
        [
          adminQueryKeys.roleMappings.all,
          adminQueryKeys.members.all,
          adminQueryKeys.groups.all,
          adminQueryKeys.connections.all,
          adminQueryKeys.breakGlass,
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      )
    },
  })

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <Label htmlFor={switchId}>
            <Trans>Admin role</Trans>
          </Label>
          <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
            <Trans>Every member of this group is an admin.</Trans>
          </p>
        </div>
        <Switch
          id={switchId}
          aria-label={t`Make members of ${groupName} admins`}
          checked={mapping !== undefined}
          disabled={disabled || mappings.isPending || change.isPending}
          onCheckedChange={(enabled) => change.mutate(enabled)}
        />
      </div>
      {(mappings.error ?? change.error) && (
        <p role="alert" className="text-[length:var(--font-size-sm)] text-destructive">
          {i18n._(getAdminErrorMessage(mappings.error ?? change.error))}
        </p>
      )}
      {warning && <BreakGlassBanner />}
    </div>
  )
}
