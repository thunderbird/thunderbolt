/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState, useTransition } from 'react'
import { useLingui } from '@lingui/react/macro'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { useDatabase } from '@/contexts'
import { softDeleteAllProjects, softDeleteProject } from '@/dal/projects'

export type ProjectDeletionTarget = { scope: 'one'; projectId: string } | { scope: 'all' }

/** Keep deletion pending/error state alive after any project menu closes. */
export const ProjectDeleteDialog = ({
  target,
  onClose,
  onDeleted,
}: {
  target: ProjectDeletionTarget
  onClose: () => void
  onDeleted: () => void | Promise<void>
}) => {
  const { t } = useLingui()
  const db = useDatabase()
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  return (
    <ConfirmActionDialog
      open
      title={target.scope === 'all' ? t`Delete all projects?` : t`Delete this project?`}
      description={
        error ??
        (target.scope === 'all'
          ? t`This will delete all projects and their instructions. Their chats will be kept and moved to Recents.`
          : t`Its instructions are removed. Chats in the project are kept and become ordinary chats.`)
      }
      confirmLabel={target.scope === 'all' ? t`Delete all projects` : t`Delete project`}
      isPending={isPending}
      onCancel={() => {
        if (!isPending) {
          onClose()
        }
      }}
      onConfirm={() =>
        startTransition(async () => {
          try {
            if (target.scope === 'all') {
              await softDeleteAllProjects(db)
            } else {
              await softDeleteProject(db, target.projectId)
            }
            onClose()
            await onDeleted()
          } catch (cause) {
            console.error('[projects] Could not delete project', cause)
            setError(
              target.scope === 'all'
                ? t`Could not delete the projects. Please try again.`
                : t`Could not delete the project. Please try again.`,
            )
          }
        })
      }
    />
  )
}
