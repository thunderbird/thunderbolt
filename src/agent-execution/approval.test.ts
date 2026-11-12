/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { tool } from 'ai'
import { z } from 'zod'
import { createToolAuthorizer, withToolApproval } from './approval'
import { useAgentExecutionStore, type AgentExecution } from './store'

beforeEach(() => useAgentExecutionStore.setState({ byThread: {}, byProject: {} }))
afterEach(() => useAgentExecutionStore.setState({ byThread: {}, byProject: {} }))

describe('built-in tool approval', () => {
  it('allows local app inspection while gating mutations, unknown actions, and external lookalikes', async () => {
    const requestPermission = mock(
      async (): Promise<RequestPermissionResponse> => ({ outcome: { outcome: 'selected', optionId: 'deny' } }),
    )
    const authorize = createToolAuthorizer(
      { location: 'computer', cwd: '/workspace', access: 'ask' },
      { threadId: 'chat', requestPermission },
    )
    for (const action of ['list', 'status']) {
      await authorize({ name: 'local_app', source: 'built-in' }, { action, appId: 'existing' }, action)
    }
    expect(requestPermission).not.toHaveBeenCalled()
    for (const action of ['create', 'attach', 'update', 'start', 'restart', 'stop', 'unknown']) {
      await expect(authorize({ name: 'local_app', source: 'built-in' }, { action }, action)).rejects.toThrow('denied')
    }
    for (const action of ['list', 'status']) {
      await expect(authorize({ name: 'local_app', source: 'external' }, { action }, action)).rejects.toThrow('denied')
    }
    expect(requestPermission).toHaveBeenCalledTimes(9)
    await expect(
      authorize({ name: 'local_app', source: 'built-in' }, { action: 'list' }, 'cancelled', AbortSignal.abort()),
    ).rejects.toThrow()
  })

  it('requires approval for an external tool even when its name matches a trusted read', async () => {
    const execute = mock(async () => 'side effect')
    const requestPermission = mock(
      async (): Promise<RequestPermissionResponse> => ({
        outcome: { outcome: 'selected', optionId: 'deny' },
      }),
    )
    const authorize = createToolAuthorizer(
      { location: 'sandbox', access: 'ask' },
      { threadId: 'chat', requestPermission },
    )
    const gated = withToolApproval({ google_get_email: tool({ inputSchema: z.object({}), execute }) }, authorize, {
      google_get_email: { name: 'google', toolName: 'get_email' },
    })
    await expect(gated.google_get_email.execute!({}, { toolCallId: 'spoofed-read', messages: [] })).rejects.toThrow(
      'denied',
    )
    expect(execute).not.toHaveBeenCalled()
    expect(requestPermission).toHaveBeenCalledTimes(1)
  })

  it('asks before changing a local app launch recipe and does not execute denied updates', async () => {
    const execute = mock(async () => 'restarted')
    const requestPermission = mock(
      async (): Promise<RequestPermissionResponse> => ({ outcome: { outcome: 'selected', optionId: 'deny' } }),
    )
    const authorize = createToolAuthorizer(
      { location: 'computer', cwd: '/workspace', access: 'ask' },
      { threadId: 'chat', requestPermission },
    )
    const tools = withToolApproval(
      { local_app: tool({ inputSchema: z.object({ action: z.literal('update'), appId: z.string() }), execute }) },
      authorize,
      undefined,
    )
    await expect(
      tools.local_app.execute!({ action: 'update', appId: 'existing' }, { toolCallId: 'update-app', messages: [] }),
    ).rejects.toThrow('denied')
    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
  })

  it('continues the approval queue after a denied action', async () => {
    const replies = ['deny', 'allow']
    const authorize = createToolAuthorizer(
      { location: 'sandbox', access: 'ask' },
      {
        threadId: 'chat',
        requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: replies.shift()! } }),
      },
    )
    const denied = authorize({ name: 'write', source: 'built-in' }, {}, 'first')
    const allowed = authorize({ name: 'write', source: 'built-in' }, {}, 'second')
    expect((await Promise.allSettled([denied, allowed])).map(({ status }) => status)).toEqual(['rejected', 'fulfilled'])
  })
  it('allows audited reads without prompting and asks before writes, shell and unknown tools', async () => {
    const requestPermission = mock(
      async (_request: RequestPermissionRequest): Promise<RequestPermissionResponse> => ({
        outcome: { outcome: 'selected', optionId: 'allow' },
      }),
    )
    const authorize = createToolAuthorizer(
      { location: 'computer', access: 'ask', cwd: '/work' },
      { threadId: 'chat', requestPermission },
    )
    for (const name of ['read', 'search', 'google_get_email', 'skill']) {
      await authorize({ name, source: 'built-in' }, {}, name)
    }
    expect(requestPermission).not.toHaveBeenCalled()
    for (const name of ['write', 'edit', 'bash', 'mcp_send_message']) {
      await authorize({ name, source: 'built-in' }, { path: 'a' }, name)
    }
    expect(requestPermission).toHaveBeenCalledTimes(4)
    expect(requestPermission.mock.calls[0][0]).toMatchObject({
      sessionId: 'chat',
      toolCall: { rawInput: { workingDirectory: '/work', location: 'computer' } },
    })
  })

  it('does not execute a denied action in the legacy tool pipeline', async () => {
    const execute = mock(async () => 'changed')
    const authorize = createToolAuthorizer(
      { location: 'sandbox', access: 'ask' },
      {
        threadId: 'chat',
        requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'deny' } }),
      },
    )
    const gated = withToolApproval({ send: tool({ inputSchema: z.object({}), execute }) }, authorize, undefined)
    await expect(gated.send.execute!({}, { toolCallId: 'send-1', messages: [] })).rejects.toThrow('denied')
    expect(execute).not.toHaveBeenCalled()
  })

  it('full access executes without prompting, but still honors cancellation', async () => {
    const requestPermission = mock(
      async (): Promise<RequestPermissionResponse> => ({ outcome: { outcome: 'cancelled' } }),
    )
    const authorize = createToolAuthorizer(
      { location: 'computer', access: 'full', cwd: '/workspace' },
      { threadId: 'chat', requestPermission },
    )
    await authorize({ name: 'bash', source: 'built-in' }, {}, 'one')
    expect(requestPermission).not.toHaveBeenCalled()
    await expect(authorize({ name: 'bash', source: 'built-in' }, {}, 'two', AbortSignal.abort())).rejects.toThrow()
  })

  it('serializes approval requests and checks for cancellation after approval', async () => {
    const first = Promise.withResolvers<RequestPermissionResponse>()
    const requestPermission = mock(() => first.promise)
    const authorize = createToolAuthorizer(
      { location: 'sandbox', access: 'ask' },
      { threadId: 'chat', requestPermission },
    )
    const controller = new AbortController()
    const a = authorize({ name: 'write', source: 'built-in' }, {}, 'a', controller.signal)
    const b = authorize({ name: 'edit', source: 'built-in' }, {}, 'b', controller.signal)
    const settled = Promise.allSettled([a, b])
    await Promise.resolve()
    expect(requestPermission).toHaveBeenCalledTimes(1)
    controller.abort()
    first.resolve({ outcome: { outcome: 'selected', optionId: 'allow' } })
    expect((await settled).map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(requestPermission).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the approval bridge is absent', async () => {
    const authorize = createToolAuthorizer({ location: 'sandbox', access: 'ask' }, { threadId: 'chat' })
    await expect(authorize({ name: 'write', source: 'built-in' }, {}, 'id')).rejects.toThrow('approval is unavailable')
  })

  it.each(['project', 'thread'] as const)(
    'uses a changed %s grant for tools in an already prepared turn',
    async (scope) => {
      const execution: AgentExecution = { location: 'ssh', environmentId: 'remote', cwd: '/workspace', access: 'ask' }
      const setGrant = (next: AgentExecution) => {
        const store = useAgentExecutionStore.getState()
        if (scope === 'project') {
          store.setProjectExecution('project', next)
        } else {
          store.setExecution('chat', next)
        }
      }
      setGrant(execution)
      const requestPermission = mock(
        async (): Promise<RequestPermissionResponse> => ({ outcome: { outcome: 'selected', optionId: 'allow' } }),
      )
      const authorize = createToolAuthorizer(execution, {
        threadId: 'chat',
        projectId: scope === 'project' ? 'project' : undefined,
        requestPermission,
      })
      setGrant({ ...execution, access: 'full' })
      await authorize({ name: 'bash', source: 'built-in' }, {}, 'first')
      await authorize({ name: 'write', source: 'built-in' }, {}, 'second')
      expect(requestPermission).not.toHaveBeenCalled()

      setGrant({ ...execution, access: 'ask' })
      await authorize({ name: 'bash', source: 'built-in' }, {}, 'revoked')
      expect(requestPermission).toHaveBeenCalledTimes(1)
    },
  )

  it('checks the current project grant again before displaying the next queued approval', async () => {
    const execution: AgentExecution = { location: 'ssh', environmentId: 'remote', cwd: '/workspace', access: 'ask' }
    useAgentExecutionStore.getState().setProjectExecution('project', execution)
    const first = Promise.withResolvers<RequestPermissionResponse>()
    const requestPermission = mock(() => first.promise)
    const authorize = createToolAuthorizer(execution, { threadId: 'chat', projectId: 'project', requestPermission })
    const a = authorize({ name: 'write', source: 'built-in' }, {}, 'a')
    const b = authorize({ name: 'edit', source: 'built-in' }, {}, 'b')
    await Promise.resolve()
    expect(requestPermission).toHaveBeenCalledTimes(1)
    useAgentExecutionStore.getState().setProjectExecution('project', { ...execution, access: 'full' })
    first.resolve({ outcome: { outcome: 'selected', optionId: 'allow' } })
    await Promise.all([a, b])
    expect(requestPermission).toHaveBeenCalledTimes(1)
  })

  it.each([
    { location: 'ssh', environmentId: 'another-remote', cwd: '/workspace', access: 'full' },
    { location: 'ssh', environmentId: 'remote', cwd: '/another-folder', access: 'full' },
    { location: 'computer', cwd: '/workspace', access: 'full' },
    null,
  ] satisfies Array<AgentExecution | null>)(
    'does not retain a full grant after removal or target changes: %j',
    async (next) => {
      const execution: AgentExecution = { location: 'ssh', environmentId: 'remote', cwd: '/workspace', access: 'full' }
      useAgentExecutionStore.getState().setProjectExecution('project', execution)
      const requestPermission = mock(
        async (): Promise<RequestPermissionResponse> => ({ outcome: { outcome: 'selected', optionId: 'deny' } }),
      )
      const authorize = createToolAuthorizer(execution, { threadId: 'chat', projectId: 'project', requestPermission })
      useAgentExecutionStore.getState().setProjectExecution('project', next)
      await expect(authorize({ name: 'bash', source: 'built-in' }, {}, 'old-target')).rejects.toThrow('denied')
      expect(requestPermission).toHaveBeenCalledTimes(1)
    },
  )

  it('does not use another project or per-chat grant to authorize project tools', async () => {
    const execution: AgentExecution = { location: 'ssh', environmentId: 'remote', cwd: '/workspace', access: 'ask' }
    useAgentExecutionStore.getState().setProjectExecution('project', execution)
    useAgentExecutionStore.getState().setProjectExecution('other-project', { ...execution, access: 'full' })
    useAgentExecutionStore.getState().setExecution('chat', { ...execution, access: 'full' })
    const requestPermission = mock(
      async (): Promise<RequestPermissionResponse> => ({ outcome: { outcome: 'selected', optionId: 'deny' } }),
    )
    const authorize = createToolAuthorizer(execution, { threadId: 'chat', projectId: 'project', requestPermission })
    await expect(authorize({ name: 'bash', source: 'built-in' }, {}, 'same-host')).rejects.toThrow('denied')
    expect(requestPermission).toHaveBeenCalledTimes(1)
  })
})
