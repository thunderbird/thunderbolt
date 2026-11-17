/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Archive } from 'lucide-react'
import { useState } from 'react'
import { DetailPanel } from '@/components/detail-panel'
import { DetailActionsMenu } from '@/components/settings/detail-actions-menu'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { DiscardCreateDialog } from '@/skills/discard-create-dialog'
import { getAdminErrorMessage } from '../../api/error-messages'
import { ListSkeleton } from '../../components/list-skeleton'
import { PanelSections } from '../../components/panel-sections'
import type { ResourcePageState } from '../../components/use-resource-page-state'
import { describeConnection } from './connection-status'
import { ScimGroupsSection } from './scim-groups-section'
import { ScimSection } from './scim-section'
import { SsoSettingsSection } from './sso-settings-section'
import { SyncErrorsSection } from './sync-errors-section'
import { useConnection } from './use-connection-queries'

type Section = 'sign-in' | 'provisioning' | 'groups' | 'sync-errors'

/** One connection's panel: its sign-in side, its provisioning side, and retiring it. */
export const ConnectionEditor = ({ connectionId, page }: { connectionId: string; page: ResourcePageState }) => {
  const { t, i18n } = useLingui()
  const connection = useConnection(connectionId)
  const [section, setSection] = useState<Section>('sign-in')
  const [pendingSection, setPendingSection] = useState<Section | null>(null)
  const onDirty = (dirty: boolean) => page.patch({ dirty })
  // A tab change unmounts the tab, losing its draft or a token not yet copied: ask first.
  const requestSection = (next: Section) => (page.dirty ? setPendingSection(next) : setSection(next))

  if (!connection.data) {
    return (
      <DetailPanel title={t`Connection`} onClose={page.close}>
        {connection.error ? (
          <p role="alert" className="text-destructive">
            {i18n._(getAdminErrorMessage(connection.error))}
          </p>
        ) : (
          <ListSkeleton rows={3} />
        )}
      </DetailPanel>
    )
  }

  const detail = connection.data
  const summary = describeConnection(detail)
  const sections: { id: Section; label: string }[] = [
    { id: 'sign-in', label: t`Sign-in` },
    { id: 'provisioning', label: t`Provisioning` },
    ...(detail.scim
      ? [
          { id: 'groups' as const, label: t`Groups` },
          { id: 'sync-errors' as const, label: t`Sync errors` },
        ]
      : []),
  ]

  return (
    <DetailPanel
      title={detail.name}
      subtitle={detail.sso?.providerId}
      onClose={page.close}
      actions={
        summary.canRetireSso && (
          <DetailActionsMenu>
            <DropdownMenuItem variant="destructive" onClick={() => page.patch({ removeId: detail.id })}>
              <Archive />
              <Trans>Retire connection</Trans>
            </DropdownMenuItem>
          </DetailActionsMenu>
        )
      }
    >
      <div className="flex flex-1 flex-col gap-5">
        <PanelSections sections={sections} value={section} onChange={requestSection} label={t`Connection sections`} />
        {section === 'sign-in' && <SsoSettingsSection detail={detail} onDirty={onDirty} />}
        {section === 'provisioning' && <ScimSection detail={detail} onDirty={onDirty} />}
        {section === 'groups' && <ScimGroupsSection connectionId={detail.id} canMap={summary.scim === 'active'} />}
        {section === 'sync-errors' && <SyncErrorsSection connectionId={detail.id} />}
      </div>
      <DiscardCreateDialog
        open={pendingSection !== null}
        title={t`Discard unsaved changes?`}
        onOpenChange={(open) => !open && setPendingSection(null)}
        onConfirm={() => {
          onDirty(false)
          setSection(pendingSection ?? section)
          setPendingSection(null)
        }}
      />
    </DetailPanel>
  )
}
