/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The "New project" slide-out, mirroring Create Skill: a `DetailPanel` inside the
 * list page's `DetailPanelSurface`, with the panel's close X acting as Cancel.
 *
 * The fields come from `ProjectForm`, shared with edit, so the two cannot drift.
 */

import { useLingui } from '@lingui/react/macro'
import { DetailPanel } from '@/components/detail-panel'
import { useDatabase } from '@/contexts'
import { createProject } from '@/dal/projects'
import { ProjectForm } from './project-form'

type CreateProjectPanelProps = {
  onClose: () => void
  onCreated: (projectId: string) => void
}

export const CreateProjectPanel = ({ onClose, onCreated }: CreateProjectPanelProps) => {
  const { t } = useLingui()
  const db = useDatabase()

  return (
    <DetailPanel title={t`Create project`} onClose={onClose}>
      <ProjectForm
        mode="create"
        onCancel={onClose}
        onSubmit={async ({ icon, name, description, instructions }) => {
          const project = await createProject(db, {
            name,
            icon,
            description: description.trim() || null,
            instructions: instructions.trim() || null,
          })
          onCreated(project.id)
        }}
      />
    </DetailPanel>
  )
}
