/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useLingui } from '@lingui/react/macro'
import { DetailPanel } from '@/components/detail-panel'
import type { AdminMember } from '@shared/admin-api'
import type { ItemAction } from '../../components/item-actions'
import { InlineError } from '../../components/inline-error'
import { ListSkeleton } from '../../components/list-skeleton'
import { MemberFormPanel } from './member-form-panel'
import { MemberViewPanel } from './member-view-panel'
import { useMemberPanelState } from './use-member-panel-state'

type MemberPanelProps = {
  userId: string
  isEditing: boolean
  /** The member's actions for the view's ⋯ menu, the same ones their row offers. */
  actions: (member: AdminMember) => ItemAction[]
  onCancelEdit: () => void
  /** After the edit form saves: back to the member's view. */
  onSaved: () => void
  onClose: () => void
  onDirtyChange: (dirty: boolean) => void
}

/** The open member's panel: their view, or the form that edits them. */
export const MemberPanel = ({
  userId,
  isEditing,
  actions,
  onCancelEdit,
  onSaved,
  onClose,
  onDirtyChange,
}: MemberPanelProps) => {
  const { t } = useLingui()
  const state = useMemberPanelState(userId)
  const member = state.member.data

  if (!member) {
    return (
      <DetailPanel title={t`Member`} onClose={onClose}>
        {state.member.error ? <InlineError error={state.member.error} /> : <ListSkeleton rows={3} variant="flat" />}
      </DetailPanel>
    )
  }
  if (isEditing) {
    return (
      <MemberFormPanel
        member={member}
        selfId={state.selfId}
        onCancel={onCancelEdit}
        onDirtyChange={onDirtyChange}
        onSaved={onSaved}
      />
    )
  }
  return <MemberViewPanel state={state} actions={actions(member)} onClose={onClose} />
}
