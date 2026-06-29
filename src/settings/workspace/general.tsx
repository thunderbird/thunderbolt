/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Form } from '@/components/ui/form'
import { PageHeader } from '@/components/ui/page-header'
import {
  slugifyWorkspaceName,
  WorkspaceFormFields,
  workspaceFormSchema,
  type WorkspaceFormValues,
} from '@/components/workspace/workspace-form-fields'
import { useDatabase } from '@/contexts'
import { duplicateWorkspace, updateWorkspace, type UpdateWorkspacePatch, type Workspace } from '@/dal'
import { useActiveWorkspaceMembership } from '@/hooks/use-active-workspace-membership'
import { useCanCreateWorkspace } from '@/hooks/use-can-create-workspace'
import { useDebouncedCallback } from '@/hooks/use-debounce'
import { useActiveWorkspace } from '@/lib/active-workspace'
import { CreateWorkspaceModal } from '@/layout/sidebar/create-workspace-modal'
import { InviteMembersModal } from '@/layout/sidebar/invite-members-modal'
import { useConfigStore } from '@/api/config-store'
import { useActiveUserId } from '@/stores/trust-domain-registry'
import { zodResolver } from '@hookform/resolvers/zod'
import { Plus } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useNavigate } from 'react-router'

const WorkspaceActions = ({ workspace }: { workspace: Workspace }) => {
  const db = useDatabase()
  const canCreate = useCanCreateWorkspace()
  const { isAdmin } = useActiveWorkspaceMembership()
  const navigate = useNavigate()
  const userId = useActiveUserId()
  const [busy, setBusy] = useState(false)
  // Duplicate copies the current workspace's resources, so members without
  // admin/owner rights aren't allowed to clone it — only the personal owner
  // or a shared-workspace admin can.
  const canDuplicate = canCreate && (workspace.isPersonal === 1 || isAdmin)

  const handleDuplicate = async () => {
    if (!userId || busy) {
      return
    }
    setBusy(true)
    try {
      // Append a short random suffix so a second duplicate of the same source
      // (or any existing `{slug}-copy`) doesn't collide on the server-side
      // slug unique index — the upload would otherwise reject with
      // WORKSPACE_SLUG_TAKEN and leave the local row unsynced.
      const newId = await duplicateWorkspace(db, workspace, {
        creatorUserId: userId,
        name: `${workspace.name} Copy`,
        slug: workspace.slug ? `${workspace.slug}-copy-${crypto.randomUUID().slice(0, 8)}` : null,
        icon: workspace.icon,
      })
      navigate(`/w/${newId}/`)
    } finally {
      setBusy(false)
    }
  }

  if (!canDuplicate) {
    return null
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button type="button" variant="outline" size="lg" disabled={busy || !userId}>
            Duplicate Workspace
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Duplicate workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              This will create a copy of <strong>{workspace.name}</strong> including models, MCP servers, prompts,
              skills, agents, and tasks. Chat history won't be copied.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDuplicate} disabled={busy || !userId}>
              Duplicate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

const renameDebounceMs = 600

const RenameWorkspaceForm = ({ workspace }: { workspace: Workspace }) => {
  const db = useDatabase()
  const { isAdmin } = useActiveWorkspaceMembership()
  const isPersonal = workspace.isPersonal === 1
  // Non-admin members of a shared workspace can view the form but not edit —
  // the upload handler would reject any PATCH anyway, so we disable the inputs
  // and skip wiring the autosave callbacks rather than letting a failed save
  // round-trip surface as a phantom error.
  const canEdit = isPersonal || isAdmin
  const [submitError, setSubmitError] = useState<string | null>(null)

  const form = useForm<WorkspaceFormValues>({
    resolver: zodResolver(workspaceFormSchema),
    defaultValues: { workspaceName: workspace.name, icon: workspace.icon },
    mode: 'onChange',
  })

  // Reflect remote updates into the form baseline so a subsequent autosave
  // doesn't clobber them. `keepDirtyValues: true` preserves any field the
  // user is actively editing — the user wins, and the next autosave PATCHes
  // against the freshest server value.
  useEffect(() => {
    form.reset({ workspaceName: workspace.name, icon: workspace.icon }, { keepDirtyValues: true })
  }, [workspace.name, workspace.icon, form])

  // Shared save path used by debounced onChange and immediate onBlur. Reads
  // current form state on every call so the timer never fires with stale args.
  const save = useCallback(async () => {
    const { workspaceName, icon } = form.getValues()
    const patch: UpdateWorkspacePatch = {}
    const trimmedName = workspaceName.trim()
    if (trimmedName && trimmedName !== workspace.name) {
      patch.name = trimmedName
    }
    // Shared workspaces: slug auto-derives from the (saved) name unless the user
    // had previously customised it. The customisation heuristic mirrors the old
    // URL-input lock — slug ≠ slugify(old name) means it was hand-edited and we
    // leave it alone.
    if (!isPersonal && trimmedName) {
      const prevAutoSlug = slugifyWorkspaceName(workspace.name)
      const slugIsCustomised = workspace.slug !== null && workspace.slug !== prevAutoSlug
      if (!slugIsCustomised) {
        const finalSlug = slugifyWorkspaceName(trimmedName) || null
        if (finalSlug !== (workspace.slug ?? null)) {
          patch.slug = finalSlug
        }
      }
    }
    if (icon !== (workspace.icon ?? null)) {
      patch.icon = icon
    }
    if (Object.keys(patch).length === 0) {
      return
    }
    setSubmitError(null)
    try {
      await updateWorkspace(db, workspace.id, patch)
      // Reset baseline so future debounces compare against the just-saved values.
      form.reset({
        workspaceName: patch.name ?? workspaceName,
        icon: patch.icon !== undefined ? patch.icon : icon,
      })
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Failed to save workspace.')
    }
  }, [db, workspace.id, workspace.name, workspace.slug, workspace.icon, isPersonal, form])

  const debouncedSave = useDebouncedCallback(save, renameDebounceMs)

  return (
    <Form {...form}>
      <form className="flex flex-col gap-4">
        <WorkspaceFormFields
          form={form}
          iconPlaceholder={workspace.name.trim()[0]?.toUpperCase()}
          onDebouncedChange={canEdit ? debouncedSave : undefined}
          onCommit={canEdit ? () => void save() : undefined}
          disabled={!canEdit}
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
  const e2eeEnabled = useConfigStore((state) => state.config.e2eeEnabled === true)
  const [createOpen, setCreateOpen] = useState(false)
  // After the create modal commits, hold the new workspace id so the invite
  // modal can target it; clearing this also closes the invite modal.
  const [inviteWorkspaceId, setInviteWorkspaceId] = useState<string | null>(null)

  const handleCreated = (workspaceId: string) => {
    setCreateOpen(false)
    // @todo Drop this E2EE branch once the encryption pipeline supports
    // multi-recipient envelopes and is workspace-aware (see THU-593). The
    // BE rejects pending memberships under E2EE, so opening the invite step
    // would only show an empty form that always errors on submit.
    if (e2eeEnabled) {
      navigate(`/w/${workspaceId}/`)
      return
    }
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
      <PageHeader title="Workspaces">
        {canCreate && (
          <Button
            variant="outline"
            size="icon"
            className="rounded-lg"
            onClick={() => setCreateOpen(true)}
            aria-label="Create workspace"
          >
            <Plus />
          </Button>
        )}
      </PageHeader>
      {active && (
        <Card className="mt-6">
          <CardContent>
            {/* Re-key by workspace id so switching workspaces fully remounts the
             *  form — defaultValues read from the new active.name, isDirty resets. */}
            <RenameWorkspaceForm key={active.id} workspace={active} />
            <div className="mt-6">
              <WorkspaceActions workspace={active} />
            </div>
          </CardContent>
        </Card>
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
