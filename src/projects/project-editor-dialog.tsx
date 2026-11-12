/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { DetailPanel } from '@/components/detail-panel'
import { Dialog, DialogTitle } from '@/components/ui/dialog'
import { ResponsiveModalContentComposable } from '@/components/ui/responsive-modal'
import type { Project } from '@/types'
import { ProjectForm } from './project-form'
import { ProjectExecutionSummary } from './project-execution-summary'
import { useProjectEditorState } from './use-project-editor-state'

type ProjectEditorDialogProps = {
  project: Project
  onClose: () => void
}

/** Edit a project's details without leaving the current chat. */
export const ProjectEditorDialog = ({ project, onClose }: ProjectEditorDialogProps) => {
  const { t } = useLingui()
  const state = useProjectEditorState(project.id)
  const title = t`Project settings`

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <ResponsiveModalContentComposable
        flush
        aria-describedby={undefined}
        className="gap-0 p-0 md:max-h-[min(760px,90dvh)] md:max-w-xl"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DetailPanel title={title} onClose={onClose} showCloseButton={false}>
          <ProjectForm
            key={project.id}
            environment={<ProjectExecutionSummary projectId={project.id} />}
            execution={state.execution}
            initialValues={{
              name: project.name,
              icon: project.icon,
              description: project.description ?? '',
              instructions: project.instructions ?? '',
            }}
            onCancel={onClose}
            onSuccess={onClose}
            onSubmit={state.submit}
          />
        </DetailPanel>
      </ResponsiveModalContentComposable>
    </Dialog>
  )
}
