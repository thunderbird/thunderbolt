/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { getProjectExecution } from '@/agent-execution/project-execution'
import { matchesExecutionTarget, useAgentExecutionStore } from '@/agent-execution/store'
import { useProjectExecution } from '@/agent-execution/use-project-execution'
import { useDatabase } from '@/contexts/database-context'
import { updateProject } from '@/dal/projects'
import { getIdentitySignal } from '@/lib/identity-lifetime'
import type { ProjectFormValues } from './project-form'

/** Save project details and an explicitly edited device-local grant without changing its environment. */
export const useProjectEditorState = (projectId: string) => {
  const { t } = useLingui()
  const db = useDatabase()
  const { execution } = useProjectExecution(projectId)
  return {
    execution,
    submit: async ({ name, icon, description, instructions, execution: requested }: ProjectFormValues) => {
      const identity = getIdentitySignal()
      await updateProject(db, projectId, {
        name,
        icon,
        description: description.trim() || null,
        instructions: instructions.trim() || null,
      })
      if (!requested) {
        return
      }
      const current = await getProjectExecution(db, projectId)
      identity.throwIfAborted()
      if (!matchesExecutionTarget(current, requested)) {
        throw new Error(t`This project's working environment changed. Review its permissions and try again.`)
      }
      useAgentExecutionStore.getState().setProjectExecution(projectId, { ...current, access: requested.access })
    },
  }
}
