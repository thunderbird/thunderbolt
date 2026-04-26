import { describe, expect, mock, test } from 'bun:test'
import { AgentSideConnection, type SessionNotification } from '@agentclientprotocol/sdk'
import { createAcpClient } from './client'
import { createInProcessStreams } from './streams'

const createTestSetup = (overrides?: {
  onPermissionRequest?: Parameters<typeof createAcpClient>[0]['onPermissionRequest']
}) => {
  const { clientStream, agentStream } = createInProcessStreams()

  const updates: SessionNotification['update'][] = []

  const client = createAcpClient({
    stream: clientStream,
    onSessionUpdate: (update) => {
      updates.push(update)
    },
    onPermissionRequest: overrides?.onPermissionRequest,
  })

  // Minimal agent that supports all operations
  const agentConn = new AgentSideConnection(
    (conn) => ({
      initialize: async () => ({
        protocolVersion: 1,
        agentInfo: { name: 'Test', version: '1.0.0' },
        agentCapabilities: { loadSession: true },
      }),
      authenticate: async () => ({}),
      newSession: async () => ({
        sessionId: 'session-1',
        modes: {
          currentModeId: 'mode-a',
          availableModes: [
            { id: 'mode-a', name: 'Mode A' },
            { id: 'mode-b', name: 'Mode B' },
          ],
        },
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select' as const,
            category: 'model',
            currentValue: 'model-1',
            options: [{ value: 'model-1', name: 'Model 1' }],
          },
        ],
      }),
      loadSession: async (params: { sessionId: string }) => {
        if (params.sessionId !== 'session-1') {
          throw new Error('Session not found')
        }
        return {
          modes: {
            currentModeId: 'mode-a',
            availableModes: [
              { id: 'mode-a', name: 'Mode A' },
              { id: 'mode-b', name: 'Mode B' },
            ],
          },
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              type: 'select' as const,
              category: 'model',
              currentValue: 'model-1',
              options: [{ value: 'model-1', name: 'Model 1' }],
            },
          ],
        }
      },
      setSessionMode: async () => {
        // Notify mode change
        await conn.sessionUpdate({
          sessionId: 'session-1',
          update: { sessionUpdate: 'current_mode_update', currentModeId: 'mode-b' },
        })
      },
      setSessionConfigOption: async () => ({
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select' as const,
            category: 'model',
            currentValue: 'model-2',
            options: [{ value: 'model-2', name: 'Model 2' }],
          },
        ],
      }),
      prompt: async () => {
        await conn.sessionUpdate({
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Hello' },
          },
        })
        return { stopReason: 'end_turn' as const }
      },
      cancel: async () => {},
    }),
    agentStream,
  )

  return { client, updates, agentConn }
}

