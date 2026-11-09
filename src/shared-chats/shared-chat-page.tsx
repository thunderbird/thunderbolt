/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useE2eeReady } from '@/hooks/use-e2ee-ready'
import { useFormatters } from '@/i18n/use-formatters'
import { useAppName } from '@/lib/branding-selectors'
import { chatTitleLabel } from '@/lib/title-generator'
import { Trans, useLingui } from '@lingui/react/macro'
import { AlertCircle, Eye, Lock } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { type OpenedShare, ShareContentInvalidError, ShareGoneError, ShareUnreadableError } from '@/services/shares'
import { SharedTranscript } from './shared-transcript'
import { useRemoveReceivedShare, useSharedChat } from './use-shared-chats'

type UnavailableReason = 'gone' | 'unreadable' | 'invalid' | 'failed'

/**
 * What a failed open means for the reader: the share is gone, this device
 * lacks its key, its content can't be shown anywhere, or something else broke.
 */
export const unavailableReason = (error: unknown): UnavailableReason => {
  if (error instanceof ShareGoneError) {
    return 'gone'
  }
  if (error instanceof ShareUnreadableError) {
    return 'unreadable'
  }
  if (error instanceof ShareContentInvalidError) {
    return 'invalid'
  }
  return 'failed'
}

/** Why a shared chat cannot be shown. */
const SharedChatUnavailable = ({ reason }: { reason: UnavailableReason }) => {
  const { t } = useLingui()
  const appName = useAppName()
  const copy = {
    gone: {
      title: t`This chat is no longer shared with you`,
      description: t`The person who shared it stopped sharing it, or deleted the chat.`,
    },
    unreadable: {
      title: t`This shared chat can’t be opened here`,
      description: t`It was shared with a key this device doesn’t hold. Try opening it on another of your devices.`,
    },
    invalid: {
      title: t`This shared chat can’t be shown`,
      description: t`Its content isn’t in a form this version of ${appName} can show. Updating ${appName} may help.`,
    },
    failed: {
      title: t`Couldn’t open this shared chat`,
      description: t`Something went wrong. Please try again.`,
    },
  }[reason]
  return (
    <EmptyState
      icon={reason === 'failed' || reason === 'invalid' ? AlertCircle : Lock}
      title={copy.title}
      description={copy.description}
      action={
        <Button variant="outline" asChild>
          <Link to="/shared">
            <Trans>Back to Shared</Trans>
          </Link>
        </Button>
      }
    />
  )
}

const SyncRequired = () => {
  const { t } = useLingui()
  return (
    <EmptyState
      icon={Lock}
      title={t`Turn on sync to read shared chats`}
      description={t`Shared chats are end-to-end encrypted, so they open only on a device with sync turned on.`}
      action={
        <Button variant="outline" asChild>
          <Link to="/settings/preferences">
            <Trans>Open Preferences</Trans>
          </Link>
        </Button>
      }
    />
  )
}

/** A centered state filling the chat area, where an empty chat shows its greeting. */
const CenteredState = ({ children }: { children: ReactNode }) => (
  <div className="flex h-full items-center justify-center px-3 pt-[var(--header-inset)]">{children}</div>
)

/**
 * Sits where a chat's composer would: who shared this, and that it can't be
 * answered. Same width, surface and spacing as the composer, so the page reads
 * as a chat with the input swapped out.
 */
const ViewOnlyBar = ({
  share,
  title,
  onRemove,
}: {
  share: OpenedShare['share']
  title: string
  onRemove: () => void
}) => {
  const formatters = useFormatters()
  const owner = share.owner.name || share.owner.email
  const sharedAt = formatters.relativeTime(share.updatedAt)

  return (
    <div className="relative z-10 flex px-3 pb-3 md:px-4 md:pb-4">
      <div className="mx-auto flex w-full min-w-[268px] max-w-[696px] items-center gap-3 rounded-2xl bg-sidebar px-4 py-3 shadow-glow dark:shadow-none">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[length:var(--font-size-body)] font-medium">{title}</p>
          <p className="truncate text-[length:var(--font-size-sm)] text-muted-foreground">
            <Trans>
              Shared by {owner} · {sharedAt}
            </Trans>
          </p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[length:var(--font-size-xs)] text-muted-foreground">
          <Eye className="size-3.5" aria-hidden="true" />
          <Trans>View only</Trans>
        </span>
        <Button variant="ghost" size="sm" className="shrink-0" onClick={onRemove}>
          <Trans>Remove</Trans>
        </Button>
      </div>
    </div>
  )
}

/** A chat someone shared with you, laid out like a chat with its composer swapped for a view-only bar. */
const SharedChatPage = () => {
  const { i18n, t } = useLingui()
  const navigate = useNavigate()
  const { shareId = '' } = useParams()
  const isReady = useE2eeReady()
  const { data, error, isPending } = useSharedChat(shareId, isReady)
  const removeShare = useRemoveReceivedShare()
  const [isConfirmingRemove, setIsConfirmingRemove] = useState(false)

  if (!isReady) {
    return (
      <CenteredState>
        <SyncRequired />
      </CenteredState>
    )
  }
  if (error) {
    return (
      <CenteredState>
        <SharedChatUnavailable reason={unavailableReason(error)} />
      </CenteredState>
    )
  }

  return (
    <div className="h-full w-full">
      <div className="flex h-full w-full flex-col overflow-hidden">
        <div className="relative min-h-0 flex-1">
          <div className="hide-scrollbar h-full overflow-y-auto">
            {/* Same column as a live chat: centered, capped, clear of the floating header. */}
            <div className="mx-auto w-full min-w-[300px] max-w-[728px] space-y-4 px-3 pt-[calc(var(--header-inset)+1.5rem)] pb-6 md:px-4">
              {isPending ? (
                <div className="flex flex-col gap-6">
                  <Skeleton className="ml-auto h-12 w-1/2 rounded-2xl" />
                  <Skeleton className="h-24 w-full rounded-md" />
                  <Skeleton className="ml-auto h-12 w-2/5 rounded-2xl" />
                </div>
              ) : (
                // Keyed by `updatedAt`: a replaced snapshot starts fresh, not with the
                // old one's failed messages or widget selections.
                <SharedTranscript
                  key={data.share.updatedAt}
                  shareId={data.share.id}
                  version={data.share.updatedAt}
                  snapshot={data.snapshot}
                />
              )}
            </div>
          </div>
        </div>
        {!isPending && (
          <ViewOnlyBar
            share={data.share}
            title={chatTitleLabel(i18n, data.snapshot.title || null)}
            onRemove={() => setIsConfirmingRemove(true)}
          />
        )}
      </div>
      <ConfirmActionDialog
        open={isConfirmingRemove}
        title={t`Remove this shared chat?`}
        description={
          <>
            {t`It disappears from Shared on all your devices. To see it again, ask the person who shared it.`}
            {removeShare.isError && (
              <span role="alert" className="mt-2 block text-destructive">
                <Trans>That didn’t work. Please try again.</Trans>
              </span>
            )}
          </>
        }
        confirmLabel={t`Remove`}
        isPending={removeShare.isPending}
        onConfirm={() =>
          removeShare.mutate(shareId, {
            onSuccess: () => navigate('/shared', { replace: true }),
            onError: (removeError) => console.error('Removing a shared chat failed', removeError),
          })
        }
        onCancel={() => {
          removeShare.reset()
          setIsConfirmingRemove(false)
        }}
      />
    </div>
  )
}

export default SharedChatPage
