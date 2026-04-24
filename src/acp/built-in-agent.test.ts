import { describe, expect, test, mock } from 'bun:test'
import { AgentSideConnection, type SessionNotification } from '@agentclientprotocol/sdk'
import { createBuiltInAgent } from './built-in-agent'
import { createAcpClient } from './client'
import { createInProcessStreams } from './streams'
import type { Mode, Model } from '@/types'

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
    systemPrompt: 'You are a search assistant',
    isDefault: 0,
    order: 1,
    deletedAt: null,
    defaultHash: null,
    userId: null,
  },
]

const testModels: Model[] = [
  {
    id: 'model-1',
    name: 'Test Model',
    model: 'test-model-v1',
    provider: 'thunderbolt',
    enabled: 1,
    toolUsage: 1,
    isConfidential: 0,
    startWithReasoning: 0,
    supportsParallelToolCalls: 1,
    apiKey: null,
    contextWindow: 128000,
    defaultHash: null,
    deletedAt: null,
    description: 'A test model',
    isSystem: 1,
    url: null,
    userId: null,
    vendor: null,
  },
]

const setupAgent = (overrides?: { runPrompt?: Parameters<typeof createBuiltInAgent>[0]['runPrompt'] }) => {
  const onModeChange = mock(() => {})
  const onModelChange = mock(() => {})

  const runPrompt =
    overrides?.runPrompt ??
    (async ({ conn, sessionId }) => {
      // Simulate streaming a response
      await conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello from the built-in agent!' },
        },
      })

      return {
        stopReason: 'end_turn' as const,
      }
    })

  const agentHandler = createBuiltInAgent({
    getModes: () => testModes,
    getModels: () => testModels,
    getSelectedModeId: () => 'mode-chat',
    getSelectedModelId: () => 'model-1',
    onModeChange,
    onModelChange,
    runPrompt,
  })

  const { clientStream, agentStream } = createInProcessStreams()

  const updates: SessionNotification['update'][] = []

  const client = createAcpClient({
    stream: clientStream,
    onSessionUpdate: (update) => {
      updates.push(update)
    },
  })

  // Start agent side
  new AgentSideConnection(agentHandler, agentStream)

  return { client, updates, onModeChange, onModelChange }
}

describe('built-in agent via ACP', () => {
  test('initializes with agent info', async () => {
    const { client } = setupAgent()

    const result = await client.initialize()

    expect(result.agentInfo?.name).toBe('Thunderbolt')
    expect(result.protocolVersion).toBe(1)
  })

  test('creates session with modes and model config', async () => {
    const { client } = setupAgent()
    await client.initialize()

    const session = await client.createSession()

    expect(session.sessionId).toBeDefined()
    expect(session.availableModes).toHaveLength(2)
    expect(session.availableModes[0].name).toBe('Chat')
    expect(session.availableModes[1].name).toBe('Search')
    expect(session.currentModeId).toBe('mode-chat')

    // Model config option
    expect(session.configOptions).toHaveLength(1)
    const modelConfig = session.configOptions[0]
    expect(modelConfig.category).toBe('model')
    expect(modelConfig.id).toBe('model')
  })

  test('streams agent message chunks during prompt', async () => {
    const { client, updates } = setupAgent()
    await client.initialize()
    await client.createSession()

    const result = await client.prompt('Hello!')

    expect(result.stopReason).toBe('end_turn')
    expect(updates).toHaveLength(1)
    expect(updates[0].sessionUpdate).toBe('agent_message_chunk')
    if (updates[0].sessionUpdate === 'agent_message_chunk') {
      expect(updates[0].content).toEqual({
        type: 'text',
        text: 'Hello from the built-in agent!',
      })
    }
  })

  test('streams tool calls during prompt', async () => {
    const { client, updates } = setupAgent({
      runPrompt: async ({ conn, sessionId }) => {
        // Report a tool call
        await conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-1',
            title: 'Searching the web',
            kind: 'search',
            status: 'in_progress',
          },
        })

        // Update tool call with result
        await conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc-1',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'Found 3 results' } }],
          },
        })

        // Agent response
        await conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Here are the results.' },
          },
        })

        return { stopReason: 'end_turn' as const }
      },
    })

    await client.initialize()
    await client.createSession()
    const result = await client.prompt('Search for cats')

    expect(result.stopReason).toBe('end_turn')
    expect(updates).toHaveLength(3)
    expect(updates[0].sessionUpdate).toBe('tool_call')
    expect(updates[1].sessionUpdate).toBe('tool_call_update')
    expect(updates[2].sessionUpdate).toBe('agent_message_chunk')
  })

  test('sets session mode', async () => {
    const { client, onModeChange } = setupAgent()
    await client.initialize()
    await client.createSession()

    await client.setMode('mode-search')

    expect(onModeChange).toHaveBeenCalledWith('mode-search')
  })

  test('sets model via config option', async () => {
    const { client, onModelChange } = setupAgent()
    await client.initialize()
    await client.createSession()

    await client.setConfigOption('model', 'model-1')

    expect(onModelChange).toHaveBeenCalledWith('model-1')
  })

  test('cancels in-progress prompt', async () => {
    let wasAborted = false
    let promptStarted: () => void
    const promptStartedPromise = new Promise<void>((r) => {
      promptStarted = r
    })

    const { client } = setupAgent({
      runPrompt: async ({ abortSignal }) => {
        promptStarted!()
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener('abort', () => {
            wasAborted = true
            resolve()
          })
          setTimeout(resolve, 4000)
        })

        return { stopReason: wasAborted ? ('cancelled' as const) : ('end_turn' as const) }
      },
    })

    await client.initialize()
    await client.createSession()

    const promptPromise = client.prompt('Long task...')

    // Wait until prompt handler has actually started
    await promptStartedPromise
    await client.cancel()

    const result = await promptPromise
    expect(wasAborted).toBe(true)
    expect(result.stopReason).toBe('cancelled')
  })

  test('streams thought chunks for reasoning', async () => {
    const { client, updates } = setupAgent({
      runPrompt: async ({ conn, sessionId }) => {
        await conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'Let me think about this...' },
          },
        })

        await conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'The answer is 42.' },
          },
        })

        return { stopReason: 'end_turn' as const }
      },
    })

    await client.initialize()
    await client.createSession()
    await client.prompt('What is the meaning of life?')

    expect(updates).toHaveLength(2)
    expect(updates[0].sessionUpdate).toBe('agent_thought_chunk')
    expect(updates[1].sessionUpdate).toBe('agent_message_chunk')
  })

  test('advertises loadSession capability', async () => {
    const { client } = setupAgent()
    const result = await client.initialize()
    expect(result.agentCapabilities?.loadSession).toBe(true)
  })

  test('loadSession restores session with modes and config', async () => {
    const { client } = setupAgent()
    await client.initialize()
    const session = await client.createSession()

    // Load the same session by ID
    const restored = await client.loadSession(session.sessionId)

    expect(restored.availableModes).toHaveLength(2)
    expect(restored.configOptions).toHaveLength(1)
  })

  test('loadSession rejects unknown session ID', async () => {
    const { client } = setupAgent()
    await client.initialize()

    await expect(client.loadSession('nonexistent-session')).rejects.toThrow()
  })
})
