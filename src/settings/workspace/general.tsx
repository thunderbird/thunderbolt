/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import { useDatabase } from '@/contexts'
import { updateWorkspace, type UpdateWorkspacePatch, type Workspace } from '@/dal'
import { useActiveWorkspaceMembership } from '@/hooks/use-active-workspace-membership'
import { useCanCreateWorkspace } from '@/hooks/use-can-create-workspace'
import { useDebouncedCallback } from '@/hooks/use-debounce'
import { useActiveWorkspace } from '@/lib/active-workspace'
import { CreateWorkspaceModal } from '@/layout/sidebar/create-workspace-modal'
import { InviteMembersModal } from '@/layout/sidebar/invite-members-modal'
import { useActiveCloudUrl, useTrustDomainRegistry } from '@/stores/trust-domain-registry'
import { zodResolver } from '@hookform/resolvers/zod'
import dayjs from 'dayjs'
import { Calendar, User } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useNavigate } from 'react-router'
import { z } from 'zod'
import { IconPicker } from './icon-picker'

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

const slugMaxLength = 50

/** Slugify any text into a URL-safe shape: lowercase a–z 0–9 hyphens. */
const slugify = (input: string): string =>
  input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, slugMaxLength)

/** Allow lowercase a–z 0–9 and hyphens to flow through the slug input live. */
const sanitizeSlugInput = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, slugMaxLength)

/** Strip protocol from the cloud URL for a clean inline prefix. */
const formatSlugPrefix = (cloudUrl: string | undefined): string => {
  const host = cloudUrl ? cloudUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') : ''
  return `${host}/w/`
}

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
  slug: z.string(),
  icon: z.string().nullable(),
})

type RenameFormValues = z.infer<typeof renameSchema>

const renameDebounceMs = 600

const RenameWorkspaceForm = ({ workspace }: { workspace: Workspace }) => {
  const db = useDatabase()
  const cloudUrl = useActiveCloudUrl()
  const isPersonal = workspace.isPersonal === 1
  const slugPrefix = formatSlugPrefix(cloudUrl)

  const initialSlug = workspace.slug ?? slugify(workspace.name)
  const [slugLocked, setSlugLocked] = useState(
    () => workspace.slug !== null && workspace.slug !== slugify(workspace.name),
  )
  const [submitError, setSubmitError] = useState<string | null>(null)

  const form = useForm<RenameFormValues>({
    resolver: zodResolver(renameSchema),
    defaultValues: { name: workspace.name, slug: initialSlug, icon: workspace.icon },
    mode: 'onChange',
  })

  // Shared save path used by debounced onChange and immediate onBlur. Reads
  // current form state on every call so the timer never fires with stale args.
  const save = useCallback(async () => {
    const { name, slug, icon } = form.getValues()
    const patch: UpdateWorkspacePatch = {}
    const trimmedName = name.trim()
    if (trimmedName && trimmedName !== workspace.name) {
      patch.name = trimmedName
    }
    if (!isPersonal) {
      const finalSlug = slugify(slug) || null
      if (finalSlug !== (workspace.slug ?? null)) {
        patch.slug = finalSlug
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
      // Reset baseline so future debounces compare against the just-saved
      // values. Display the canonicalised slug we actually wrote.
      form.reset({
        name: patch.name ?? name,
        slug: patch.slug !== undefined ? (patch.slug ?? '') : slug,
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
                    if (!slugLocked && !isPersonal) {
                      form.setValue('slug', slugify(e.target.value), { shouldDirty: false })
                    }
                    debouncedSave()
                  }}
                  onBlur={() => {
                    field.onBlur()
                    void save()
                  }}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {!isPersonal && (
          <FormField
            control={form.control}
            name="slug"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-sm font-medium">Workspace URL</FormLabel>
                <div className="flex h-[var(--touch-height-lg)] w-full rounded-lg border border-input bg-transparent overflow-hidden focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]">
                  <span className="flex items-center px-4 text-[length:var(--font-size-body)] text-muted-foreground bg-muted whitespace-nowrap select-none">
                    {slugPrefix}
                  </span>
                  <FormControl>
                    <input
                      type="text"
                      placeholder="engineering"
                      className="flex-1 min-w-0 px-4 py-2 bg-transparent outline-none text-[length:var(--font-size-body)]"
                      {...field}
                      onChange={(e) => {
                        const cleaned = sanitizeSlugInput(e.target.value)
                        field.onChange(cleaned)
                        setSlugLocked(true)
                        debouncedSave()
                      }}
                      onBlur={() => {
                        field.onBlur()
                        void save()
                      }}
                    />
                  </FormControl>
                </div>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        <FormField
          control={form.control}
          name="icon"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-sm font-medium">Icon (optional)</FormLabel>
              <p className="text-sm text-muted-foreground -mt-1">
                Upload an image or pick an emoji. This icon will appear in your sidebar and notifications.
              </p>
              <FormControl>
                <IconPicker
                  value={field.value}
                  onChange={(next) => {
                    field.onChange(next)
                    void save()
                  }}
                  placeholder={workspace.name.trim()[0]?.toUpperCase()}
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
