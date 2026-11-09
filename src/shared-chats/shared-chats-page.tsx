/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DetailPanelSurface } from '@/components/detail-panel'
import { IconTile } from '@/components/settings/icon-tile'
import { SettingsEmptyState } from '@/components/settings/settings-empty-state'
import {
  SettingsListBody,
  settingsListBodyRowsClass,
  SettingsListPane,
  SettingsSelectableRow,
} from '@/components/settings/settings-list'
import { Button, mutedIconButtonClass } from '@/components/ui/button'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useE2eeReady } from '@/hooks/use-e2ee-ready'
import { useFormatters } from '@/i18n/use-formatters'
import { chatTitleLabel } from '@/lib/title-generator'
import { plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { ShareUser } from '@shared/chat-shares'
import { Inbox, Lock, MessageSquare, Send, Users, X } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { SentShareDetail } from './sent-share-detail'
import type { ReceivedShare } from '@/services/shares'
import {
  type SentShare,
  useRemoveReceivedShare,
  useLocalChatTitles,
  useReceivedShares,
  useRemoveShareRecipient,
  useSentShares,
  useStopSharing,
} from './use-shared-chats'

type SharedTab = 'received' | 'sent'

/** A destructive share action awaiting confirmation. */
type PendingAction =
  | { kind: 'stop-sharing'; share: SentShare }
  | { kind: 'remove-recipient'; share: SentShare; recipient: ShareUser }
  | { kind: 'remove-received'; share: ReceivedShare }

const ListSkeleton = () => (
  <>
    {[0, 1, 2].map((row) => (
      <Skeleton key={row} className="h-[66px] w-full rounded-xl" />
    ))}
  </>
)

const ListError = () => (
  <p role="alert" className="text-sm text-destructive">
    <Trans>Couldn’t load shared chats. Please try again.</Trans>
  </p>
)

/** Same segmented control as the Preferences page's theme picker. */
const SharedTabs = ({ tab, onChange }: { tab: SharedTab; onChange: (tab: SharedTab) => void }) => (
  <ToggleGroup
    type="single"
    variant="outline"
    value={tab}
    onValueChange={(value) => {
      // Radix reports '' when the active item is clicked again — ignore it.
      if (value === 'received' || value === 'sent') {
        onChange(value)
      }
    }}
    className="shrink-0 justify-start rounded-lg"
  >
    <ToggleGroupItem value="received" className="cursor-pointer gap-2 px-4 first:rounded-l-lg last:rounded-r-lg">
      <Inbox className="h-4 w-4" />
      <Trans>Shared with me</Trans>
    </ToggleGroupItem>
    <ToggleGroupItem value="sent" className="cursor-pointer gap-2 px-4 first:rounded-l-lg last:rounded-r-lg">
      <Send className="h-4 w-4" />
      <Trans>Shared by me</Trans>
    </ToggleGroupItem>
  </ToggleGroup>
)

/** Chats other people shared with you; selecting one opens it read-only. */
const ReceivedRows = ({ onRemove }: { onRemove: (share: ReceivedShare) => void }) => {
  const { i18n, t } = useLingui()
  const navigate = useNavigate()
  const formatters = useFormatters()
  const { data, isPending, isError } = useReceivedShares()

  if (isPending) {
    return <ListSkeleton />
  }
  if (isError || !data) {
    return <ListError />
  }
  if (data.length === 0) {
    return (
      <SettingsEmptyState
        icon={<Inbox className="size-10 text-muted-foreground" />}
        title={t`Nothing shared with you yet`}
        description={t`When someone shares a chat with you, it shows up here.`}
      />
    )
  }
  return (
    <>
      {data.map((share) => {
        const isUnreadable = share.title === null
        const title = isUnreadable ? t`Can’t be opened on this device` : chatTitleLabel(i18n, share.title || null)
        const sharedAt = formatters.relativeTime(share.updatedAt)
        const ownerName = share.owner.name || share.owner.email
        return (
          <SettingsSelectableRow
            key={share.id}
            onSelect={() => navigate(`/shared/${share.id}`)}
            ariaLabel={t`Open ${title}`}
            isDimmed={isUnreadable}
            leading={
              <IconTile>
                <MessageSquare className="size-4" />
              </IconTile>
            }
            title={title}
            subtitle={t`From ${ownerName} · ${sharedAt}`}
            trailing={
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onRemove(share)}
                aria-label={t`Remove ${title}`}
                className={mutedIconButtonClass}
              >
                <X />
              </Button>
            }
          />
        )
      })}
    </>
  )
}

