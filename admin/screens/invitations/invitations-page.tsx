/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Mail } from 'lucide-react'
import { IconTile } from '@/components/settings/icon-tile'
import { SettingsNoResults } from '@/components/settings/settings-empty-state'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { PageCreateAction } from '@/components/ui/page-create-action'
import { useFormatters } from '@/i18n/use-formatters'
import type { Invitation, InvitationStatus } from '@shared/admin-api'
import { AdminPage } from '../../components/admin-page'
import { ListSkeleton } from '../../components/list-skeleton'
import { LoadMoreFooter } from '../../components/load-more-footer'
import { PanelSections } from '../../components/panel-sections'
import { ResourcePageDialogs } from '../../components/resource-page-dialogs'
import { StatusBadge } from '../../components/status-badge'
import { InlineError } from '../../components/inline-error'
import { InvitePanel } from './invite-panel'
import { useInvitationsPageState } from './use-invitations-page-state'

const InvitationRow = ({ invitation, onRevoke }: { invitation: Invitation; onRevoke: () => void }) => {
  const { t } = useLingui()
  const formatters = useFormatters()
  const { email } = invitation
  const invitedOn = formatters.date(invitation.createdAt)
  const expiresOn = formatters.date(invitation.expiresAt)

  const when = () => {
    if (invitation.status !== 'pending') {
      return <Trans>Invited {invitedOn}</Trans>
    }
    // The backend leaves an unused invitation pending past its expiry; its link no longer works.
    return Date.parse(invitation.expiresAt) <= Date.now() ? (
      <Trans>Expired {expiresOn}</Trans>
    ) : (
      <Trans>Expires {expiresOn}</Trans>
    )
  }

  return (
    <Card className="flex-row items-center gap-3 border-border px-4 py-3" aria-label={email}>
      <IconTile>
        <Mail className="size-5 text-muted-foreground" />
      </IconTile>
      <div className="min-w-0 flex-1">
        <span className="block truncate text-[length:var(--font-size-body)] font-medium">{email}</span>
        <span className="block truncate text-[length:var(--font-size-sm)] text-muted-foreground">{when()}</span>
      </div>
      {invitation.idpOverride && (
        <StatusBadge tone="warning">
          <Trans>IdP override</Trans>
        </StatusBadge>
      )}
      {invitation.status === 'pending' && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={t`Revoke invitation to ${email}`}
          onClick={onRevoke}
        >
          <Trans>Revoke</Trans>
        </Button>
      )}
    </Card>
  )
}

export const InvitationsPage = () => {
  const { t } = useLingui()
  const { page, status, setStatus, list, revoke, invited, lastInvited } = useInvitationsPageState()
  const sections: { id: InvitationStatus; label: string }[] = [
    { id: 'pending', label: t`Pending` },
    { id: 'accepted', label: t`Accepted` },
    { id: 'revoked', label: t`Revoked` },
  ]

  return (
    <>
      <AdminPage
        title={t`Invitations`}
        action={<PageCreateAction label={t`Invite member`} onClick={() => page.requestSelect('new')} />}
        onClose={page.close}
        panel={
          page.selectedId === 'new' && (
            <InvitePanel onClose={page.close} onInvited={invited} onDirtyChange={(dirty) => page.patch({ dirty })} />
          )
        }
      >
        <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
          <Trans>Invite people by email. Each invitation link works once and expires after seven days.</Trans>
        </p>
        <PanelSections sections={sections} value={status} onChange={setStatus} label={t`Invitation status`} />
        {lastInvited && (
          <p role="status" className="text-[length:var(--font-size-sm)] text-muted-foreground">
            <Trans>Invitation sent to {lastInvited}.</Trans>
          </p>
        )}
        {list.isLoading && <ListSkeleton />}
        <InlineError error={list.error} />
        {list.items.map((invitation) => (
          <InvitationRow
            key={invitation.id}
            invitation={invitation}
            onRevoke={() => page.patch({ removeId: invitation.id })}
          />
        ))}
        {list.isEmpty && (
          <SettingsNoResults>
            <Trans>No invitations here.</Trans>
          </SettingsNoResults>
        )}
        <LoadMoreFooter hasMore={list.hasMore} isLoading={list.isLoadingMore} onLoadMore={list.loadMore} />
      </AdminPage>
      <ResourcePageDialogs
        page={page}
        remove={{
          title: t`Revoke this invitation?`,
          description: t`Its link stops working. You can invite the address again later.`,
          confirmLabel: t`Revoke invitation`,
          onConfirm: revoke,
        }}
      />
    </>
  )
}
