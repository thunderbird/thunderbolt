/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Archive } from 'lucide-react'
import { useState } from 'react'
import { DetailPanel } from '@/components/detail-panel'
import { DetailActionsMenu } from '@/components/settings/detail-actions-menu'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { getAdminErrorMessage } from '../../api/error-messages'
import { ListSkeleton } from '../../components/list-skeleton'
import { PanelSections } from '../../components/panel-sections'
import type { ResourcePageState } from '../../components/use-resource-page-state'
import { describeConnection } from './connection-status'
import { SsoSettingsSection } from './sso-settings-section'
import { useConnection } from './use-connection-queries'

type Section = 'sign-in'

/** One connection's panel: its sign-in side, its provisioning side, and retiring it. */
export const ConnectionEditor = ({ connectionId, page }: { connectionId: string; page: ResourcePageState }) => {
  const { t, i18n } = useLingui()
  const connection = useConnection(connectionId)
  const [section, setSection] = useState<Section>('sign-in')
  const onDirty = (dirty: boolean) => page.patch({ dirty })

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
  const sections: { id: Section; label: string }[] = [{ id: 'sign-in', label: t`Sign-in` }]

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
        <PanelSections sections={sections} value={section} onChange={setSection} label={t`Connection sections`} />
        {section === 'sign-in' && <SsoSettingsSection detail={detail} onDirty={onDirty} />}
      </div>
    </DetailPanel>
  )
}