type SentRowsProps = {
  shares: SentShare[] | undefined
  titles: Map<string, string | null>
  isPending: boolean
  isError: boolean
  activeShareId: string | null
  onSelect: (shareId: string) => void
}

/** Chats you shared; selecting one opens its detail panel. */
const SentRows = ({ shares, titles, isPending, isError, activeShareId, onSelect }: SentRowsProps) => {
  const { i18n, t } = useLingui()
  const formatters = useFormatters()

  if (isPending) {
    return <ListSkeleton />
  }
  if (isError || !shares) {
    return <ListError />
  }
  if (shares.length === 0) {
    return (
      <SettingsEmptyState
        icon={<Send className="size-10 text-muted-foreground" />}
        title={t`You haven’t shared any chats`}
        description={t`Share a chat from its menu or the chat header. Only the people you add can read it.`}
      />
    )
  }
  return (
    <>
      {shares.map((share) => {
        const title = chatTitleLabel(i18n, titles.get(share.chatThreadId) ?? null)
        const count = share.recipients.length
        const sharedAt = formatters.relativeTime(share.updatedAt)
        const subtitle = plural(count, {
          one: `Shared with # person · ${sharedAt}`,
          other: `Shared with # people · ${sharedAt}`,
        })
        return (
          <SettingsSelectableRow
            key={share.id}
            onSelect={() => onSelect(share.id)}
            ariaLabel={t`Open ${title}`}
            isSelected={activeShareId === share.id}
            leading={
              <IconTile>
                <Users className="size-4" />
              </IconTile>
            }
            title={title}
            subtitle={subtitle}
          />
        )
      })}
    </>
  )
}

