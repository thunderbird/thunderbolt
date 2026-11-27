/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useLingui } from '@lingui/react/macro'
import { useState, useTransition, type ReactNode } from 'react'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { DiscardCreateDialog } from '@/skills/discard-create-dialog'
import type { ResourcePageState } from './use-resource-page-state'
import { InlineError } from './inline-error'

type RemoveConfirmation = {
  title: string
  description: ReactNode
  confirmLabel: string
  /** Whether the removed item's open panel closes; an item that stays listed (retired) keeps it. */
  closesPanel?: boolean
  /** Removes `page.removeId`. When it throws, the dialog stays open and shows why. */
  onConfirm: (id: string) => Promise<void>
}

/**
 * The dialogs a resource page needs: discard unsaved edits before switching the selection, and
 * confirm a removal (open it with `page.patch({ removeId })`).
 */
export const ResourcePageDialogs = ({ page, remove }: { page: ResourcePageState; remove?: RemoveConfirmation }) => {
  const { t } = useLingui()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<unknown>(null)

  const leaveCopy =
    page.dirty === 'secret'
      ? { title: t`Leave without copying the token?`, description: t`It won't be shown again.` }
      : page.isCreating
        ? { title: t`Leave without creating?`, description: undefined }
        : { title: t`Leave without saving?`, description: t`Your changes won't be saved.` }

  const cancelRemove = () => {
    setError(null)
    page.patch({ removeId: null })
  }

  const confirmRemove = (id: string) =>
    startTransition(async () => {
      try {
        await remove?.onConfirm(id)
      } catch (caught) {
        setError(caught)
        return
      }
      setError(null)
      if (page.selectedId === id && remove?.closesPanel !== false) {
        page.select(null)
      }
      page.patch({ removeId: null })
    })

  return (
    <>
      {/* Worded as Skills words it: leaving an edit loses changes, leaving a create loses the new item. */}
      <DiscardCreateDialog
        open={page.pendingSelection !== null}
        title={leaveCopy.title}
        description={leaveCopy.description}
        onOpenChange={(open) => !open && page.patch({ pendingSelection: null })}
        onConfirm={() => page.pendingSelection && page.select(page.pendingSelection.id, page.pendingSelection)}
      />
      {remove && (
        <ConfirmActionDialog
          open={page.removeId !== null}
          title={remove.title}
          description={
            <>
              {remove.description}
              <InlineError error={error} className="mt-2" />
            </>
          }
          confirmLabel={remove.confirmLabel}
          isPending={isPending}
          onCancel={cancelRemove}
          onConfirm={() => page.removeId !== null && confirmRemove(page.removeId)}
        />
      )}
    </>
  )
}
