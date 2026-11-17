/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useLingui } from '@lingui/react/macro'
import { useState, useTransition, type ReactNode } from 'react'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { DiscardCreateDialog } from '@/skills/discard-create-dialog'
import { getAdminErrorMessage } from '../api/error-messages'
import type { ResourcePageState } from './use-resource-page-state'

type RemoveConfirmation = {
  title: string
  description: ReactNode
  confirmLabel: string
  /** Removes `page.removeId`. When it throws, the dialog stays open and shows why. */
  onConfirm: (id: string) => Promise<void>
}

/**
 * The dialogs a resource page needs: discard unsaved edits before switching the selection, and
 * confirm a removal (open it with `page.patch({ removeId })`).
 */
export const ResourcePageDialogs = ({ page, remove }: { page: ResourcePageState; remove?: RemoveConfirmation }) => {
  const { t, i18n } = useLingui()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<unknown>(null)

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
      if (page.selectedId === id) {
        page.select(null)
      }
      page.patch({ removeId: null })
    })

  return (
    <>
      <DiscardCreateDialog
        open={page.pendingSelection !== null}
        title={t`Discard unsaved changes?`}
        onOpenChange={(open) => !open && page.patch({ pendingSelection: null })}
        onConfirm={() => page.pendingSelection && page.select(page.pendingSelection.id)}
      />
      {remove && (
        <ConfirmActionDialog
          open={page.removeId !== null}
          title={remove.title}
          description={
            <>
              {remove.description}
              {error !== null && (
                <span role="alert" className="mt-2 block text-destructive">
                  {i18n._(getAdminErrorMessage(error))}
                </span>
              )}
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
