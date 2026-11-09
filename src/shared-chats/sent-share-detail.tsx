/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DetailDivider, DetailPanel } from '@/components/detail-panel'
import { DetailActionsMenu } from '@/components/settings/detail-actions-menu'
import { DetailField } from '@/components/settings/detail-field'
import { IconTile } from '@/components/settings/icon-tile'
import { Button, mutedIconButtonClass } from '@/components/ui/button'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useFormatters } from '@/i18n/use-formatters'
import { Trans, useLingui } from '@lingui/react/macro'
import type { ShareUser } from '@shared/chat-shares'
import { MessageSquare, Trash2, Users, X } from 'lucide-react'
import { useNavigate } from 'react-router'
import type { SentShare } from './use-shared-chats'

type SentShareDetailProps = {
  share: SentShare
  title: string
  onStopSharing: () => void
  onRemoveRecipient: (recipient: ShareUser) => void
  onClose: () => void
}

/** Detail panel for one chat you shared: who it went to, and taking access back. */
export const SentShareDetail = ({ share, title, onStopSharing, onRemoveRecipient, onClose }: SentShareDetailProps) => {
  const { t } = useLingui()
  const navigate = useNavigate()
  const formatters = useFormatters()
  const sharedAt = formatters.relativeTime(share.updatedAt)

  return (
    <DetailPanel
      icon={
        <IconTile>
          <Users className="size-4" />
        </IconTile>
      }
      title={title}
      subtitle={t`Shared ${sharedAt}`}
      actions={
        <DetailActionsMenu>
          <DropdownMenuItem onClick={() => navigate(`/chats/${share.chatThreadId}`)} className="cursor-pointer">
            <MessageSquare />
            <Trans>Open chat</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onStopSharing} className="cursor-pointer">
            <Trash2 />
            <Trans>Stop sharing</Trans>
          </DropdownMenuItem>
        </DetailActionsMenu>
      }
      onClose={onClose}
    >
      <DetailField label={t`Shared with`}>
        <ul className="flex flex-col">
          {share.recipients.map((recipient) => (
            <li key={recipient.userId} className="flex items-center gap-3 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-base text-foreground">{recipient.name || recipient.email}</p>
                {recipient.name && (
                  <p className="truncate text-[length:var(--font-size-sm)] text-muted-foreground">{recipient.email}</p>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onRemoveRecipient(recipient)}
                aria-label={t`Stop sharing with ${recipient.email}`}
                className={mutedIconButtonClass}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      </DetailField>

      <DetailDivider />

      <p className="text-sm text-muted-foreground">
        <Trans>
          They see this chat as it was when you last shared or updated it, and can’t reply to or edit it. Stopping a
          share keeps them from opening it again, but can’t take back what they’ve already read.
        </Trans>
      </p>
    </DetailPanel>
  )
}
