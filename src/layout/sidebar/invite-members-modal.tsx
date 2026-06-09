/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal'
import { Textarea } from '@/components/ui/textarea'
import { useAuth, useDatabase } from '@/contexts'
import { addPendingMemberships } from '@/dal/workspaces'
import { isValidEmailFormat } from '@/lib/utils'
import { useEffect, useMemo, useRef, useState } from 'react'

const separatorRegex = /[\s,;]+/

const parseEmails = (text: string): { valid: string[]; invalid: string[] } => {
  const valid: string[] = []
  const invalid: string[] = []
  const seen = new Set<string>()
  for (const token of text.split(separatorRegex)) {
    const email = token.trim().toLowerCase()
    if (!email) {
      continue
    }
    if (seen.has(email)) {
      continue
    }
    seen.add(email)
    if (isValidEmailFormat(email)) {
      valid.push(email)
    } else {
      invalid.push(token.trim())
    }
  }
  return { valid, invalid }
}

type InviteMembersModalProps = {
  open: boolean
  /** When non-null, the workspace the invites are being added to. The component
   *  expects this to stay stable while `open` is true. */
  workspaceId: string | null
  onClose: () => void
}

/**
 * Second-leg modal after `CreateWorkspaceModal`. Captures an optional list of
 * comma-separated emails and writes one `workspace_pending_memberships` row
 * per valid email. The BE upload handler resolves each email against existing
 * users in the same upload transaction and promotes pending rows to active
 * memberships for matches (see
 * `backend/src/powersync/upload-handlers/workspace-pending-memberships.ts`).
 *
 * Both "Skip for now" and "Send invites" close the modal; the parent handles
 * navigation once the modal closes.
 */
export const InviteMembersModal = ({ open, workspaceId, onClose }: InviteMembersModalProps) => {
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const db = useDatabase()
  const authClient = useAuth()
  const { data: session } = authClient.useSession()

  // Reset on close so the next open starts fresh.
  const previouslyOpenRef = useRef(open)
  useEffect(() => {
    if (previouslyOpenRef.current && !open) {
      setText('')
      setSubmitting(false)
    }
    previouslyOpenRef.current = open
  }, [open])

  const parsed = useMemo(() => parseEmails(text), [text])
  const hasText = text.trim().length > 0
  const canSend = hasText && parsed.invalid.length === 0 && parsed.valid.length > 0
  const userId = session?.user?.id
  const creatorEmail = session?.user?.email ?? undefined

  const handleSkip = () => {
    if (submitting) {
      return
    }
    onClose()
  }

  const handleSend = async () => {
    if (!workspaceId || !userId || submitting) {
      return
    }
    setSubmitting(true)
    try {
      if (parsed.valid.length > 0) {
        await addPendingMemberships(db, {
          workspaceId,
          invitedByUserId: userId,
          creatorEmail,
          emails: parsed.valid,
        })
      }
      onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ResponsiveModal
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
      className="sm:min-h-fit"
    >
      <ResponsiveModalHeader className="mt-6">
        <ResponsiveModalTitle className="text-xl leading-7 font-normal text-center">
          Invite team members
        </ResponsiveModalTitle>
        <ResponsiveModalDescription className="text-[length:var(--font-size-body)] leading-7 font-normal text-center">
          Type emails below, separated by commas.
        </ResponsiveModalDescription>
      </ResponsiveModalHeader>

      <ResponsiveModalContent>
        <div className="flex flex-col gap-2">
          <Textarea
            id="invite-emails"
            aria-label="Emails"
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="alice@example.com, bob@example.com"
            rows={4}
            aria-invalid={parsed.invalid.length > 0 ? 'true' : undefined}
          />
          {parsed.invalid.length > 0 && (
            <p role="alert" className="text-[length:var(--font-size-xs)] text-destructive">
              Invalid: {parsed.invalid.join(', ')}
            </p>
          )}
        </div>
      </ResponsiveModalContent>

      <ResponsiveModalFooter className="mt-8 justify-between sm:justify-between">
        <Button variant="outline" size="lg" onClick={handleSkip} disabled={submitting}>
          Skip for now
        </Button>
        <Button size="lg" onClick={handleSend} disabled={!canSend || submitting}>
          {submitting ? 'Sending…' : 'Send invites'}
        </Button>
      </ResponsiveModalFooter>
    </ResponsiveModal>
  )
}
