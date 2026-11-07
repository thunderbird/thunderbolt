/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createContext, useContext, type PropsWithChildren } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { RenameArtifactDialog } from './rename-artifact-dialog'
import { useProjectArtifactActionsState } from './use-project-artifact-actions-state'

const ArtifactActionsContext = createContext<ReturnType<typeof useProjectArtifactActionsState> | null>(null)

/** Shared actions outlive virtual rows, responsive column changes, and menu triggers. */
export const useProjectArtifactActions = () => {
  const actions = useContext(ArtifactActionsContext)
  if (!actions) {
    throw new Error('Artifact actions require ProjectArtifactActionsProvider')
  }
  return actions
}

export const ProjectArtifactActionsProvider = ({ children }: PropsWithChildren) => {
  const { t } = useLingui()
  const actions = useProjectArtifactActionsState()
  return (
    <ArtifactActionsContext value={actions}>
      {children}
      {!actions.dialog && actions.error && (
        <p role="alert" className="px-4 py-2 text-xs text-destructive">
          {actions.error}
        </p>
      )}
      {actions.isDownloaded && (
        <p role="status" className="px-4 py-2 text-xs text-muted-foreground">
          <Trans>Artifact downloaded</Trans>
        </p>
      )}
      {actions.dialog?.kind === 'rename' && (
        <RenameArtifactDialog
          key={actions.dialog.artifact.id}
          title={actions.dialog.artifact.title}
          error={actions.error}
          isPending={actions.isPending}
          onSave={actions.rename}
          onClose={actions.closeDialog}
        />
      )}
      {actions.dialog?.kind === 'delete' && (
        <ConfirmActionDialog
          open
          title={t`Delete artifact?`}
          description={
            actions.error ??
            t`“${actions.dialog.artifact.title}” will be removed from project artifacts and pinned shortcuts. The original output will remain in its source chat.`
          }
          confirmLabel={t`Delete`}
          isPending={actions.isPending}
          onCancel={actions.closeDialog}
          onConfirm={actions.deleteArtifact}
        />
      )}
    </ArtifactActionsContext>
  )
}
