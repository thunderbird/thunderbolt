/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { useAgentExecutionStore } from '@/agent-execution/store'
import { projectExecutionKey } from '@/agent-execution/project-execution'
import { useSshEnvironmentsStore } from '@/agent-execution/ssh-environments'
import { useChatStore } from '@/chats/chat-store'
import { getDb } from '@/db/database'
import { chatThreadsTable, projectsTable, settingsTable } from '@/db/tables'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { executionWorkspaceIdentity, getProjectMoveEnvironmentChange } from './project-move-environment'

const sshId = '00000000-0000-4000-8000-000000000001'
const otherSshId = '00000000-0000-4000-8000-000000000002'
const identity = (overrides: Partial<Parameters<typeof executionWorkspaceIdentity>[0]> = {}) =>
  executionWorkspaceIdentity({ scope: 'chat-1', declaration: { location: 'sandbox' }, ...overrides })

describe('executionWorkspaceIdentity', () => {
  it.each(['sandbox', 'cloud'] as const)('%s scopes own distinct files even within the same location', (location) => {
    expect(identity({ declaration: { location }, scope: 'project-a' })).not.toBe(
      identity({ declaration: { location }, scope: 'project-b' }),
    )
    expect(identity({ declaration: { location }, scope: 'project-a' })).not.toBe(
      identity({ declaration: { location } }),
    )
  })

  it('ignores project and access differences when the native working directory is shared', () => {
    expect(
      identity({
        declaration: { location: 'computer' },
        binding: { location: 'computer', cwd: '/work', access: 'ask' },
      }),
    ).toBe(
      identity({
        scope: 'project-a',
        declaration: { location: 'computer' },
        binding: { location: 'computer', cwd: '/work', access: 'full' },
      }),
    )
  })

  it('does not assume native paths with different spelling are equivalent', () => {
    expect(
      identity({
        declaration: { location: 'computer' },
        binding: { location: 'computer', cwd: '/Work', access: 'ask' },
      }),
    ).not.toBe(
      identity({
        declaration: { location: 'computer' },
        binding: { location: 'computer', cwd: '/work', access: 'ask' },
      }),
    )
  })

  it('does not equate unknown native folders in different scopes', () => {
    expect(identity({ scope: 'project-a', declaration: { location: 'computer' } })).not.toBe(
      identity({ scope: 'project-b', declaration: { location: 'computer' } }),
    )
  })

  it('uses a matching SSH binding before its profile default and ignores access grants', () => {
    expect(
      identity({
        declaration: { location: 'ssh', environmentId: sshId },
        binding: { location: 'ssh', environmentId: sshId, cwd: '/work', access: 'full' },
        sshCwd: '/home',
      }),
    ).toBe(identity({ scope: 'project-a', declaration: { location: 'ssh', environmentId: sshId }, sshCwd: '/work' }))
  })

  it('ignores stale SSH bindings from another environment', () => {
    expect(
      identity({
        declaration: { location: 'ssh', environmentId: sshId },
        binding: { location: 'ssh', environmentId: otherSshId, cwd: '/wrong', access: 'full' },
        sshCwd: '/work',
      }),
    ).toBe(identity({ declaration: { location: 'ssh', environmentId: sshId }, sshCwd: '/work' }))
  })

  it('distinguishes SSH IDs and folders, including unavailable environments', () => {
    const original = identity({ declaration: { location: 'ssh', environmentId: sshId }, sshCwd: '/work' })
    expect(original).not.toBe(
      identity({ declaration: { location: 'ssh', environmentId: otherSshId }, sshCwd: '/work' }),
    )
    expect(original).not.toBe(identity({ declaration: { location: 'ssh', environmentId: sshId }, sshCwd: '/other' }))
    expect(identity({ declaration: { location: 'ssh', environmentId: sshId } })).not.toBe(
      identity({ declaration: { location: 'ssh', environmentId: otherSshId } }),
    )
  })
})

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
beforeEach(async () => {
  await resetTestDatabase()
  useChatStore.setState({ sessions: new Map(), currentSessionId: null })
  useAgentExecutionStore.setState({ byThread: {}, byProject: {} })
  useSshEnvironmentsStore.setState({ environments: {}, connectionStatuses: {} })
  await getDb()
    .insert(projectsTable)
    .values([
      { id: 'p1', name: 'First' },
      { id: 'p2', name: 'Second' },
    ])
  await getDb().insert(chatThreadsTable).values({ id: 'chat-1', projectId: 'p1' })
})

describe('getProjectMoveEnvironmentChange', () => {
  it('uses persisted membership when the chat is closed and defaults legacy projects to scoped sandboxes', async () => {
    expect(await getProjectMoveEnvironmentChange(getDb(), { chatThreadId: 'chat-1', projectId: 'p2' })).not.toBeNull()
    expect(await getProjectMoveEnvironmentChange(getDb(), { chatThreadId: 'chat-1', projectId: 'p1' })).toBeNull()
  })

  it('restores the standalone SSH choice on removal without copying project grants or folders', async () => {
    const execution = { location: 'ssh' as const, environmentId: sshId, cwd: '/standalone', access: 'full' as const }
    useAgentExecutionStore.getState().setExecution('chat-1', execution)
    const change = await getProjectMoveEnvironmentChange(getDb(), { chatThreadId: 'chat-1', projectId: null })
    expect(JSON.parse(change!)).toEqual([
      identity({ scope: 'project-p1' }),
      identity({ declaration: execution, binding: execution }),
    ])
    expect(useAgentExecutionStore.getState().byThread['chat-1']).toEqual(execution)
    expect(useAgentExecutionStore.getState().byProject).toEqual({})
  })

  it('allows moves between projects sharing a native folder even on web', async () => {
    for (const projectId of ['p1', 'p2']) {
      await getDb()
        .insert(settingsTable)
        .values({ key: projectExecutionKey(projectId), value: JSON.stringify({ version: 1, location: 'computer' }) })
      useAgentExecutionStore.getState().setProjectExecution(projectId, {
        location: 'computer',
        cwd: '/work',
        access: projectId === 'p1' ? 'ask' : 'full',
      })
    }
    expect(await getProjectMoveEnvironmentChange(getDb(), { chatThreadId: 'chat-1', projectId: 'p2' })).toBeNull()
  })

  it('retains deleted or device-unavailable SSH identity without needing a connection', async () => {
    await getDb()
      .insert(settingsTable)
      .values({
        key: projectExecutionKey('p1'),
        value: JSON.stringify({ version: 1, location: 'ssh', environmentId: sshId }),
      })
    expect(await getProjectMoveEnvironmentChange(getDb(), { chatThreadId: 'chat-1', projectId: null })).not.toBeNull()
  })

  it('does not reinterpret invalid project declarations as sandbox', async () => {
    await getDb()
      .insert(settingsTable)
      .values({ key: projectExecutionKey('p1'), value: '{"version":1,"location":"unknown"}' })
    await expect(getProjectMoveEnvironmentChange(getDb(), { chatThreadId: 'chat-1', projectId: null })).rejects.toThrow(
      'environment is invalid',
    )
  })

  it('does not request confirmation for a nonexistent target', async () => {
    expect(await getProjectMoveEnvironmentChange(getDb(), { chatThreadId: 'chat-1', projectId: 'deleted' })).toBeNull()
  })
})
