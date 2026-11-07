/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { DetailField } from '@/components/settings/detail-field'
import { Label } from '@/components/ui/label'
import type { PreviewAgent } from '../data'
import type { AdminPreview } from '../use-admin-preview-state'
import { MembershipMultiSelect } from './membership-multi-select'

type AgentAccessDraft = Pick<PreviewAgent, 'groupIds'>

export const AgentAccessPanel = ({
  draft,
  preview,
  onChange,
}: {
  draft: AgentAccessDraft
  preview: AdminPreview
  onChange: (patch: Partial<AgentAccessDraft>) => void
}) => {
  const { t } = useLingui()
  return (
    <DetailField
      label={
        <Label htmlFor="admin-agent-access-groups">
          <Trans>Groups with access</Trans>
        </Label>
      }
    >
      <MembershipMultiSelect
        id="admin-agent-access-groups"
        items={preview.groups.map((group) => ({ id: group.id, label: group.name }))}
        selectedIds={draft.groupIds}
        onChange={(groupIds) => onChange({ groupIds })}
        placeholder={t`Select groups`}
        searchPlaceholder={t`Search groups`}
        emptyMessage={t`No matching groups.`}
        removeLabel={(name) => t`Revoke access for ${name}`}
      />
      {draft.groupIds.length === 0 && (
        <p className="text-sm text-muted-foreground">
          <Trans>Assign a group to give its members access to this agent.</Trans>
        </p>
      )}
    </DetailField>
  )
}
