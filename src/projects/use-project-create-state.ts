/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer, useTransition } from 'react'
import { useLingui } from '@lingui/react/macro'
import { useAsyncAttempt } from '@/hooks/use-async-attempt'
import { defaultAgentExecution, type AgentExecution } from '@/agent-execution/store'

export type ProjectCreateValues = { name: string; icon: string | null; execution: AgentExecution }
type State = ProjectCreateValues & { error: string | null }

/** Keep the compact form editable after a failed creation and prevent blank submissions. */
export const useProjectCreateState = <T>(
  onSubmit: (values: ProjectCreateValues) => Promise<T>,
  onSuccess?: (created: T) => void | Promise<void>,
) => {
  const { t } = useLingui()
  const [state, update] = useReducer((current: State, changes: Partial<State>) => ({ ...current, ...changes }), {
    name: '',
    icon: null,
    execution: defaultAgentExecution,
    error: null,
  })
  const [isPending, startTransition] = useTransition()
  const submission = useAsyncAttempt()
  const canCreate =
    state.name.trim().length > 0 &&
    !isPending &&
    (state.execution.location !== 'computer' || state.execution.cwd.trim().length > 0)

  return {
    ...state,
    isPending,
    canCreate,
    setName: (name: string) => update({ name, error: null }),
    setIcon: (icon: string | null) => update({ icon, error: null }),
    setExecution: (execution: AgentExecution) => update({ execution, error: null }),
    submit: () => {
      if (!canCreate) {
        return
      }
      const attempt = submission.begin()
      if (!attempt) {
        return
      }
      startTransition(async () => {
        try {
          const created = await onSubmit({ name: state.name.trim(), icon: state.icon, execution: state.execution })
          if (attempt.isCurrent()) {
            await onSuccess?.(created)
          }
        } catch (error) {
          console.error('[projects] Could not create project', error)
          if (attempt.isCurrent()) {
            update({ error: t`Could not create the project.` })
          }
        } finally {
          attempt.finish()
        }
      })
    },
  }
}
