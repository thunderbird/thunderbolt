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
        <ResponsiveModalTitle>Share debug transcript?</ResponsiveModalTitle>
      </ResponsiveModalHeader>

      <ResponsiveModalContent className="flex flex-col gap-4 py-0">
        <ResponsiveModalDescription asChild>
          <div className="flex flex-col gap-2">
            <p>
              <span className="font-medium text-foreground">Identified upload.</span> This is tied to your account and
              is not anonymous.
            </p>
            <p>
              <span className="font-medium text-foreground">Conversation data.</span> Includes your prompts, system
              prompts, tool calls with inputs and outputs, errors, and timestamps.
            </p>
            <p>
              <span className="font-medium text-foreground">Stored on the connected server.</span> The engineers who
              operate this server can read the transcript for debugging.
            </p>
            <p>Older turns may be trimmed.</p>
          </div>
        </ResponsiveModalDescription>

        <div className="flex flex-col gap-2">
          <Label htmlFor={userNoteId}>What went wrong? (optional)</Label>
          <Textarea
            id={userNoteId}
            value={userNote}
            maxLength={2000}
            placeholder="Describe the problem to help the engineers who operate this server investigate."
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
          Cancel
        </Button>
        <Button type="button" isLoading={isPending} loadingLabel="Sending…" onClick={onSubmit}>
          {errorMessage ? 'Retry' : 'Send transcript'}
        </Button>
      </div>
    </ResponsiveModal>
  )
}
