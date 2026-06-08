/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { EmailChipInput } from '@/components/ui/email-chip-input'
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
import { useEffect, useReducer, useRef } from 'react'
import { useNavigate } from 'react-router'

type Step = 'name' | 'invite'

type State = {
  step: Step
  name: string
  emails: string[]
  submitting: boolean
}

type Action =
  | { type: 'set-name'; name: string }
  | { type: 'continue' }
  | { type: 'back' }
  | { type: 'set-emails'; emails: string[] }
  | { type: 'submit-start' }
  | { type: 'submit-end' }
  | { type: 'reset' }

const initial: State = { step: 'name', name: '', emails: [], submitting: false }

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'set-name':
      return { ...state, name: action.name }
    case 'continue':
      return state.name.trim().length > 0 ? { ...state, step: 'invite' } : state
    case 'back':
      return { ...state, step: 'name' }
    case 'set-emails':
      return { ...state, emails: action.emails }
    case 'submit-start':
      return { ...state, submitting: true }
    case 'submit-end':
      return { ...state, submitting: false }
    case 'reset':
      return initial
  }
}

type CreateWorkspaceModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Two-step "Create Workspace" wizard rendered from the sidebar selector
 * footer. Step 1 captures a name; step 2 captures optional email invites.
 * Submission writes the workspace + creator admin membership + one pending
 * row per email locally (PowerSync uploads the batch). The BE upload handler
 * promotes pending rows to active memberships for emails matching existing
 * users in the same upload transaction — see
 * `backend/src/powersync/upload-handlers/workspace-pending-memberships.ts`.
 *
 * The modal closes optimistically as soon as the local writes commit and
 * navigates to the new workspace. Permanent BE rejects (server policy,
 * etc.) surface through the global sync status indicator; a per-write
 * rollback / toast is deferred to the `rejected_writes` track.
 */
export const CreateWorkspaceModal = ({ open, onOpenChange }: CreateWorkspaceModalProps) => {
  const [state, dispatch] = useReducer(reducer, initial)
  const db = useDatabase()
  const authClient = useAuth()
  const { data: session } = authClient.useSession()
  const navigate = useNavigate()

  // The reducer holds form state across re-opens by default; reset whenever
  // the modal closes so the next open is a clean step-1 form. The transition
  // (open → closed) is detected via a ref to avoid an extra useEffect on
  // every render.
  const previouslyOpenRef = useRef(open)
  useEffect(() => {
    if (previouslyOpenRef.current && !open) {
      dispatch({ type: 'reset' })
    }
    previouslyOpenRef.current = open
  }, [open])

  const userId = session?.user?.id
  const creatorEmail = session?.user?.email ?? undefined
  const canSubmit = state.name.trim().length > 0 && !state.submitting && !!userId

  const submit = async () => {
    if (!canSubmit || !userId) {
      return
    }
    dispatch({ type: 'submit-start' })
    try {
      const workspaceId = await createSharedWorkspace(db, {
        creatorUserId: userId,
        creatorEmail,
        name: state.name,
        invitedEmails: state.emails,
      })
      onOpenChange(false)
      navigate(`/w/${workspaceId}/`)
    } finally {
      dispatch({ type: 'submit-end' })
    }
  }

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalHeader>
        <ResponsiveModalTitle>{state.step === 'name' ? 'Create workspace' : 'Invite teammates'}</ResponsiveModalTitle>
        <ResponsiveModalDescription>
          {state.step === 'name'
            ? 'Workspaces let you collaborate with teammates on shared chats, prompts, and tools.'
            : 'Add the emails of people you want to invite. You can also skip and invite later.'}
        </ResponsiveModalDescription>
      </ResponsiveModalHeader>

      <ResponsiveModalContent>
        {state.step === 'name' ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="create-workspace-name">Workspace name</Label>
            <Input
              id="create-workspace-name"
              autoFocus
              value={state.name}
              onChange={(e) => dispatch({ type: 'set-name', name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && state.name.trim().length > 0) {
                  e.preventDefault()
                  dispatch({ type: 'continue' })
                }
              }}
              placeholder="e.g. Engineering"
            />
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Label htmlFor="create-workspace-emails">Invite by email</Label>
            <EmailChipInput
              inputId="create-workspace-emails"
              value={state.emails}
              onChange={(emails) => dispatch({ type: 'set-emails', emails })}
              placeholder="alice@example.com, bob@example.com"
            />
          </div>
        )}
      </ResponsiveModalContent>

      <ResponsiveModalFooter>
        {state.step === 'name' ? (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={state.submitting}>
              Cancel
            </Button>
            <Button onClick={() => dispatch({ type: 'continue' })} disabled={state.name.trim().length === 0}>
              Continue
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => dispatch({ type: 'back' })} disabled={state.submitting}>
              Back
            </Button>
            <Button variant="outline" onClick={submit} disabled={!canSubmit}>
              Skip
            </Button>
            <Button onClick={submit} disabled={!canSubmit}>
              {state.submitting ? 'Creating…' : 'Create workspace'}
            </Button>
          </>
        )}
      </ResponsiveModalFooter>
    </ResponsiveModal>
  )
}
