/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState, useTransition } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useLingui } from '@lingui/react/macro'
import { useProjectExecution } from '@/agent-execution/use-project-execution'
import { ProjectExecutionUnavailableError } from '@/agent-execution/project-execution'
import type { AgentExecution } from '@/agent-execution/store'
import { isTauriDesktop } from '@/lib/platform'

/** Project chats inherit one immutable location; only this device's grant may change. */
export const useProjectExecutionControlsState = (projectId: string) => {
  const { t } = useLingui()
  const project = useProjectExecution(projectId)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const execution: AgentExecution =
    project.execution ??
    (project.declaration?.location === 'ssh'
      ? { location: 'ssh', environmentId: project.declaration.environmentId, cwd: '', access: 'ask' }
      : project.location === 'computer'
        ? { location: 'computer', cwd: '', access: 'ask' }
        : { location: project.location === 'cloud' ? 'cloud' : 'sandbox', access: 'ask' })
  const unavailable =
    project.error instanceof ProjectExecutionUnavailableError
      ? project.error.reason === 'desktop-required'
        ? t`Open this project in the desktop app to run its agent.`
        : project.error.reason === 'folder-required'
          ? t`Choose this project's working folder on this computer before running its agent.`
          : null
      : project.error
        ? t`Could not load the project environment.`
        : null
  return {
    execution,
    locationLocked: true,
    available: project.execution !== null,
    pending: pending || project.loading,
    desktop: isTauriDesktop(),
    error: pickerError ?? unavailable,
    setExecution: (next: AgentExecution) => {
      if (next.location === project.location) {
        project.setAccess(next.access)
      }
    },
    openFolder: () =>
      startTransition(async () => {
        setPickerError(null)
        try {
          const cwd = await invoke<string | null>('agent_pick_workspace', {
            path: null,
            title: t`Choose project folder`,
          })
          if (cwd !== null) {
            project.bindComputer(cwd)
          }
        } catch (error) {
          console.error('[projects] Could not bind project folder', error)
          setPickerError(t`Could not select a working folder. Please try again.`)
        }
      }),
  }
}
