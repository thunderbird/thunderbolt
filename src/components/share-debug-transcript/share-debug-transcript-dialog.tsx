/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { FormFooter } from '@/components/ui/form-footer'
import { Label } from '@/components/ui/label'
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal'
import { Textarea } from '@/components/ui/textarea'
import { Trans, useLingui } from '@lingui/react/macro'
import { debugTranscriptNoteMaxLength } from '@shared/debug-transcript-contract'
import { useId } from 'react'

type ShareDebugTranscriptDialogProps = {
  open: boolean
  userNote: string
  consentAccepted: boolean
  errorMessage: string | null
  isPending: boolean
  onOpenChange: (open: boolean) => void
  onCancel: () => void
  onUserNoteChange: (note: string) => void
  onConsentAcceptedChange: (accepted: boolean) => void
  onSubmit: () => void
}

export const ShareDebugTranscriptDialog = ({
  open,
  userNote,
  consentAccepted,
  errorMessage,
  isPending,
  onOpenChange,
  onCancel,
  onUserNoteChange,
  onConsentAcceptedChange,
  onSubmit,
}: ShareDebugTranscriptDialogProps) => {
  const { t } = useLingui()
  const userNoteId = useId()
  const consentId = useId()

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange} showCloseButton={false}>
      <ResponsiveModalHeader className="text-left sm:text-left">
        <ResponsiveModalTitle>
          <Trans>Having a problem with this chat?</Trans>
        </ResponsiveModalTitle>
      </ResponsiveModalHeader>

      <ResponsiveModalContent className="flex flex-col gap-4 py-0">
        <ResponsiveModalDescription asChild>
          <div className="flex flex-col gap-4">
            <p>
              <Trans>
                This will send the current chat with the Thunderbolt team so that they can debug the problem.
              </Trans>
            </p>

            <dl className="divide-y divide-border rounded-xl border border-border">
              <div className="flex flex-col gap-1 p-3">
                <dt className="text-[length:var(--font-size-sm)] font-medium text-foreground">
                  <Trans>Who can read it?</Trans>
                </dt>
                <dd className="text-[length:var(--font-size-sm)] text-muted-foreground">
                  <Trans>
                    The Thunderbolt team, plus whoever operates the server you&apos;re connected to, for debugging.
                    It&apos;s tied to your account — it isn&apos;t anonymous.
                  </Trans>
                </dd>
              </div>
              <div className="flex flex-col gap-1 p-3">
                <dt className="text-[length:var(--font-size-sm)] font-medium text-foreground">
                  <Trans>What&apos;s in it?</Trans>
                </dt>
                <dd className="text-[length:var(--font-size-sm)] text-muted-foreground">
                  <Trans>
                    This chat session, including the messages you sent and the responses from agent, the data inputs and
                    outputs of any tools used, errors, and timestamps.
                  </Trans>
                </dd>
              </div>
              <div className="flex flex-col gap-1 p-3">
                <dt className="text-[length:var(--font-size-sm)] font-medium text-foreground">
                  <Trans>Where is it kept?</Trans>
                </dt>
                <dd className="text-[length:var(--font-size-sm)] text-muted-foreground">
                  <Trans>
                    The chat will be retained by the current server as well as the Thunderbolt team until your account
                    is deleted.
                  </Trans>
                </dd>
              </div>
            </dl>
          </div>
        </ResponsiveModalDescription>

        <div className="flex flex-col gap-2">
          <Label htmlFor={userNoteId}>
            <Trans>Anything else you&apos;d like to share?</Trans>
          </Label>
          <Textarea
            id={userNoteId}
            value={userNote}
            maxLength={debugTranscriptNoteMaxLength}
            placeholder={t`In your own words: what were you trying to do, and what did the agent do instead?`}
            disabled={isPending}
            onChange={(event) => onUserNoteChange(event.target.value)}
          />
        </div>

        <div className="flex items-start gap-3">
          <Checkbox
            id={consentId}
            checked={consentAccepted}
            disabled={isPending}
            onCheckedChange={(checked) => onConsentAcceptedChange(checked === true)}
          />
          <Label htmlFor={consentId} className="cursor-pointer text-[length:var(--font-size-sm)] leading-normal">
            <Trans>I agree to share this chat session with the Thunderbolt team.</Trans>
          </Label>
        </div>

        {errorMessage && (
          <p
            role="alert"
            className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-[length:var(--font-size-sm)] text-destructive"
          >
            {errorMessage}
          </p>
        )}
      </ResponsiveModalContent>

      <FormFooter className="flex-col-reverse sm:flex-row">
        <Button type="button" variant="outline" onClick={onCancel}>
          <Trans>Not now</Trans>
        </Button>
        <Button
          type="button"
          isLoading={isPending}
          loadingLabel={t`Sending…`}
          disabled={!consentAccepted}
          onClick={onSubmit}
        >
          {errorMessage ? <Trans>Retry</Trans> : <Trans>Send to the Thunderbolt team</Trans>}
        </Button>
      </FormFooter>
    </ResponsiveModal>
  )
}
