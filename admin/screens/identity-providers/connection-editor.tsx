/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import { DetailPanel } from '@/components/detail-panel'
import { DiscardCreateDialog } from '@/skills/discard-create-dialog'
import { ListSkeleton } from '../../components/list-skeleton'
import { PanelSections } from '../../components/panel-sections'
import type { PanelDirt, ResourcePageState } from '../../components/use-resource-page-state'
import { describeConnection } from './connection-status'
import { ScimGroupsSection } from './scim-groups-section'
import { ScimSection } from './scim-section'
import { SsoSettingsForm, SsoSettingsSection } from './sso-settings-section'
import { SyncErrorsSection } from './sync-errors-section'
import { useConnection } from './use-connection-queries'
import { InlineError } from '../../components/inline-error'
import { ItemActionsMenu } from '../../components/item-actions'
import { connectionActions } from '../sign-in-methods/sign-in-method-actions'

type Section = 'sign-in' | 'provisioning' | 'groups' | 'sync-errors'

type ConnectionEditorProps = {
  connectionId: string
  /** The name the list already shows, for the title while the connection loads. */
  name?: string
  page: ResourcePageState
  /** Opens the page's retire-SCIM confirm for this connection. */
  onRetireScim: () => void
}

/**
 * One connection's panel: its view, with the sign-in and provisioning sides and retiring it, or the
 * edit form of an admin-created connection's SSO settings.
 */
export const ConnectionEditor = ({ connectionId, name, page, onRetireScim }: ConnectionEditorProps) => {
  const { t } = useLingui()
  const connection = useConnection(connectionId)
  const [section, setSection] = useState<Section>('sign-in')
  const [pendingSection, setPendingSection] = useState<Section | null>(null)
  const onDirty = (dirty: PanelDirt) => page.patch({ dirty })
  // A tab change unmounts the tab, losing its draft or a token not yet copied: ask first.
  const requestSection = (next: Section) => (page.dirty ? setPendingSection(next) : setSection(next))

  if (!connection.data) {
    return (
      <DetailPanel title={name ?? t`Connection`} onClose={page.close}>
        {connection.error ? <InlineError error={connection.error} /> : <ListSkeleton rows={3} variant="flat" />}
      </DetailPanel>
    )
  }

  const detail = connection.data
  const summary = describeConnection(detail)

  if (page.isEditing && summary.canEditSso && detail.sso) {
    return (
      <DetailPanel title={t`Edit Connection`} onClose={page.cancelEdit}>
        <SsoSettingsForm
          detail={{ ...detail, sso: detail.sso }}
          onDirty={onDirty}
          onCancel={page.cancelEdit}
          onSaved={() => page.select(page.selectedId)}
        />
      </DetailPanel>
    )
  }
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
      // Read-only says so in the subtitle, as a built-in skill's panel does.
      subtitle={detail.sso?.envOwned ? t`Set by server settings · Read-only` : undefined}
      onClose={page.close}
      actions={<ItemActionsMenu actions={connectionActions(detail, page, onRetireScim)} />}
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
        title={page.dirty === 'secret' ? t`Leave without copying the token?` : t`Leave without saving?`}
        description={page.dirty === 'secret' ? t`It won't be shown again.` : t`Your changes won't be saved.`}
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
