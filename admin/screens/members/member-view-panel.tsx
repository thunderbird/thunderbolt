/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Link } from 'react-router'
import { DetailDivider, DetailPanel } from '@/components/detail-panel'
import { DetailField } from '@/components/settings/detail-field'
import { ItemActionsMenu, type ItemAction } from '../../components/item-actions'
import { MemberAccessSection } from './member-access-section'
import { MemberProfileSection } from './member-profile-section'
import { MemberRolesSection } from './member-roles-section'
import { getPurgeState } from './member-rules'
import { MemberSourcesSection } from './member-sources-section'
import type { MemberPanelState } from './use-member-panel-state'
import { adminItemLink } from '../../components/use-resource-page-state'

type MemberViewPanelProps = {
  state: MemberPanelState
  actions: ItemAction[]
  onClose: () => void
}

/** One member, read-only: who they are, whether they can sign in, their roles, sources and groups. */
export const MemberViewPanel = ({ state, actions, onClose }: MemberViewPanelProps) => {
  const { t, i18n } = useLingui()
  const member = state.member.data!
  const memberName = member.name || member.email
  const purgeState = getPurgeState(member, state.connectionStatusById)
  const managedBy = member.idpManaged?.connections.map((connection) => connection.name).join(', ')
  // What the identity provider controls says so in the subtitle, as a built-in skill says it's read-only.
  const subtitle = [
    member.name && member.email,
    managedBy && t`Managed by ${managedBy}`,
    member.requiresSso && t`SSO only`,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <DetailPanel
      title={memberName}
      subtitle={subtitle || undefined}
      onClose={onClose}
      actions={<ItemActionsMenu actions={actions} />}
    >
      <MemberProfileSection member={member} />
      <DetailDivider />
      <MemberAccessSection member={member} />
      {purgeState && !purgeState.available && (
        <p className="text-[length:var(--font-size-sm)] text-muted-foreground">{i18n._(purgeState.reason)}</p>
      )}
      <DetailDivider />
      <MemberRolesSection member={member} />
      <DetailDivider />
      <MemberSourcesSection
        member={member}
        selfId={state.selfId}
        connectionStatusById={state.connectionStatusById}
        detach={state.detach}
      />
      <DetailDivider />
      <DetailField label={<Trans>Groups</Trans>}>
        {member.groups.length === 0 ? (
          <p className="text-base leading-snug text-muted-foreground">
            <Trans>None</Trans>
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {member.groups.map((group) => (
              <li key={group.id}>
                <Link {...adminItemLink('/admin/groups', group.id)} className="underline">
                  {group.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </DetailField>
    </DetailPanel>
  )
}
