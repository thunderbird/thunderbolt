/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useQuery } from '@powersync/tanstack-react-query'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useDatabase } from '@/contexts/database-context'
import { useAgentExecutionStore, type AgentExecution } from './store'
import {
  getProjectExecutionQuery,
  parseProjectExecution,
  resolveProjectExecution,
  type ProjectExecutionDeclaration,
  type ProjectExecutionLocation,
} from './project-execution'
import { useSshEnvironmentsStore } from './ssh-environments'

/** Subscribe to one immutable project choice and its independent device-local grant. */
export const useProjectExecution = (projectId: string) => {
  const db = useDatabase()
  const query = useQuery({
    queryKey: ['projectExecution', projectId],
    query: toCompilableQuery(getProjectExecutionQuery(db, projectId)),
  })
  const binding = useAgentExecutionStore((state) => state.byProject[projectId])
  // Connection edits/deletion invalidate resolution even when the synced project row is unchanged.
  useSshEnvironmentsStore((state) => state.environments)
  const result = (() => {
    if (query.isLoading || query.error) {
      return { location: null, declaration: null, execution: null, error: query.error } as {
        location: ProjectExecutionLocation | null
        declaration: ProjectExecutionDeclaration | null
        execution: AgentExecution | null
        error: unknown
      }
    }
    try {
      const declaration = parseProjectExecution(query.data?.[0]?.value)
      const { location } = declaration
      try {
        return { location, declaration, execution: resolveProjectExecution(declaration, binding), error: null }
      } catch (error) {
        return { location, declaration, execution: null, error }
      }
    } catch (error) {
      return { location: null, declaration: null, execution: null, error }
    }
  })()
  return {
    ...result,
    loading: query.isLoading,
    binding,
    setAccess: (access: AgentExecution['access']) => {
      if (!result.execution) {
        throw new Error('The project environment is unavailable')
      }
      useAgentExecutionStore.getState().setProjectExecution(projectId, { ...result.execution, access })
    },
    bindComputer: (cwd: string) => {
      if (result.location !== 'computer' || !cwd.trim()) {
        throw new Error('This project cannot use a computer folder')
      }
      useAgentExecutionStore.getState().setProjectExecution(projectId, {
        location: 'computer',
        cwd,
        access: binding?.location === 'computer' && binding.cwd === cwd ? binding.access : 'ask',
      })
    },
  }
}
