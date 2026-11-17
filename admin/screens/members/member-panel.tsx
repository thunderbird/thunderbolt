/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Link } from 'react-router'
import { DetailDivider, DetailPanel } from '@/components/detail-panel'
import { DetailField } from '@/components/settings/detail-field'
import { BreakGlassBanner } from '../../components/break-glass-banner'
import { ListSkeleton } from '../../components/list-skeleton'
import { GuardedAction } from '../../components/guarded-action'
import { InlineError } from '../../components/inline-error'
import { MemberAccessSection } from './member-access-section'
import { MemberProfileSection } from './member-profile-section'
import { MemberRolesSection } from './member-roles-section'
import { getPurgeState } from './member-rules'
import { MemberSourcesSection } from './member-sources-section'
import { useMemberPanelState } from './use-member-panel-state'

type MemberPanelProps = {
  userId: string
  onClose: () => void
  onDirtyChange: (dirty: boolean) => void
  /** Opens the page's permanent-delete confirm for this member. */
  onRequestPurge: () => void
}

/** One member: who they are, whether they can sign in, their roles, sign-in sources and groups. */
export const MemberPanel = ({ userId, onClose, onDirtyChange, onRequestPurge }: MemberPanelProps) => {
  const { t } = useLingui()
  const state = useMemberPanelState(userId)

  if (!state.member.data) {
    return (
      <DetailPanel title={t`Member`} onClose={onClose}>
        {state.member.error ? <InlineError error={state.member.error} /> : <ListSkeleton rows={3} />}
      </DetailPanel>
    )
  }

  const member = state.member.data
  const purgeState = getPurgeState(member, state.connectionStatusById)

  return (
    <DetailPanel
      title={member.name || member.email}
      subtitle={member.name ? member.email : undefined}
      onClose={onClose}
    >
      {state.breakGlassWarning && <BreakGlassBanner />}
      <MemberProfileSection member={member} rename={state.rename} onDirtyChange={onDirtyChange} />
      <DetailDivider />
      <MemberAccessSection member={member} selfId={state.selfId} block={state.block} unblock={state.unblock} />
      <DetailDivider />
      <MemberRolesSection
        member={member}
        selfId={state.selfId}
        grantAdmin={state.grantAdmin}
        revokeAdmin={state.revokeAdmin}
      />
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
          <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
            <Trans>Not in any group</Trans>
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {member.groups.map((group) => (
              <li key={group.id}>
                <Link to={`/admin/groups?edit=${encodeURIComponent(group.id)}`} className="underline">
                  {group.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </DetailField>
      {purgeState && (
        <>
          <DetailDivider />
          <DetailField label={<Trans>Delete permanently</Trans>}>
            <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
              <Trans>
                Deletes their account and all their data. Use this to handle an erasure request. It can't be undone.
              </Trans>
            </p>
            <GuardedAction availability={purgeState} variant="destructive" onClick={onRequestPurge}>
              <Trans>Delete member</Trans>
            </GuardedAction>
          </DetailField>
        </>
      )}
    </DetailPanel>
  )
}
