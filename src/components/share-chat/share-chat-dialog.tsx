/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { IconCircle } from '@/components/onboarding/icon-circle'
import { Button } from '@/components/ui/button'
import { ResponsiveModal, ResponsiveModalContent, ResponsiveModalTitle } from '@/components/ui/responsive-modal'
import { Skeleton } from '@/components/ui/skeleton'
import { useE2eeReady } from '@/hooks/use-e2ee-ready'
import { useAppName } from '@/lib/branding-selectors'
import { type SentShare, useSentShares } from '@/shared-chats/use-shared-chats'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { maxShareRecipients } from '@shared/chat-shares'
import { AlertCircle, Check, Lock, Share2, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { EmailTagInput } from './email-tag-input'
import { type ShareFailure, useShareChatState } from './use-share-chat-state'

type ShareChatDialogProps = {
  chatThreadId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Centered icon, title and explanation — the same step header as the passkey and sync setup dialogs. */
const StepHeader = ({ icon, title, children }: { icon: ReactNode; title: ReactNode; children: ReactNode }) => (
  <div className="space-y-4 text-center">
    <IconCircle>{icon}</IconCircle>
    <h2 className="text-2xl font-bold">{title}</h2>
    <p className="text-muted-foreground">{children}</p>
  </div>
)

const FailureMessage = ({ failure }: { failure: ShareFailure }) => {
  switch (failure) {
    case 'too-large':
      return <Trans>This chat is too large to share. Artifacts with embedded images take the most room.</Trans>
    case 'not-synced':
      return <Trans>This chat hasn’t finished syncing yet. Try again in a moment.</Trans>
    case 'changed-elsewhere':
      return (
        <Trans>
          Sharing for this chat changed on another device. Close this and open Share again to see who has it now.
        </Trans>
      )
    case 'stop-failed':
      return <Trans>Couldn’t stop sharing. Please try again.</Trans>
    case 'failed':
      return <Trans>Something went wrong. Please try again.</Trans>
  }
}

/** The share form. Mounted only while the dialog is open, so every opening starts from the chat's current share. */
const ShareChatForm = ({
  chatThreadId,
  existingShare,
  onDone,
}: {
  chatThreadId: string
  existingShare: SentShare | undefined
  onDone: () => void
}) => {
  const { t } = useLingui()
  const navigate = useNavigate()
  const appName = useAppName()
  const { state, canShare, isSameRecipients, setDraft, addEmails, removeEmail, share, requestStop, cancelStop, stop } =
    useShareChatState(chatThreadId, existingShare)
  const unavailable = state.tags.filter((tag) => tag.status === 'unavailable')
  const invalid = state.tags.filter((tag) => tag.status === 'invalid')
  const isSharing = state.phase === 'sharing'
  const count = state.tags.length

  if (state.phase === 'load-failed') {
    return <ShareLoadFailed onDone={onDone} />
  }

  if (state.phase === 'shared') {
    return (
      <div className="flex w-full flex-col">
        <StepHeader
          icon={<Check className="size-8 text-primary" />}
          title={state.existing ? <Trans>Share updated</Trans> : <Trans>Chat shared</Trans>}
        >
          {state.existing ? (
            <Plural
              value={count}
              one="Updated for # person. They now see the latest version of the chat."
              other="Updated for # people. They now see the latest version of the chat."
            />
          ) : (
            <Plural
              value={count}
              one="Shared with # person. They’ll get an email and can open it from Shared."
              other="Shared with # people. They’ll get an email and can open it from Shared."
            />
          )}
        </StepHeader>
        <div className="space-y-4 pt-5">
          <Button className="w-full" onClick={onDone}>
            <Trans>Done</Trans>
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            onClick={() => {
              onDone()
              navigate('/shared?tab=sent')
            }}
          >
            <Trans>Manage shared chats</Trans>
          </Button>
        </div>
      </div>
    )
  }

  if (state.phase === 'confirming-stop' || state.phase === 'stopping') {
    return (
      <div className="flex w-full flex-col">
        <StepHeader icon={<Trash2 className="size-8 text-primary" />} title={<Trans>Stop sharing this chat?</Trans>}>
          <Trans>
            Nobody you shared it with will be able to open it anymore. Anything they already read can’t be taken back.
          </Trans>
        </StepHeader>
        <div className="space-y-4 pt-5">
          <Button
            variant="destructive"
            className="w-full"
            onClick={() => stop(onDone)}
            isLoading={state.phase === 'stopping'}
            loadingLabel={t`Stopping…`}
          >
            <Trans>Stop sharing</Trans>
          </Button>
          <Button variant="ghost" className="w-full" onClick={cancelStop} disabled={state.phase === 'stopping'}>
            <Trans>Cancel</Trans>
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex w-full flex-col">
      <StepHeader icon={<Share2 className="size-8 text-primary" />} title={<Trans>Share chat</Trans>}>
        {state.existing ? (
          <Plural
            value={state.existing.emails.length}
            one="Shared with # person. Saving updates everyone to the chat as it is now."
            other="Shared with # people. Saving updates everyone to the chat as it is now."
          />
        ) : (
          <Trans>
            People you add can read this chat as it is now. They can’t reply to or edit it, and see what you add later
            only when you update the share.
          </Trans>
        )}
      </StepHeader>

      <div className="space-y-4 pt-5">
        <div className="space-y-2">
          <EmailTagInput
            tags={state.tags}
            draft={state.draft}
            disabled={isSharing}
            onDraftChange={setDraft}
            onCommit={(text) => void addEmails(text)}
            onRemove={removeEmail}
          />
          <p className="text-sm text-muted-foreground">
            <Trans>
              Up to {maxShareRecipients} people. Each needs a {appName} account with sync turned on.
            </Trans>
          </p>
        </div>
        {unavailable.map((tag) => (
          <p key={tag.email} role="alert" className="text-sm text-destructive">
            <Trans>
              {tag.email} can’t receive shared chats. They need a {appName} account with sync turned on.
            </Trans>
          </p>
        ))}
        {invalid.map((tag) => (
          <p key={tag.email} role="alert" className="text-sm text-destructive">
            <Trans>{tag.email} isn’t a valid email address.</Trans>
          </p>
        ))}
        {state.failure && (
          <p role="alert" className="text-sm text-destructive">
            <FailureMessage failure={state.failure} />
          </p>
        )}
        <Button
          className="w-full"
          onClick={() => void share()}
          disabled={!canShare}
          isLoading={isSharing}
          loadingLabel={state.existing ? t`Updating…` : t`Sharing…`}
        >
          {!state.existing ? (
            <Trans>Share</Trans>
          ) : isSameRecipients ? (
            <Trans>Update to latest</Trans>
          ) : (
            <Trans>Save changes</Trans>
          )}
        </Button>
        {state.existing && (
          <Button variant="ghost" className="w-full text-destructive" onClick={requestStop} disabled={isSharing}>
            <Trans>Stop sharing</Trans>
          </Button>
        )}
        <Button variant="ghost" className="w-full" onClick={onDone} disabled={isSharing}>
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </div>
  )
}

/** Shown on a device without sync keys: sharing needs them to seal the chat. */
const SyncRequired = ({ onDone }: { onDone: () => void }) => {
  const navigate = useNavigate()
  return (
    <div className="flex w-full flex-col">
      <StepHeader icon={<Lock className="size-8 text-primary" />} title={<Trans>Turn on sync to share</Trans>}>
        <Trans>Shared chats are end-to-end encrypted, so sharing one needs sync on this device.</Trans>
      </StepHeader>
      <div className="space-y-4 pt-5">
        <Button
          className="w-full"
          onClick={() => {
            onDone()
            navigate('/settings/preferences')
          }}
        >
          <Trans>Open Preferences</Trans>
        </Button>
        <Button variant="ghost" className="w-full" onClick={onDone}>
          <Trans>Not now</Trans>
        </Button>
      </div>
    </div>
  )
}

/** While the chat's current share loads: the form needs it to know whether this is a new share or an edit. */
const ShareFormSkeleton = () => (
  <div className="flex w-full flex-col items-center gap-4" aria-busy="true">
    <Skeleton className="size-16 rounded-full" />
    <Skeleton className="h-8 w-40 rounded-md" />
    <Skeleton className="h-12 w-full rounded-md" />
    <Skeleton className="h-[var(--touch-height-default)] w-full rounded-lg" />
  </div>
)

const ShareLoadFailed = ({ onDone }: { onDone: () => void }) => (
  <div className="flex w-full flex-col">
    <StepHeader icon={<AlertCircle className="size-8 text-destructive" />} title={<Trans>Couldn’t load sharing</Trans>}>
      <Trans>Couldn’t check who this chat is shared with. Please try again.</Trans>
    </StepHeader>
    <div className="pt-5">
      <Button className="w-full" onClick={onDone}>
        <Trans>Close</Trans>
      </Button>
    </div>
  </div>
)

const ShareChatDialogBody = ({ chatThreadId, onDone }: { chatThreadId: string; onDone: () => void }) => {
  const isReady = useE2eeReady()
  const sent = useSentShares()
  if (!isReady) {
    return <SyncRequired onDone={onDone} />
  }
  // The form reads the share once, on mount, so wait for this mount's read: a
  // list cached by an earlier one may predate a share made since. A synced list
  // can still trail an edit on another device; saving names the version it
  // read, and the server refuses a stale one. Once mounted, the form stays up
  // through a later read error, so a share or stop in progress keeps its state.
  if (!sent.data || !sent.isFetchedAfterMount) {
    return sent.isError ? <ShareLoadFailed onDone={onDone} /> : <ShareFormSkeleton />
  }
  return (
    <ShareChatForm
      chatThreadId={chatThreadId}
      existingShare={sent.data.find((share) => share.chatThreadId === chatThreadId)}
      onDone={onDone}
    />
  )
}

/**
 * Share a chat with specific people by email. What they receive is a frozen,
 * view-only copy of the chat as it is now, readable only by them. On a chat
 * already shared, the same dialog edits who has it, refreshes their copy, or
 * stops sharing.
 */
export const ShareChatDialog = ({ chatThreadId, open, onOpenChange }: ShareChatDialogProps) => (
  <ResponsiveModal open={open} onOpenChange={onOpenChange} className="sm:min-h-0 sm:h-auto">
    <ResponsiveModalTitle className="sr-only">
      <Trans>Share chat</Trans>
    </ResponsiveModalTitle>
    <ResponsiveModalContent>
      {open && (
        <ShareChatDialogBody key={chatThreadId} chatThreadId={chatThreadId} onDone={() => onOpenChange(false)} />
      )}
    </ResponsiveModalContent>
  </ResponsiveModal>
)
