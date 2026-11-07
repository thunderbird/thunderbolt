/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState, useTransition } from 'react'
import { useLingui } from '@lingui/react/macro'
import type { Artifact } from '@/artifacts/artifact'
import { useDatabase } from '@/contexts'
import { setArtifactPinned } from '@/dal/artifacts'
import { renameProjectArtifact } from '@/dal/project-artifact-presentation'

/** Keep mutation feedback and the rename dialog alive independently of a sidebar row or menu. */
export const useArtifactSectionActions = () => {
  const { t } = useLingui()
  const db = useDatabase()
  const [renaming, setRenaming] = useState<Artifact | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const run = (operation: () => Promise<void>, failure: string, onSuccess?: () => void) => {
    setError(null)
    startTransition(async () => {
      try {
        await operation()
        onSuccess?.()
      } catch {
        setError(failure)
      }
    })
  }
  return {
    renaming,
    error,
    isPending,
    openRename: (artifact: Artifact) => {
      setError(null)
      setRenaming(artifact)
    },
    closeRename: () => {
      if (!isPending) {
        setRenaming(null)
      }
    },
    rename: (title: string) => {
      if (!renaming) {
        throw new Error('No artifact selected for renaming')
      }
      run(
        () => renameProjectArtifact(db, renaming.id, title),
        t`Could not rename the artifact. Please try again.`,
        () => setRenaming(null),
      )
    },
    unpin: (artifact: Artifact) =>
      run(() => setArtifactPinned(db, artifact.id, false), t`Could not update the artifact pin. Try again.`),
  }
}
