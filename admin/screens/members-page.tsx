/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { UserRound } from 'lucide-react'
import { useState } from 'react'
import { SettingsSelectableRow } from '@/components/settings/settings-list'
import { IconTile } from '@/components/settings/icon-tile'
import { Input } from '@/components/ui/input'
import { PageCreateAction } from '@/components/ui/page-create-action'
import { PreviewPage } from '../preview-page'
import type { AdminPreview } from '../use-admin-preview-state'
import { MemberEditor } from './member-editor'

export const MembersPage = ({ preview }: { preview: AdminPreview }) => {
  const { t } = useLingui()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const member = preview.members.find((item) => item.id === selectedId)
  const close = () => setSelectedId(null)
  const matches = preview.members.filter((item) =>
    (item.name + ' ' + item.email).toLowerCase().includes(query.toLowerCase()),
  )
  return (
    <PreviewPage
      title={t`Members`}
      onClose={close}
      onReset={() => {
        preview.dispatch({ type: 'reset' })
        close()
        setQuery('')
      }}
      action={<PageCreateAction label={t`Invite member`} onClick={() => setSelectedId('new')} />}
      panel={
        (selectedId === 'new' || member) && (
          <MemberEditor key={selectedId} member={member} preview={preview} onClose={close} />
        )
      }
    >
      <p className="text-sm text-muted-foreground">
        <Trans>Manage membership, administrator roles, and group access.</Trans>
      </p>
      <Input
        type="search"
        aria-label={t`Search members`}
        placeholder={t`Search by name or email`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {matches.map((item) => (
        <SettingsSelectableRow
          key={item.id}
          ariaLabel={item.name}
          isSelected={selectedId === item.id}
          onSelect={() => setSelectedId(selectedId === item.id ? null : item.id)}
          leading={
            <IconTile>
              <UserRound className="size-5 text-muted-foreground" />
            </IconTile>
          }
          title={
            <span className="flex items-center gap-2">
              {item.name}
              {item.role === 'admin' && (
                <span className="text-xs font-normal text-muted-foreground">
                  <Trans>Admin</Trans>
                </span>
              )}
            </span>
          }
          subtitle={item.email}
          trailing={
            item.status === 'invited' ? (
              <span className="text-xs text-muted-foreground">
                <Trans>Invited</Trans>
              </span>
            ) : undefined
          }
        />
      ))}
      {matches.length === 0 && (
        <p className="text-muted-foreground">
          <Trans>No matching members.</Trans>
        </p>
      )}
    </PreviewPage>
  )
}
