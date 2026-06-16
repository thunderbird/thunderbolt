/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { Form } from '@/components/ui/form'
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal'
import {
  formatWorkspaceSlugPrefix,
  slugifyWorkspaceName,
  WorkspaceFormFields,
  workspaceFormSchema,
  type WorkspaceFormValues,
} from '@/components/workspace/workspace-form-fields'
import { useAuth, useDatabase } from '@/contexts'
import { createSharedWorkspace } from '@/dal/workspaces'
import { useActiveCloudUrl } from '@/stores/trust-domain-registry'
import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect, useRef } from 'react'
import { useForm, useWatch } from 'react-hook-form'

type CreateWorkspaceModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after the workspace + defaults are committed locally. The caller is
   *  expected to follow up with the invite modal and the navigation. */
  onCreated: (workspaceId: string) => void
}

const emptyValues: WorkspaceFormValues = { name: '', slug: '', icon: null }

/**
 * "Create a Workspace" modal. Captures name + slug + icon via the shared
 * `WorkspaceFormFields` (same component used by the settings page); on submit,
 * writes the workspace + creator admin membership + seeded defaults into a
 * single local transaction (PowerSync uploads the batch).
 *
 * After the local writes commit, control hands off to `onCreated` — the
 * parent (sidebar selector) opens the invite modal and handles navigation
 * once that closes.
 */
export const CreateWorkspaceModal = ({ open, onOpenChange, onCreated }: CreateWorkspaceModalProps) => {
  const db = useDatabase()
  const cloudUrl = useActiveCloudUrl()
  const authClient = useAuth()
  const { data: session } = authClient.useSession()

  const form = useForm<WorkspaceFormValues>({
    resolver: zodResolver(workspaceFormSchema),
    defaultValues: emptyValues,
    mode: 'onChange',
  })

  // Reset on close so the next open starts fresh.
  const previouslyOpenRef = useRef(open)
  useEffect(() => {
    if (previouslyOpenRef.current && !open) {
      form.reset(emptyValues)
    }
    previouslyOpenRef.current = open
  }, [open, form])

  // Tracks `open` synchronously so the submit handler can skip the post-create
  // callback when the user dismissed the modal during the in-flight transaction.
  // Otherwise `onCreated` runs against a closed flow, opens the invite modal,
  // and navigates the user into a workspace they thought they'd cancelled out of.
  const openRef = useRef(open)
  openRef.current = open

  const userId = session?.user?.id
  const creatorEmail = session?.user?.email ?? undefined
  const slugPrefix = formatWorkspaceSlugPrefix(cloudUrl)
  const watchedName = useWatch({ control: form.control, name: 'name' })
  const canSubmit = !!userId && watchedName.trim().length > 0

  const submit = form.handleSubmit(async (values) => {
    if (!userId) {
      return
    }
    const workspaceId = await createSharedWorkspace(db, {
      creatorUserId: userId,
      creatorEmail,
      name: values.name,
      slug: slugifyWorkspaceName(values.slug) || null,
      icon: values.icon,
    })
    // The local DB transaction commits regardless — the workspace will show up
    // in the user's list once they reopen the selector. We just skip the
    // navigation + invite-modal handoff when they've already moved on.
    if (!openRef.current) {
      return
    }
    onCreated(workspaceId)
  })

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

      <Form {...form}>
        <form onSubmit={submit}>
          <ResponsiveModalContent>
            <div className="flex flex-col gap-4">
              <WorkspaceFormFields form={form} slugPrefix={slugPrefix} />
            </div>
          </ResponsiveModalContent>

          <ResponsiveModalFooter className="mt-8 flex-col sm:flex-col">
            <Button type="submit" size="lg" className="w-full" disabled={!canSubmit}>
              Create
            </Button>
          </ResponsiveModalFooter>
        </form>
      </Form>
    </ResponsiveModal>
  )
}
