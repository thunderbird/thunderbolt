/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  getProjectExecutionQuery,
  parseProjectExecution,
  type ProjectExecutionDeclaration,
} from '@/agent-execution/project-execution'
import { useSshEnvironmentsStore } from '@/agent-execution/ssh-environments'
import { getAgentExecution, useAgentExecutionStore, type AgentExecution } from '@/agent-execution/store'
import { useChatStore } from '@/chats/chat-store'
import { getChatThread } from '@/dal/chat-threads'
import { getProject } from '@/dal/projects'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import type { ChatDrop } from './chat-drop'

type WorkspaceIdentityInput = {
  scope: string
  declaration: ProjectExecutionDeclaration
  binding?: AgentExecution
  sshCwd?: string
}

/** Compare where files and running apps live, independently of availability or access grants. */
export const executionWorkspaceIdentity = ({ scope, declaration, binding, sshCwd }: WorkspaceIdentityInput): string => {
  if (declaration.location === 'ssh') {
    const cwd =
      binding?.location === 'ssh' && binding.environmentId === declaration.environmentId ? binding.cwd : sshCwd
    return JSON.stringify(['ssh', declaration.environmentId, cwd || null, cwd ? null : scope])
  }
  if (declaration.location === 'computer') {
    const cwd = binding?.location === 'computer' ? binding.cwd : undefined
    return JSON.stringify(['computer', cwd || null, cwd ? null : scope])
  }
  return JSON.stringify([declaration.location, scope])
}

/** Read declarations without requiring a connection: unavailable SSH projects can still be moved out of. */
const readWorkspaceIdentity = async (db: AnyDrizzleDatabase, chatThreadId: string, projectId: string | null) => {
  const declaration = projectId
    ? parseProjectExecution((await getProjectExecutionQuery(db, projectId))[0]?.value)
    : getAgentExecution(chatThreadId)
  const binding = projectId ? useAgentExecutionStore.getState().byProject[projectId] : getAgentExecution(chatThreadId)
  return executionWorkspaceIdentity({
    scope: projectId ? `project-${projectId}` : chatThreadId,
    declaration,
    binding,
    sshCwd:
      declaration.location === 'ssh'
        ? useSshEnvironmentsStore.getState().environments[declaration.environmentId]?.cwd
        : undefined,
  })
}

/** Snapshot both workspaces at the write boundary; a later change requires fresh consent. */
export const getProjectMoveEnvironmentChange = async (
  db: AnyDrizzleDatabase,
  { chatThreadId, projectId }: ChatDrop,
): Promise<string | null> => {
  const session = useChatStore.getState().sessions.get(chatThreadId)
  const sourceProjectId = session ? session.projectId : ((await getChatThread(db, chatThreadId))?.projectId ?? null)
  if (sourceProjectId === projectId || (projectId && !(await getProject(db, projectId)))) {
    return null
  }
  const [source, destination] = await Promise.all([
    readWorkspaceIdentity(db, chatThreadId, sourceProjectId),
    readWorkspaceIdentity(db, chatThreadId, projectId),
  ])
  return source === destination ? null : JSON.stringify([source, destination])
}
