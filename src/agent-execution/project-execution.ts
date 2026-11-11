/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { settingsTable } from '@/db/tables'
import { isTauriDesktop } from '@/lib/platform'
import { defaultAgentExecution, useAgentExecutionStore, type AgentExecution } from './store'
import { getSshEnvironment } from './ssh-environments'

export type ProjectExecutionLocation = AgentExecution['location']
const projectExecutionSchema = z.discriminatedUnion('location', [
  z.object({ version: z.literal(1), location: z.enum(['sandbox', 'computer', 'cloud']) }),
  z.object({ version: z.literal(1), location: z.literal('ssh'), environmentId: z.string().uuid() }),
])
export type ProjectExecutionDeclaration =
  | { location: 'sandbox' | 'computer' | 'cloud' }
  | { location: 'ssh'; environmentId: string }

/** Sync only the immutable environment identity, never remote addresses, credentials or device grants. */
export const projectExecutionDeclaration = (execution: AgentExecution): ProjectExecutionDeclaration =>
  execution.location === 'ssh'
    ? { location: 'ssh', environmentId: execution.environmentId }
    : { location: execution.location }

/** Machine paths and access grants deliberately stay outside this encrypted, synced preference. */
export const projectExecutionKey = (projectId: string): string => `project-execution:${projectId}`

/** Query one immutable environment declaration independently of its local folder binding. */
export const getProjectExecutionQuery = (db: AnyDrizzleDatabase, projectId: string) =>
  db
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(eq(settingsTable.key, projectExecutionKey(projectId)))

/** Projects created before environment selection have a fixed local sandbox. */
export const parseProjectExecution = (value: string | null | undefined): ProjectExecutionDeclaration => {
  if (value === undefined || value === null) {
    return { location: 'sandbox' }
  }
  const parsed = projectExecutionSchema.safeParse(JSON.parse(value))
  if (!parsed.success) {
    throw new Error('The project environment is invalid. Restore its saved configuration before running an agent.')
  }
  return parsed.data.location === 'ssh'
    ? { location: 'ssh', environmentId: parsed.data.environmentId }
    : { location: parsed.data.location }
}

/** Read the location without discarding the SSH identity from the stored declaration. */
export const parseProjectExecutionLocation = (value: string | null | undefined): ProjectExecutionLocation =>
  parseProjectExecution(value).location

export class ProjectExecutionUnavailableError extends Error {
  constructor(public readonly reason: 'desktop-required' | 'folder-required' | 'ssh-unavailable') {
    super(
      reason === 'desktop-required'
        ? 'This project runs on a computer. Open it in the desktop app to run its agent.'
        : reason === 'ssh-unavailable'
          ? 'This project uses an SSH environment that is unavailable on this computer. Restore that environment before running the agent.'
          : 'This project needs a working folder on this computer. Choose its folder before running the agent.',
    )
    this.name = 'ProjectExecutionUnavailableError'
  }
}

/** Resolve the synced choice without silently changing a missing computer environment to a sandbox. */
export const resolveProjectExecution = (
  declaration: ProjectExecutionDeclaration,
  binding: AgentExecution | undefined,
  desktop = isTauriDesktop(),
): AgentExecution => {
  const access = binding?.access ?? defaultAgentExecution.access
  const { location } = declaration
  if (location === 'ssh') {
    if (!desktop) {
      throw new ProjectExecutionUnavailableError('desktop-required')
    }
    const environment = (() => {
      try {
        return getSshEnvironment(declaration.environmentId)
      } catch {
        throw new ProjectExecutionUnavailableError('ssh-unavailable')
      }
    })()
    const matchingBinding =
      binding?.location === 'ssh' && binding.environmentId === environment.id ? binding : undefined
    return {
      location,
      environmentId: environment.id,
      cwd: matchingBinding?.cwd ?? environment.cwd,
      access: matchingBinding?.access ?? defaultAgentExecution.access,
    }
  }
  if (location !== 'computer') {
    return { location, access }
  }
  if (!desktop) {
    throw new ProjectExecutionUnavailableError('desktop-required')
  }
  if (binding?.location !== 'computer' || !binding.cwd.trim()) {
    throw new ProjectExecutionUnavailableError('folder-required')
  }
  return { location, access, cwd: binding.cwd }
}

/** Read the project's immutable environment and this device's folder/permission binding at send time. */
export const getProjectExecution = async (db: AnyDrizzleDatabase, projectId: string): Promise<AgentExecution> => {
  const rows = await getProjectExecutionQuery(db, projectId)
  return resolveProjectExecution(
    parseProjectExecution(rows[0]?.value),
    useAgentExecutionStore.getState().byProject[projectId],
  )
}

/** Validate creation before either local grants or synced project data can be written. */
export const validateProjectExecution = (execution: AgentExecution): AgentExecution => {
  if (
    !['ask', 'full'].includes(execution.access) ||
    !['sandbox', 'computer', 'cloud', 'ssh'].includes(execution.location)
  ) {
    throw new Error('Invalid project environment')
  }
  if (execution.location === 'ssh') {
    getSshEnvironment(execution.environmentId)
    if (!execution.cwd.trim()) {
      throw new Error('Choose a working folder for this project')
    }
    return { location: 'ssh', environmentId: execution.environmentId, cwd: execution.cwd, access: execution.access }
  }
  if (execution.location === 'computer') {
    if (!execution.cwd.trim()) {
      throw new Error('Choose a working folder for this project')
    }
    return { location: 'computer', access: execution.access, cwd: execution.cwd }
  }
  return { location: execution.location, access: execution.access }
}
