/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState, useTransition } from 'react'
import { useLingui } from '@lingui/react/macro'
import { downloadArtifactHtml } from '@/artifacts/download-artifact'
import { useDatabase } from '@/contexts'
import { renameProjectArtifact, softDeleteProjectArtifact } from '@/dal/project-artifact-presentation'
import { useTransientFlag } from '@/hooks/use-transient-flag'
import type { ProjectArtifact } from './project-artifacts-data'

/** Persist artifact actions and keep failures visible in the dialog or card that initiated them. */
export const useProjectArtifactActionsState = () => {
  const { t } = useLingui()
  const db = useDatabase()
  const [dialog, setDialog] = useState<{ kind: 'rename' | 'delete'; artifact: ProjectArtifact } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const { isSet: isDownloaded, flag: downloaded } = useTransientFlag()
  const run = (operation: () => Promise<void>, failure: string, onSuccess?: () => void) => {
    setError(null)
    startTransition(async () => {
      try {
        await operation()
        onSuccess?.()
      } catch (cause) {
        console.error('[artifacts] Action failed', cause)
        setError(failure)
      }
    })
  }
  const openDialog = (artifact: ProjectArtifact, kind: 'rename' | 'delete') => {
    setError(null)
    setDialog({ artifact, kind })
  }
  const closeDialog = () => {
    if (!isPending) {
      setDialog(null)
    }
  }
  return {
    dialog,
    error,
    isPending,
    isDownloaded,
    openDialog,
    closeDialog,
    rename: (title: string) => {
      if (!dialog) {
        throw new Error('No artifact selected for renaming')
      }
      run(
        () => renameProjectArtifact(db, dialog.artifact.id, title),
        t`Could not rename the artifact. Please try again.`,
        () => setDialog(null),
      )
    },
    deleteArtifact: () => {
      if (!dialog) {
        throw new Error('No artifact selected for deletion')
      }
      run(
        () => softDeleteProjectArtifact(db, dialog.artifact.id),
        t`Could not delete the artifact. Please try again.`,
        () => setDialog(null),
      )
    },
    downloadHtml: (artifact: ProjectArtifact) =>
      run(
        () => downloadArtifactHtml(artifact.html, artifact.title),
        t`Could not download the artifact. Please try again.`,
        downloaded,
      ),
  }
}