/** The Shared page: chats shared with you, and chats you shared. */
const SharedChatsPage = () => {
  const { i18n, t } = useLingui()
  const isReady = useE2eeReady()
  const [searchParams, setSearchParams] = useSearchParams()
  const tab: SharedTab = searchParams.get('tab') === 'sent' ? 'sent' : 'received'
  const [activeShareId, setActiveShareId] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)

  const sentShares = useSentShares()
  const titles = useLocalChatTitles(sentShares.data)
  const stopSharing = useStopSharing()
  const removeRecipient = useRemoveShareRecipient()
  const removeReceived = useRemoveReceivedShare()
  const mutations = [stopSharing, removeRecipient, removeReceived]
  const activeShare = tab === 'sent' ? sentShares.data?.find((share) => share.id === activeShareId) : undefined

  const changeTab = (next: SharedTab) => {
    setActiveShareId(null)
    setSearchParams(next === 'sent' ? { tab: 'sent' } : {}, { replace: true })
  }

  const requestConfirm = (action: PendingAction) => {
    mutations.forEach((mutation) => mutation.reset())
    setPendingAction(action)
  }

  const confirmPending = (action: PendingAction) => {
    const settle = {
      onSuccess: () => {
        if (action.kind === 'stop-sharing') {
          setActiveShareId(null)
        }
        setPendingAction(null)
      },
      onError: (error: Error) => console.error('Changing a share failed', error),
    }
    switch (action.kind) {
      case 'stop-sharing':
        return stopSharing.mutate(action.share.id, settle)
      case 'remove-recipient':
        return removeRecipient.mutate({ shareId: action.share.id, recipientUserId: action.recipient.userId }, settle)
      case 'remove-received':
        return removeReceived.mutate(action.share.id, settle)
    }
  }

  const confirmCopy = (action: PendingAction) => {
    switch (action.kind) {
      case 'stop-sharing':
        return {
          title: t`Stop sharing this chat?`,
          description: t`Nobody you shared it with will be able to open it anymore. Anything they already read can’t be taken back.`,
          confirmLabel: t`Stop sharing`,
        }
      case 'remove-recipient':
        return {
          title: t`Stop sharing with this person?`,
          description: t`${action.recipient.email} will no longer be able to open it. Anything they already read can’t be taken back.`,
          confirmLabel: t`Stop sharing`,
        }
      case 'remove-received':
        return {
          title: t`Remove this shared chat?`,
          description: t`It disappears from Shared on all your devices. To see it again, ask the person who shared it.`,
          confirmLabel: t`Remove`,
        }
    }
  }
  const confirmText = pendingAction ? confirmCopy(pendingAction) : null

  return (
    // The chat layout has no settings-style top inset of its own, so the page
    // carries it — same resting position as every settings list page.
    <div className="relative flex h-full md:pt-[var(--header-inset)]">
      <div className="min-w-0 flex-1 overflow-hidden">
        <SettingsListPane className="gap-6 md:pb-12">
          <PageHeader title={t`Shared`} />
          <SettingsListBody className={settingsListBodyRowsClass}>
            {!isReady ? (
              <SettingsEmptyState
                icon={<Lock className="size-10 text-muted-foreground" />}
                title={t`Turn on sync to share chats`}
                description={t`Shared chats are end-to-end encrypted, so sharing and reading them needs sync on this device.`}
                action={
                  <Button variant="outline" asChild>
                    <Link to="/settings/preferences">
                      <Trans>Open Preferences</Trans>
                    </Link>
                  </Button>
                }
              />
            ) : (
              <>
                <SharedTabs tab={tab} onChange={changeTab} />
                {tab === 'received' ? (
                  <ReceivedRows onRemove={(share) => requestConfirm({ kind: 'remove-received', share })} />
                ) : (
                  <SentRows
                    shares={sentShares.data}
                    titles={titles}
                    isPending={sentShares.isPending}
                    isError={sentShares.isError}
                    activeShareId={activeShareId}
                    onSelect={setActiveShareId}
                  />
                )}
              </>
            )}
          </SettingsListBody>
        </SettingsListPane>
      </div>

      <DetailPanelSurface open={activeShare !== undefined} onClose={() => setActiveShareId(null)}>
        {activeShare && (
          <SentShareDetail
            share={activeShare}
            title={chatTitleLabel(i18n, titles.get(activeShare.chatThreadId) ?? null)}
            onStopSharing={() => requestConfirm({ kind: 'stop-sharing', share: activeShare })}
            onRemoveRecipient={(recipient) =>
              requestConfirm({ kind: 'remove-recipient', share: activeShare, recipient })
            }
            onClose={() => setActiveShareId(null)}
          />
        )}
      </DetailPanelSurface>

      <ConfirmActionDialog
        open={pendingAction !== null}
        title={confirmText?.title ?? ''}
        description={
          <>
            {confirmText?.description}
            {mutations.some((mutation) => mutation.isError) && (
              <span role="alert" className="mt-2 block text-destructive">
                <Trans>That didn’t work. Please try again.</Trans>
              </span>
            )}
          </>
        }
        confirmLabel={confirmText?.confirmLabel ?? ''}
        isPending={mutations.some((mutation) => mutation.isPending)}
        onConfirm={() => pendingAction && confirmPending(pendingAction)}
        onCancel={() => setPendingAction(null)}
      />
    </div>
  )
}

export default SharedChatsPage
