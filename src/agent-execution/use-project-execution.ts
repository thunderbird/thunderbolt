/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useQuery } from '@powersync/tanstack-react-query'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useDatabase } from '@/contexts/database-context'
import { useAgentExecutionStore, type AgentExecution } from './store'
import {
  getProjectExecutionQuery,
  parseProjectExecutionLocation,
  resolveProjectExecution,
  type ProjectExecutionLocation,
} from './project-execution'

/** Subscribe to one immutable project choice and its independent device-local grant. */
export const useProjectExecution = (projectId: string) => {
  const db = useDatabase()
  const query = useQuery({
    queryKey: ['projectExecution', projectId],
    query: toCompilableQuery(getProjectExecutionQuery(db, projectId)),
  })
  const binding = useAgentExecutionStore((state) => state.byProject[projectId])
  const result = (() => {
    if (query.isLoading || query.error) {
      return { location: null, execution: null, error: query.error } as {
        location: ProjectExecutionLocation | null
        execution: AgentExecution | null
        error: unknown
      }
    }
    try {
      const location = parseProjectExecutionLocation(query.data?.[0]?.value)
      try {
        return { location, execution: resolveProjectExecution(location, binding), error: null }
      } catch (error) {
        return { location, execution: null, error }
      }
    } catch (error) {
      return { location: null, execution: null, error }
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
      useAgentExecutionStore
        .getState()
        .setProjectExecution(projectId, { location: 'computer', cwd, access: binding?.access ?? 'ask' })
    },
  }
}
