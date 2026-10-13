/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Users } from 'lucide-react'
import { useState } from 'react'
import { SettingsSelectableRow } from '@/components/settings/settings-list'
import { IconTile } from '@/components/settings/icon-tile'
import { PageCreateAction } from '@/components/ui/page-create-action'
import { useFormatters } from '@/i18n/use-formatters'
import { PreviewPage } from '../preview-page'
import type { AdminPreview } from '../use-admin-preview-state'
import { GroupEditor } from './group-editor'

export const GroupsPage = ({ preview }: { preview: AdminPreview }) => {
  const { t } = useLingui()
  const formatters = useFormatters()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const group = preview.groups.find((item) => item.id === selectedId)
  const close = () => setSelectedId(null)
  return (
    <PreviewPage
      title={t`Groups`}
      onClose={close}
      onReset={() => {
        preview.dispatch({ type: 'reset' })
        close()
      }}
      action={<PageCreateAction label={t`New group`} onClick={() => setSelectedId('new')} />}
      panel={
        (selectedId === 'new' || group) && (
          <GroupEditor key={selectedId} group={group} preview={preview} onClose={close} />
        )
      }
    >
      <p className="text-sm text-muted-foreground">
        <Trans>Give teams access to the right agents through shared groups.</Trans>
      </p>
      {preview.groups.map((item) => {
        const count = formatters.number(preview.members.filter((member) => member.groupIds.includes(item.id)).length)
        return (
          <SettingsSelectableRow
            key={item.id}
            title={item.name}
            leading={
              <IconTile>
                <Users className="size-5 text-muted-foreground" />
              </IconTile>
            }
            subtitle={<Trans>Members: {count}</Trans>}
            ariaLabel={item.name}
            isSelected={selectedId === item.id}
            onSelect={() => setSelectedId(selectedId === item.id ? null : item.id)}
          />
        )
      })}
      {preview.groups.length === 0 && (
        <p className="text-muted-foreground">
          <Trans>No groups yet.</Trans>
        </p>
      )}
    </PreviewPage>
  )
}
