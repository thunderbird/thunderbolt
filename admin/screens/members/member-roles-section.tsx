/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans } from '@lingui/react/macro'
import { Link } from 'react-router'
import { DetailField } from '@/components/settings/detail-field'
import { adminRole, type AdminMember, type MemberRoleSource } from '@shared/admin-api'
import { MemberAdminSignIn } from './member-admin-sign-in'
import { isAdmin } from './member-rules'
import { adminItemLink } from '../../components/use-resource-page-state'

/** Where one role comes from. A group's name is a label only; its id is what links. */
const RoleOrigin = ({ source, member }: { source: MemberRoleSource; member: AdminMember }) => {
  const groupName = source.groupName ?? source.groupId
  if (source.from === 'local') {
    return <Trans>Granted by an admin</Trans>
  }
  if (source.from === 'bootstrap') {
    return <Trans>Bootstrap admin</Trans>
  }
  if (source.from === 'local_group') {
    return (
      <Trans>
        From{' '}
        <Link {...adminItemLink('/admin/groups', source.groupId ?? '')} className="underline">
          {groupName}
        </Link>
      </Trans>
    )
  }
  const connectionName =
    member.sources.find((item) => item.connection?.id === source.connectionId)?.connection?.name ?? source.connectionId
  return (
    <Trans>
      From {groupName} in {connectionName}
    </Trans>
  )
}

/** The member's roles, each with where it comes from, and how an admin among them signs in. */
export const MemberRolesSection = ({ member }: { member: AdminMember }) => (
  <DetailField label={<Trans>Roles</Trans>}>
    <ul className="flex flex-col gap-2">
      {member.roles.map((source, index) => (
        <li key={`${source.role}-${source.from}-${source.groupId ?? index}`} className="flex flex-col">
          <span className="text-base leading-snug text-foreground">
            {source.role === adminRole ? <Trans>Admin</Trans> : source.role}
          </span>
          <span className="text-[length:var(--font-size-sm)] text-muted-foreground">
            <RoleOrigin source={source} member={member} />
          </span>
        </li>
      ))}
      {member.roles.length === 0 && (
        <li className="text-[length:var(--font-size-sm)] text-muted-foreground">
          <Trans>Member</Trans>
        </li>
      )}
    </ul>
    {isAdmin(member) && <MemberAdminSignIn member={member} />}
  </DetailField>
)