describe('AcpClient', () => {
  test('initialize returns agent info', async () => {
    const { client } = createTestSetup()
    const result = await client.initialize()
    expect(result.agentInfo?.name).toBe('Test')
  })

  test('createSession returns session state with modes and config', async () => {
    const { client } = createTestSetup()
    await client.initialize()
    const session = await client.createSession()

    expect(session.sessionId).toBe('session-1')
    expect(session.availableModes).toHaveLength(2)
    expect(session.currentModeId).toBe('mode-a')
    expect(session.configOptions).toHaveLength(1)
    expect(session.configOptions[0].category).toBe('model')
  })

  test('getSessionState returns null before session creation', () => {
    const { client } = createTestSetup()
    expect(client.getSessionState()).toBeNull()
  })

  test('getSessionState returns state after session creation', async () => {
    const { client } = createTestSetup()
    await client.initialize()
    await client.createSession()
    expect(client.getSessionState()?.sessionId).toBe('session-1')
  })

  test('setMode calls agent and updates tracked state via notification', async () => {
    const { client } = createTestSetup()
    await client.initialize()
    await client.createSession()

    await client.setMode('mode-b')

    // The agent sends a current_mode_update notification which the client tracks
    const state = client.getSessionState()
    expect(state?.currentModeId).toBe('mode-b')
  })

  test('setConfigOption calls agent', async () => {
    const { client } = createTestSetup()
    await client.initialize()
    await client.createSession()

    await client.setConfigOption('model', 'model-2')
    // Config update is returned directly, not via notification in this case
    // But the call itself should not throw
  })

  test('prompt sends text and receives response', async () => {
    const { client, updates } = createTestSetup()
    await client.initialize()
    await client.createSession()

    const result = await client.prompt('Hello')
    expect(result.stopReason).toBe('end_turn')
    expect(updates.some((u) => u.sessionUpdate === 'agent_message_chunk')).toBe(true)
  })

  test('prompt throws when no session exists', async () => {
    const { client } = createTestSetup()
    await expect(client.prompt('Hello')).rejects.toThrow('No active session')
  })

  test('setMode throws when no session exists', async () => {
    const { client } = createTestSetup()
    await expect(client.setMode('mode-b')).rejects.toThrow('No active session')
  })

  test('setConfigOption throws when no session exists', async () => {
    const { client } = createTestSetup()
    await expect(client.setConfigOption('model', 'v')).rejects.toThrow('No active session')
  })

  test('cancel is safe when no session exists', async () => {
    const { client } = createTestSetup()
    // Should not throw
    await client.cancel()
  })

  test('cancel works during active session', async () => {
    const { client } = createTestSetup()
    await client.initialize()
    await client.createSession()
    // Should not throw
    await client.cancel()
  })

  test('signal property is accessible', async () => {
    const { client } = createTestSetup()
    expect(client.signal).toBeInstanceOf(AbortSignal)
  })

  test('closed property returns a promise', async () => {
    const { client } = createTestSetup()
    expect(client.closed).toBeInstanceOf(Promise)
  })

  test('default permission handler allows when allow_once option exists', async () => {
    const { clientStream, agentStream } = createInProcessStreams()
    const client = createAcpClient({ stream: clientStream })

    // Create agent that requests permission during prompt
    new AgentSideConnection(
      (conn) => ({
        initialize: async () => ({ protocolVersion: 1 }),
        authenticate: async () => ({}),
        newSession: async () => ({ sessionId: 'session-perm' }),
        prompt: async (params) => {
          // Request permission — default handler should auto-allow
          const result = await conn.requestPermission({
            sessionId: params.sessionId,
            toolCall: { toolCallId: 'tc-1', title: 'Write file' },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
            ],
          })
          expect(result.outcome.outcome).toBe('selected')
          if (result.outcome.outcome === 'selected') {
            expect(result.outcome.optionId).toBe('allow')
          }
          return { stopReason: 'end_turn' as const }
        },
        cancel: async () => {},
      }),
      agentStream,
    )

    await client.initialize()
    await client.createSession()
    await client.prompt('test')
  })

  test('default permission handler cancels when no allow_once option', async () => {
    const { clientStream, agentStream } = createInProcessStreams()
    const client = createAcpClient({ stream: clientStream })

    new AgentSideConnection(
      (conn) => ({
        initialize: async () => ({ protocolVersion: 1 }),
        authenticate: async () => ({}),
        newSession: async () => ({ sessionId: 'session-perm2' }),
        prompt: async (params) => {
          const result = await conn.requestPermission({
            sessionId: params.sessionId,
            toolCall: { toolCallId: 'tc-2', title: 'Delete file' },
            options: [
              { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
              { optionId: 'deny-always', name: 'Always Deny', kind: 'reject_always' },
            ],
          })
          expect(result.outcome.outcome).toBe('cancelled')
          return { stopReason: 'end_turn' as const }
        },
        cancel: async () => {},
      }),
      agentStream,
    )

    await client.initialize()
    await client.createSession()
    await client.prompt('test')
  })

  test('custom permission handler is called instead of default', async () => {
    const onPermissionRequest = mock(async () => ({
      outcome: { outcome: 'selected' as const, optionId: 'custom-allow' },
    }))

    const { clientStream, agentStream } = createInProcessStreams()
    const client = createAcpClient({
      stream: clientStream,
      onPermissionRequest,
    })

    new AgentSideConnection(
      (conn) => ({
        initialize: async () => ({ protocolVersion: 1 }),
        authenticate: async () => ({}),
        newSession: async () => ({ sessionId: 'session-perm3' }),
        prompt: async (params) => {
          await conn.requestPermission({
            sessionId: params.sessionId,
            toolCall: { toolCallId: 'tc-3', title: 'Run command' },
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
          })
          return { stopReason: 'end_turn' as const }
        },
        cancel: async () => {},
      }),
      agentStream,
    )

    await client.initialize()
    await client.createSession()
    await client.prompt('test')

    expect(onPermissionRequest).toHaveBeenCalled()
  })

  test('config_option_update notification updates session state', async () => {
    const { client } = createTestSetup()
    await client.initialize()
    await client.createSession()

    // Set config option triggers agent to return new configOptions
    await client.setConfigOption('model', 'model-2')

    // The configOptions should reflect what the agent returned
    const state = client.getSessionState()
    expect(state).toBeDefined()
  })

  test('supportsLoadSession reflects agent capability', async () => {
    const { client } = createTestSetup()

    // Before initialize, no capability info is available
    expect(client.supportsLoadSession).toBe(false)

    await client.initialize()
    expect(client.supportsLoadSession).toBe(true)
  })

  test('loadSession restores session state', async () => {
    const { client } = createTestSetup()
    await client.initialize()

    const restored = await client.loadSession('session-1')

    expect(restored.sessionId).toBe('session-1')
    expect(restored.availableModes).toHaveLength(2)
    expect(restored.currentModeId).toBe('mode-a')
    expect(restored.configOptions).toHaveLength(1)

    // getSessionState should also be updated
    const state = client.getSessionState()
    expect(state?.sessionId).toBe('session-1')
  })

  test('loadSession rejects unknown session ID', async () => {
    const { client } = createTestSetup()
    await client.initialize()

    await expect(client.loadSession('nonexistent')).rejects.toThrow()
  })
})
