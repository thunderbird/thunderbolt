/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { selectMinimalMode, useConfigStore } from '@/api/config-store'
import { lazy, Suspense } from 'react'
import { Dialog, DialogTitle } from '@/components/ui/dialog'
import { ResponsiveModalContentComposable } from '@/components/ui/responsive-modal'
import { useIsMobile } from '@/hooks/use-mobile'
import { PageFallback } from '@/loading'
import { useProjectArtifactsDialog } from './use-project-artifacts-dialog'
import { loadProjectArtifactsDialog } from './load-project-artifacts-dialog'

// Warmed by the project menu; still excluded from the landing-page bundle.
const ProjectArtifactsDialogContent = lazy(loadProjectArtifactsDialog)

/** One modal host keeps the underlying chat, draft, and content panel mounted. */
export const ProjectArtifactsDialog = () => {
  const dialog = useProjectArtifactsDialog()
  const { isMobile } = useIsMobile()
  const minimalMode = useConfigStore((state) => selectMinimalMode(state.config))
  if (!dialog.projectId || minimalMode) {
    return null
  }

  return (
    <Dialog open onOpenChange={(open) => !open && dialog.close()}>
      <ResponsiveModalContentComposable
        aria-describedby={undefined}
        className="gap-0 overflow-hidden p-0 md:max-h-[calc(100dvh-3rem)] md:w-[calc(100%-2rem)] md:max-w-[1040px]"
        onOpenAutoFocus={(event) => {
          if (isMobile) {
            event.preventDefault()
          }
        }}
      >
        <DialogTitle className="sr-only">
          <Trans>Artifacts</Trans>
        </DialogTitle>
        <Suspense fallback={<PageFallback />}>
          <ProjectArtifactsDialogContent key={dialog.projectId} projectId={dialog.projectId} />
        </Suspense>
      </ResponsiveModalContentComposable>
    </Dialog>
  )
}
