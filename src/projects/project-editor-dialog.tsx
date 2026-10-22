/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { DetailPanel } from '@/components/detail-panel'
import { Dialog, DialogTitle } from '@/components/ui/dialog'
import { ResponsiveModalContentComposable } from '@/components/ui/responsive-modal'
import { useDatabase } from '@/contexts'
import { createProject, updateProject } from '@/dal/projects'
import type { Project } from '@/types'
import { useIsMobile } from '@/hooks/use-mobile'
import { ProjectForm } from './project-form'

type ProjectEditorDialogProps = {
  project?: Project
  onClose: () => void
  onCreated?: (id: string) => void
}

/** Create or edit a project without leaving the current chat. */
export const ProjectEditorDialog = ({ project, onClose, onCreated }: ProjectEditorDialogProps) => {
  const { t } = useLingui()
  const db = useDatabase()
  const { isMobile } = useIsMobile()
  const title = project ? t`Project settings` : t`Create project`

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <ResponsiveModalContentComposable
        flush
        showCloseButton={isMobile}
        aria-describedby={undefined}
        className="gap-0 p-0 md:h-[min(760px,90vh)] md:max-w-xl"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DetailPanel title={title} onClose={onClose}>
          <ProjectForm
            key={project?.id ?? 'new'}
            mode={project ? 'edit' : 'create'}
            initialValues={
              project
                ? {
                    name: project.name,
                    icon: project.icon,
                    description: project.description ?? '',
                    instructions: project.instructions ?? '',
                  }
                : undefined
            }
            onCancel={onClose}
            onSubmit={async ({ name, icon, description, instructions }) => {
              const values = {
                name,
                icon,
                description: description.trim() || null,
                instructions: instructions.trim() || null,
              }
              if (project) {
                await updateProject(db, project.id, values)
                onClose()
                return
              }
              const created = await createProject(db, values)
              onClose()
              onCreated?.(created.id)
            }}
          />
        </DetailPanel>
      </ResponsiveModalContentComposable>
    </Dialog>
  )
}
