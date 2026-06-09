/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal'
import { useAuth, useDatabase } from '@/contexts'
import { createSharedWorkspace } from '@/dal/workspaces'
import { useEffect, useRef, useState } from 'react'

type CreateWorkspaceModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after the workspace + defaults are committed locally. The caller is
   *  expected to follow up with the invite modal and the navigation. */
  onCreated: (workspaceId: string) => void
}

/**
 * Single-step "Create a Workspace" modal. Captures the workspace name; on
 * submit, writes the workspace + creator admin membership + seeded defaults
 * into a single local transaction (PowerSync uploads the batch).
 *
 * After the local writes commit, control hands off to `onCreated` — the
 * parent (sidebar selector) opens the invite modal and handles navigation
 * once that closes.
 */
export const CreateWorkspaceModal = ({ open, onOpenChange, onCreated }: CreateWorkspaceModalProps) => {
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const db = useDatabase()
  const authClient = useAuth()
  const { data: session } = authClient.useSession()

  // Reset on close so the next open starts fresh.
  const previouslyOpenRef = useRef(open)
  useEffect(() => {
    if (previouslyOpenRef.current && !open) {
      setName('')
      setSubmitting(false)
    }
    previouslyOpenRef.current = open
  }, [open])

  const userId = session?.user?.id
  const creatorEmail = session?.user?.email ?? undefined
  const trimmed = name.trim()
  const canSubmit = trimmed.length > 0 && !submitting && !!userId

  const submit = async () => {
    if (!canSubmit || !userId) {
      return
    }
    setSubmitting(true)
    try {
      const workspaceId = await createSharedWorkspace(db, {
        creatorUserId: userId,
        creatorEmail,
        name: trimmed,
      })
      onCreated(workspaceId)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange} className="sm:min-h-fit">
      <ResponsiveModalHeader className="mt-6">
        <ResponsiveModalTitle className="text-xl leading-7 font-normal text-center">
          Create a Workspace
        </ResponsiveModalTitle>
        <ResponsiveModalDescription className="text-[length:var(--font-size-body)] leading-7 font-normal text-center">
          What kind of workspace do you want to create?
        </ResponsiveModalDescription>
      </ResponsiveModalHeader>

      <ResponsiveModalContent>
        <div className="flex flex-col gap-2">
          <Label htmlFor="create-workspace-name" className="text-[length:var(--font-size-body)] leading-7 font-normal">
            Workspace name
          </Label>
          <Input
            id="create-workspace-name"
            inputSize="lg"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSubmit) {
                e.preventDefault()
                void submit()
              }
            }}
            placeholder="e.g. Engineering"
          />
        </div>
      </ResponsiveModalContent>

      <ResponsiveModalFooter className="mt-8 flex-col sm:flex-col">
        <Button size="lg" className="w-full" onClick={submit} disabled={!canSubmit}>
          {submitting ? 'Creating…' : 'Create'}
        </Button>
      </ResponsiveModalFooter>
    </ResponsiveModal>
  )
}
