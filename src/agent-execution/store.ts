/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type AgentExecution = { access: 'ask' | 'full' } & (
  | { location: 'computer'; cwd: string }
  | { location: 'ssh'; environmentId: string; cwd: string }
  | { location: 'sandbox' | 'cloud'; cwd?: string }
)
export const defaultAgentExecution: AgentExecution = { location: 'sandbox', access: 'ask' }

type ExecutionStore = {
  byThread: Record<string, AgentExecution>
  byProject: Record<string, AgentExecution>
  setProjectExecution: (projectId: string, execution: AgentExecution | null) => void
  setExecution: (threadId: string, execution: AgentExecution) => void
}

/** Device-local choices: native paths and grants must never follow a chat through sync. */
export const useAgentExecutionStore = create<ExecutionStore>()(
  persist(
    (set) => ({
      byThread: {},
      byProject: {},
      setProjectExecution: (projectId, execution) =>
        set((state) => {
          if (execution) {
            return { byProject: { ...state.byProject, [projectId]: execution } }
          }
          const { [projectId]: discarded, ...byProject } = state.byProject
          void discarded
          return { byProject }
        }),
      setExecution: (threadId, execution) =>
        set((state) => ({ byThread: { ...state.byThread, [threadId]: execution } })),
    }),
    {
      name: 'thunderbolt-agent-execution-v1',
      partialize: (state) => ({ byThread: state.byThread, byProject: state.byProject }),
    },
  ),
)

/** Read the current thread's choice at send time, avoiding stale adapter closures. */
export const getAgentExecution = (threadId: string): AgentExecution =>
  useAgentExecutionStore.getState().byThread[threadId] ?? defaultAgentExecution
