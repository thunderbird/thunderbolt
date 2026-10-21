/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState, useTransition } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useLingui } from '@lingui/react/macro'
import { defaultAgentExecution, useAgentExecutionStore } from '@/agent-execution/store'
import { isTauriDesktop } from '@/lib/platform'

/** Keeps workspace validation and local runtime settings outside the controls' markup. */
export const useAgentExecutionControlsState = (threadId: string) => {
  const { t } = useLingui()
  const execution = useAgentExecutionStore((state) => state.byThread[threadId] ?? defaultAgentExecution)
  const setExecution = useAgentExecutionStore((state) => state.setExecution)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const openFolder = () =>
    startTransition(async () => {
      setError(null)
      try {
        const cwd = await invoke<string | null>('agent_pick_workspace', {
          path: execution.cwd ?? null,
          title: t`Work on this computer`,
        })
        if (cwd !== null) {
          setExecution(threadId, { ...execution, location: 'computer', cwd })
        }
      } catch (error) {
        console.error('Failed to select agent workspace:', error)
        setError(t`Could not select a working folder. Please try again.`)
      }
    })
  return {
    execution,
    setExecution: (next: typeof execution) => setExecution(threadId, next),
    desktop: isTauriDesktop(),
    error,
    pending,
    openFolder,
  }
}
