/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal'
import { Textarea } from '@/components/ui/textarea'
import { debugTranscriptNoteMaxLength } from '@shared/debug-transcript-contract'
import { useId } from 'react'

type ShareDebugTranscriptDialogProps = {
  open: boolean
  userNote: string
  errorMessage: string | null
  isPending: boolean
  onOpenChange: (open: boolean) => void
  onCancel: () => void
  onUserNoteChange: (note: string) => void
  onSubmit: () => void
}

export const ShareDebugTranscriptDialog = ({
  open,
  userNote,
  errorMessage,
  isPending,
  onOpenChange,
  onCancel,
  onUserNoteChange,
  onSubmit,
}: ShareDebugTranscriptDialogProps) => {
  const userNoteId = useId()

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange} showCloseButton={false}>
      <ResponsiveModalHeader className="text-left sm:text-left">
        <ResponsiveModalTitle>Show the Thunderbolt team what happened?</ResponsiveModalTitle>
      </ResponsiveModalHeader>

      <ResponsiveModalContent className="flex flex-col gap-4 py-0">
        <ResponsiveModalDescription asChild>
          <div className="flex flex-col gap-4">
            <p>
              This sends the debug transcript to the Thunderbolt team — exactly what the agent did, step by step — so
              they can work out what went wrong.
            </p>

            <dl className="divide-y divide-border rounded-xl border border-border">
              <div className="flex flex-col gap-1 p-3">
                <dt className="text-[length:var(--font-size-sm)] font-medium text-foreground">Who can read it?</dt>
                <dd className="text-[length:var(--font-size-sm)] text-muted-foreground">
                  The Thunderbolt team, plus whoever operates the server you&apos;re connected to, for debugging.
                  It&apos;s tied to your account — it isn&apos;t anonymous.
                </dd>
              </div>
              <div className="flex flex-col gap-1 p-3">
                <dt className="text-[length:var(--font-size-sm)] font-medium text-foreground">What&apos;s in it?</dt>
                <dd className="text-[length:var(--font-size-sm)] text-muted-foreground">
                  Your prompts, system prompts, tool calls with their inputs and outputs, errors, and timestamps. Older
                  turns may be trimmed.
                </dd>
              </div>
              <div className="flex flex-col gap-1 p-3">
                <dt className="text-[length:var(--font-size-sm)] font-medium text-foreground">Where is it kept?</dt>
                <dd className="text-[length:var(--font-size-sm)] text-muted-foreground">
                  On the connected server, in plaintext, until you delete your account.
                </dd>
              </div>
            </dl>
          </div>
        </ResponsiveModalDescription>

        <div className="flex flex-col gap-2">
          <Label htmlFor={userNoteId}>Tell them what happened (optional)</Label>
          <Textarea
            id={userNoteId}
            value={userNote}
            maxLength={debugTranscriptNoteMaxLength}
            placeholder="In your own words: what were you trying to do, and what did the agent do instead?"
            disabled={isPending}
            onChange={(event) => onUserNoteChange(event.target.value)}
          />
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

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onCancel}>
          Not now
        </Button>
        <Button type="button" isLoading={isPending} loadingLabel="Sending…" onClick={onSubmit}>
          {errorMessage ? 'Retry' : 'Send to the Thunderbolt team'}
        </Button>
      </div>
    </ResponsiveModal>
  )
}
