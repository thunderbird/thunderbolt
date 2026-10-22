/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState, useTransition } from 'react'
import { useLingui } from '@lingui/react/macro'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { useDatabase } from '@/contexts'
import { softDeleteProject } from '@/dal/projects'

/** Keep deletion pending/error state alive after any project menu closes. */
export const ProjectDeleteDialog = ({
  projectId,
  onClose,
  onDeleted,
}: {
  projectId: string
  onClose: () => void
  onDeleted: () => void
}) => {
  const { t } = useLingui()
  const db = useDatabase()
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  return (
    <ConfirmActionDialog
      open
      title={t`Delete this project?`}
      description={error ?? t`Its instructions are removed. Chats in the project are kept and become ordinary chats.`}
      confirmLabel={t`Delete project`}
      isPending={isPending}
      onCancel={() => {
        if (!isPending) {
          onClose()
        }
      }}
      onConfirm={() =>
        startTransition(async () => {
          try {
            await softDeleteProject(db, projectId)
            onClose()
            onDeleted()
          } catch (cause) {
            console.error('[projects] Could not delete project', cause)
            setError(t`Could not delete the project. Please try again.`)
          }
        })
      }
    />
  )
}
