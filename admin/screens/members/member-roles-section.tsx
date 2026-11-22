/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import { Link } from 'react-router'
import { DetailField } from '@/components/settings/detail-field'
import { Button } from '@/components/ui/button'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { adminRole, type AdminMember, type MemberRoleSource } from '@shared/admin-api'
import { InlineError } from '../../components/inline-error'
import { MemberAdminSignIn } from './member-admin-sign-in'
import { getRevokeAdminState, isAdmin } from './member-rules'
import type { MemberPanelState } from './use-member-panel-state'

/** Where one role comes from. A group's name is a label only; its id is what links. */
const RoleOrigin = ({ source, member }: { source: MemberRoleSource; member: AdminMember }) => {
  const groupName = source.groupName ?? source.groupId
  if (source.from === 'local') {
    return <Trans>Granted by an admin</Trans>
  }
  if (source.from === 'bootstrap') {
    return <Trans>Bootstrap admin, from the deployment's settings</Trans>
  }
  if (source.from === 'local_group') {
    return (
      <Trans>
        From the group{' '}
        <Link to={`/admin/groups?edit=${encodeURIComponent(source.groupId ?? '')}`} className="underline">
          {groupName}
        </Link>
        . Remove them from the group to take it away.
      </Trans>
    )
  }
  const connectionName =
    member.sources.find((item) => item.connection?.id === source.connectionId)?.connection?.name ?? source.connectionId
  return (
    <Trans>
      From the group {groupName} in {connectionName}. Change it in your identity provider.
    </Trans>
  )
}

type MemberRolesSectionProps = {
  member: AdminMember
  selfId: string | null
  grantAdmin: MemberPanelState['grantAdmin']
  revokeAdmin: MemberPanelState['revokeAdmin']
}

/** The member's roles, each with where it comes from, and granting or revoking admin. */
export const MemberRolesSection = ({ member, selfId, grantAdmin, revokeAdmin }: MemberRolesSectionProps) => {
  const { t, i18n } = useLingui()
  const [confirmingSelfDemotion, setConfirmingSelfDemotion] = useState(false)
  const revokeState = getRevokeAdminState(member, selfId)
  const revoke = () => revokeAdmin.mutate(undefined, { onSettled: () => setConfirmingSelfDemotion(false) })

  return (
    <DetailField label={<Trans>Roles</Trans>}>
      <ul className="flex flex-col gap-2">
        {member.roles.map((source, index) => (
          <li key={`${source.role}-${source.from}-${source.groupId ?? index}`} className="flex flex-col">
            <span className="text-[length:var(--font-size-body)] font-medium">
              {source.role === adminRole ? <Trans>Admin</Trans> : source.role}
            </span>
            <span className="text-[length:var(--font-size-sm)] text-muted-foreground">
              <RoleOrigin source={source} member={member} />
            </span>
          </li>
        ))}
        {member.roles.length === 0 && (
          <li className="text-[length:var(--font-size-sm)] text-muted-foreground">
            <Trans>Member, with no admin role</Trans>
          </li>
        )}
      </ul>
      {isAdmin(member) && <MemberAdminSignIn member={member} />}
      <div className="mt-2 flex flex-col items-start gap-1">
        {revokeState.available ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            isLoading={revokeAdmin.isPending && !confirmingSelfDemotion}
            onClick={() => (revokeState.confirmSelfDemotion ? setConfirmingSelfDemotion(true) : revoke())}
          >
            <Trans>Revoke admin</Trans>
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              isLoading={grantAdmin.isPending}
              onClick={() => grantAdmin.mutate()}
            >
              <Trans>Make admin</Trans>
            </Button>
            {isAdmin(member) && (
              <p className="text-[length:var(--font-size-sm)] text-muted-foreground">{i18n._(revokeState.reason)}</p>
            )}
          </>
        )}
      </div>
      <InlineError error={grantAdmin.error ?? revokeAdmin.error} />
      <ConfirmActionDialog
        open={confirmingSelfDemotion}
        title={t`Remove your own admin role?`}
        description={t`You'll lose access to the admin screens. Only another admin can give it back.`}
        confirmLabel={t`Remove my admin role`}
        isPending={revokeAdmin.isPending}
        onCancel={() => setConfirmingSelfDemotion(false)}
        onConfirm={revoke}
      />
    </DetailField>
  )
}
