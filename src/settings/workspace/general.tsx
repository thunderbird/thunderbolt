/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import { useDatabase } from '@/contexts'
import { updateWorkspaceName, type Workspace } from '@/dal'
import { useActiveWorkspaceMembership } from '@/hooks/use-active-workspace-membership'
import { useCanCreateWorkspace } from '@/hooks/use-can-create-workspace'
import { useDebouncedCallback } from '@/hooks/use-debounce'
import { useActiveWorkspace } from '@/lib/active-workspace'
import { CreateWorkspaceModal } from '@/layout/sidebar/create-workspace-modal'
import { InviteMembersModal } from '@/layout/sidebar/invite-members-modal'
import { useTrustDomainRegistry } from '@/stores/trust-domain-registry'
import { zodResolver } from '@hookform/resolvers/zod'
import dayjs from 'dayjs'
import { Calendar, User } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useNavigate } from 'react-router'
import { z } from 'zod'

const useActiveUserId = (): string | undefined =>
  useTrustDomainRegistry((state) => {
    if (state.activeTrustDomain?.kind === 'standalone') {
      return state.localUserId
    }
    if (state.activeTrustDomain?.kind === 'server') {
      return state.servers[state.activeTrustDomain.serverId]?.userId
    }
    return undefined
  })

const WorkspaceMeta = ({ workspace }: { workspace: Workspace }) => {
  const activeUserId = useActiveUserId()
  const { isAdmin } = useActiveWorkspaceMembership()
  const isOwner = !!workspace.ownerUserId && workspace.ownerUserId === activeUserId
  const roleLabel = isOwner ? 'Owner' : isAdmin ? 'Admin' : null
  const created = workspace.createdAt ? dayjs(workspace.createdAt).format('MM.DD.YYYY') : null

  return (
    <div className="flex flex-wrap items-center gap-4 text-[12px] font-normal leading-[1.2] text-muted-foreground">
      {roleLabel && (
        <span className="inline-flex items-center gap-1.5">
          <User className="size-3" />
          {roleLabel}
        </span>
      )}
      {created && (
        <span className="inline-flex items-center gap-1.5">
          <Calendar className="size-3" />
          Created {created}
        </span>
      )}
    </div>
  )
}

const renameSchema = z.object({
  name: z.string().refine((value) => value.trim().length > 0, { message: 'Workspace name is required' }),
})

type RenameFormValues = z.infer<typeof renameSchema>

const renameDebounceMs = 600

const RenameWorkspaceForm = ({ workspace }: { workspace: Workspace }) => {
  const db = useDatabase()
  const [submitError, setSubmitError] = useState<string | null>(null)

  const form = useForm<RenameFormValues>({
    resolver: zodResolver(renameSchema),
    defaultValues: { name: workspace.name },
    mode: 'onChange',
  })

  // Shared save path used by both the debounced onChange and the immediate
  // onBlur. Empty + baseline-match short-circuit so the debounce firing after
  // a blur-triggered save is a harmless no-op.
  const save = useCallback(
    async (value: string) => {
      const trimmed = value.trim()
      if (!trimmed || trimmed === workspace.name) {
        return
      }
      setSubmitError(null)
      try {
        await updateWorkspaceName(db, workspace.id, trimmed)
        // Reset baseline so subsequent saves compare against the just-written
        // value, not the prop snapshot from when this callback was created.
        form.reset({ name: trimmed })
      } catch (e) {
        setSubmitError(e instanceof Error ? e.message : 'Failed to save workspace name.')
      }
    },
    [db, workspace.id, workspace.name, form],
  )

  const debouncedSave = useDebouncedCallback(save, renameDebounceMs)

  return (
    <Form {...form}>
      <form className="flex flex-col gap-2">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-sm font-medium">Workspace name</FormLabel>
              <FormControl>
                <Input
                  inputSize="lg"
                  placeholder="e.g. Engineering"
                  {...field}
                  onChange={(e) => {
                    field.onChange(e)
                    debouncedSave(e.target.value)
                  }}
                  onBlur={(e) => {
                    field.onBlur()
                    void save(e.target.value)
                  }}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {submitError && (
          <p className="text-sm text-destructive" role="alert">
            {submitError}
          </p>
        )}
      </form>
    </Form>
  )
}

const WorkspaceGeneralPage = () => {
  const active = useActiveWorkspace()
  const canCreate = useCanCreateWorkspace()
  const navigate = useNavigate()
  const [createOpen, setCreateOpen] = useState(false)
  // After the create modal commits, hold the new workspace id so the invite
  // modal can target it; clearing this also closes the invite modal.
  const [inviteWorkspaceId, setInviteWorkspaceId] = useState<string | null>(null)

  const handleCreated = (workspaceId: string) => {
    setCreateOpen(false)
    setInviteWorkspaceId(workspaceId)
  }

  const handleInviteClose = () => {
    const id = inviteWorkspaceId
    setInviteWorkspaceId(null)
    if (id) {
      navigate(`/w/${id}/`)
    }
  }

  return (
    <div className="flex flex-col p-4 pb-12 w-full max-w-[760px] mx-auto">
      <PageHeader title="Workspace Settings">
        {canCreate && (
          <Button variant="outline" size="lg" onClick={() => setCreateOpen(true)}>
            Create New
          </Button>
        )}
      </PageHeader>
      {active && (
        <>
          <div className="mt-3 mb-6">
            <WorkspaceMeta workspace={active} />
          </div>
          <Card>
            <CardContent>
              {/* Re-key by workspace id so switching workspaces fully remounts the
               *  form — defaultValues read from the new active.name, isDirty resets. */}
              <RenameWorkspaceForm key={active.id} workspace={active} />
            </CardContent>
          </Card>
        </>
      )}

      <CreateWorkspaceModal open={createOpen} onOpenChange={setCreateOpen} onCreated={handleCreated} />
      <InviteMembersModal
        open={inviteWorkspaceId !== null}
        workspaceId={inviteWorkspaceId}
        onClose={handleInviteClose}
      />
    </div>
  )
}

export default WorkspaceGeneralPage
