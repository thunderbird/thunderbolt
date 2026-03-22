import { describe, expect, test } from 'bun:test'
import type { SessionNotification, SessionUpdate } from '@agentclientprotocol/sdk'
import type { Mode, Model } from '@/types'
import { createInProcessStream } from './streams'
import { createBuiltInAgentHandler } from './built-in-agent'
import { createAcpClient } from './client'
import type { InferenceEvent, RunInference } from './types'

const testModes: Mode[] = [
  {
    id: 'mode-chat',
    name: 'chat',
    label: 'Chat',
    icon: 'message-square',
    systemPrompt: 'You are a chat assistant',
    isDefault: 1,
    order: 0,
    deletedAt: null,
    defaultHash: null,
    userId: null,
  },
  {
    id: 'mode-search',
    name: 'search',
    label: 'Search',
    icon: 'globe',
    systemPrompt: null,
    isDefault: 0,
    order: 1,
    deletedAt: null,
    defaultHash: null,
    userId: null,
  },
]

const testModels: Model[] = [
  {
    id: 'model-sonnet',
    name: 'Claude Sonnet',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250514',
    enabled: 1,
    toolUsage: 1,
    isConfidential: 0,
    startWithReasoning: 0,
    supportsParallelToolCalls: 1,
    vendor: null,
    apiKey: null,
    url: null,
    contextWindow: null,
    isSystem: null,
    isFolder: null,
    defaultHash: null,
    deletedAt: null,
    userId: null,
  },
]

const createMockInference = (events: InferenceEvent[]): RunInference => {
  return async function* () {
    for (const event of events) {
      yield event
    }
  }
}

/**
 * Creates a full test setup: in-process streams + built-in agent + ACP client.
 */
const createFullTestSetup = (options?: { events?: InferenceEvent[] }) => {
  const { clientStream, agentStream } = createInProcessStream()

  const events = options?.events ?? [
    { type: 'text-delta' as const, text: 'Test response' },
    { type: 'finish' as const, stopReason: 'end_turn' as const },
  ]

  const agentHandler = createBuiltInAgentHandler({
    modes: testModes,
    models: testModels,
    runInference: createMockInference(events),
  })

  const receivedUpdates: SessionUpdate[] = []

  const { connection, agentConnection } = createAcpClient({
    stream: clientStream,
    agentStream,
    agentHandler,
    onSessionUpdate: (update) => {
      receivedUpdates.push(update)
    },
  })

  return { connection, agentConnection, receivedUpdates }
}

describe('createAcpClient', () => {
  test('connects and initializes with the agent', async () => {
    const { connection } = createFullTestSetup()

    const initResponse = await connection.initialize({ protocolVersion: 1 })

    expect(initResponse.protocolVersion).toBe(1)
    expect(initResponse.agentInfo).toMatchObject({
      name: 'thunderbolt-built-in',
    })
  })

  test('creates a session with modes and config options', async () => {
    const { connection } = createFullTestSetup()

    await connection.initialize({ protocolVersion: 1 })
    const session = await connection.newSession({ cwd: '/test', mcpServers: [] })

    expect(session.sessionId).toBeTruthy()
    expect(session.modes).toBeTruthy()
    expect(session.modes!.availableModes).toHaveLength(2)
    expect(session.configOptions).toBeTruthy()
  })

  test('sends prompt and receives streaming updates', async () => {
    const events: InferenceEvent[] = [
      { type: 'text-delta', text: 'Hello' },
      { type: 'text-delta', text: ' there' },
      { type: 'finish', stopReason: 'end_turn' },
    ]

    const { connection, receivedUpdates } = createFullTestSetup({ events })

    await connection.initialize({ protocolVersion: 1 })
    const session = await connection.newSession({ cwd: '/test', mcpServers: [] })

    const response = await connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Say hello' }],
    })

    expect(response.stopReason).toBe('end_turn')

    const textChunks = receivedUpdates
      .filter((u) => u.sessionUpdate === 'agent_message_chunk')
      .map((u) => {
        const chunk = u as { content: { type: 'text'; text: string } }
        return chunk.content.text
      })

    expect(textChunks).toEqual(['Hello', ' there'])
  })

  test('full connection flow: init → session → prompt → response', async () => {
    const events: InferenceEvent[] = [
      { type: 'reasoning', text: 'Thinking...' },
      { type: 'text-delta', text: 'The answer is 42.' },
      {
        type: 'tool-call',
        toolCallId: 'tc-1',
        toolName: 'calculator',
        args: { expression: '6 * 7' },
      },
      {
        type: 'tool-result',
        toolCallId: 'tc-1',
        result: '42',
      },
      { type: 'finish', stopReason: 'end_turn' },
    ]

    const { connection, receivedUpdates } = createFullTestSetup({ events })

    // Step 1: Initialize
    const initResponse = await connection.initialize({ protocolVersion: 1 })
    expect(initResponse.protocolVersion).toBe(1)

    // Step 2: Create session
    const session = await connection.newSession({ cwd: '/test', mcpServers: [] })
    expect(session.sessionId).toBeTruthy()

    // Step 3: Send prompt
    const promptResponse = await connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'What is the meaning of life?' }],
    })

    // Step 4: Verify response
    expect(promptResponse.stopReason).toBe('end_turn')

    // Verify all update types were received
    const updateTypes = receivedUpdates.map((u) => u.sessionUpdate)
    expect(updateTypes).toContain('agent_thought_chunk')
    expect(updateTypes).toContain('agent_message_chunk')
    expect(updateTypes).toContain('tool_call')
    expect(updateTypes).toContain('tool_call_update')
  })

  test('handles mode changes via setSessionMode', async () => {
    const { connection, receivedUpdates } = createFullTestSetup()

    await connection.initialize({ protocolVersion: 1 })
    const session = await connection.newSession({ cwd: '/test', mcpServers: [] })

    expect(session.modes!.currentModeId).toBe('mode-chat')

    await connection.setSessionMode({
      sessionId: session.sessionId,
      modeId: 'mode-search',
    })

    const modeUpdates = receivedUpdates.filter((u) => u.sessionUpdate === 'current_mode_update')
    expect(modeUpdates).toHaveLength(1)
    expect(modeUpdates[0]).toMatchObject({
      sessionUpdate: 'current_mode_update',
      currentModeId: 'mode-search',
    })
  })

  test('handles model changes via setSessionConfigOption', async () => {
    const { connection } = createFullTestSetup()

    await connection.initialize({ protocolVersion: 1 })
    const session = await connection.newSession({ cwd: '/test', mcpServers: [] })

    const response = await connection.setSessionConfigOption({
      configId: 'model',
      type: 'boolean',
      value: 'model-sonnet',
      sessionId: session.sessionId,
    } as Parameters<typeof connection.setSessionConfigOption>[0])

    expect(response.configOptions).toBeTruthy()
  })
})
