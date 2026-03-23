import { describe, expect, it, mock } from 'bun:test'
import { AgentSideConnection, ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import type { Client, Agent, SessionNotification } from '@agentclientprotocol/sdk'
import { createHaystackAcpAgent } from './acp-agent'
import { HaystackClient } from './client'
import type { HaystackPipelineConfig, DeepsetResultPayload } from './types'

const testPipelineConfig: HaystackPipelineConfig = {
  slug: 'test-pipeline',
  name: 'Test Pipeline',
  pipelineName: 'test-pipeline-v1',
  pipelineId: 'pipeline-123',
}

const testHaystackConfig = {
  apiKey: 'test-key',
  baseUrl: 'https://api.test.com',
  workspaceName: 'test',
  pipelineName: 'test-pipeline-v1',
  pipelineId: 'pipeline-123',
}

const createInProcessStreams = () => {
  const clientToAgent = new TransformStream<Uint8Array>()
  const agentToClient = new TransformStream<Uint8Array>()
  const clientStream = ndJsonStream(clientToAgent.writable, agentToClient.readable)
  const agentStream = ndJsonStream(agentToClient.writable, clientToAgent.readable)
  return { clientStream, agentStream }
}

const createSSEResponse = (events: string[]) => {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event))
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

describe('createHaystackAcpAgent', () => {
  it('should initialize with pipeline name', async () => {
    const mockFetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ search_session_id: 's1' }), { status: 201 })),
    )
    const client = new HaystackClient(testHaystackConfig, mockFetch as unknown as typeof fetch)

    const { clientStream, agentStream } = createInProcessStreams()

    const agentHandler = createHaystackAcpAgent({ client, pipelineConfig: testPipelineConfig })
    new AgentSideConnection(agentHandler, agentStream)

    const updates: SessionNotification[] = []
    const clientHandler: (agent: Agent) => Client = () => ({
      sessionUpdate: async (params: SessionNotification) => {
        updates.push(params)
      },
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
    })

    const conn = new ClientSideConnection(clientHandler, clientStream)

    const initResult = await conn.initialize({
      clientInfo: { name: 'Test', version: '1.0.0' },
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })

    expect(initResult.agentInfo!.name).toBe('Test Pipeline')
    expect(initResult.protocolVersion).toBe(1)
  })

  it('should create a session via Haystack API', async () => {
    const mockFetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ search_session_id: 'haystack-session-abc' }), { status: 201 })),
    )
    const client = new HaystackClient(testHaystackConfig, mockFetch as unknown as typeof fetch)

    const { clientStream, agentStream } = createInProcessStreams()

    const agentHandler = createHaystackAcpAgent({ client, pipelineConfig: testPipelineConfig })
    new AgentSideConnection(agentHandler, agentStream)

    const clientHandler: (agent: Agent) => Client = () => ({
      sessionUpdate: async () => {},
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
    })
    const conn = new ClientSideConnection(clientHandler, clientStream)

    await conn.initialize({
      clientInfo: { name: 'Test', version: '1.0.0' },
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })

    const session = await conn.newSession({ cwd: '.', mcpServers: [] })

    expect(session.sessionId).toBeTruthy()
    expect(typeof session.sessionId).toBe('string')
    // Should have called Haystack createSession
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('should stream text deltas and return references in _meta', async () => {
    const result: DeepsetResultPayload = {
      answers: [
        {
          answer: 'The answer [1]',
          files: [{ id: 'f1', name: 'doc.pdf' }],
          meta: { _references: [{ document_position: 1, document_id: 'd1' }] },
        },
      ],
      documents: [
        {
          id: 'd1',
          content: 'Document content',
          score: 0.95,
          file: { id: 'f1', name: 'doc.pdf' },
          meta: { page_number: 3 },
        },
      ],
    }

    let callCount = 0
    const mockFetch = mock(() => {
      callCount++
      if (callCount === 1) {
        // createSession
        return Promise.resolve(new Response(JSON.stringify({ search_session_id: 's1' }), { status: 201 }))
      }
      // chatStream
      return Promise.resolve(
        createSSEResponse([
          'data: {"type":"delta","delta":{"text":"The answer "}}\n\n',
          'data: {"type":"delta","delta":{"text":"[1]"}}\n\n',
          `data: {"type":"result","result":${JSON.stringify(result)}}\n\n`,
          'data: [DONE]\n\n',
        ]),
      )
    })

    const client = new HaystackClient(testHaystackConfig, mockFetch as unknown as typeof fetch)
    const { clientStream, agentStream } = createInProcessStreams()

    const agentHandler = createHaystackAcpAgent({ client, pipelineConfig: testPipelineConfig })
    new AgentSideConnection(agentHandler, agentStream)

    const updates: SessionNotification[] = []
    const clientHandler: (agent: Agent) => Client = () => ({
      sessionUpdate: async (params: SessionNotification) => {
        updates.push(params)
      },
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
    })
    const conn = new ClientSideConnection(clientHandler, clientStream)

    await conn.initialize({
      clientInfo: { name: 'Test', version: '1.0.0' },
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })

    const session = await conn.newSession({ cwd: '.', mcpServers: [] })
    const promptResult = await conn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'What is in this document?' }],
    })

    // Check prompt response
    expect(promptResult.stopReason).toBe('end_turn')
    expect(promptResult._meta).toBeTruthy()
    expect((promptResult._meta as Record<string, unknown>).haystackDocuments).toHaveLength(1)
    expect((promptResult._meta as Record<string, unknown>).haystackReferences).toHaveLength(1)

    // Check streaming updates
    const textUpdates = updates.filter((u) => u.update.sessionUpdate === 'agent_message_chunk')
    expect(textUpdates.length).toBeGreaterThanOrEqual(2) // at least 2 deltas + 1 reference _meta

    // Should have a text delta with "The answer "
    const textDeltas = textUpdates
      .filter((u) => {
        const update = u.update as { content?: { type: string; text: string } }
        return update.content?.type === 'text' && update.content.text.length > 0
      })
      .map((u) => {
        const update = u.update as { content: { text: string } }
        return update.content.text
      })
    expect(textDeltas.join('')).toBe('The answer [1]')

    // Should have a _meta update with references
    const metaUpdates = textUpdates.filter((u) => {
      const update = u.update as { _meta?: Record<string, unknown> }
      return update._meta?.haystackReferences
    })
    expect(metaUpdates).toHaveLength(1)
  })

  it('should handle empty response gracefully', async () => {
    let callCount = 0
    const mockFetch = mock(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve(new Response(JSON.stringify({ search_session_id: 's1' }), { status: 201 }))
      }
      return Promise.resolve(createSSEResponse(['data: [DONE]\n\n']))
    })

    const client = new HaystackClient(testHaystackConfig, mockFetch as unknown as typeof fetch)
    const { clientStream, agentStream } = createInProcessStreams()

    const agentHandler = createHaystackAcpAgent({ client, pipelineConfig: testPipelineConfig })
    new AgentSideConnection(agentHandler, agentStream)

    const clientHandler: (agent: Agent) => Client = () => ({
      sessionUpdate: async () => {},
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
    })
    const conn = new ClientSideConnection(clientHandler, clientStream)

    await conn.initialize({
      clientInfo: { name: 'Test', version: '1.0.0' },
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })

    const session = await conn.newSession({ cwd: '.', mcpServers: [] })
    const result = await conn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'test' }],
    })

    expect(result.stopReason).toBe('end_turn')
    expect((result._meta as Record<string, unknown>).haystackDocuments).toEqual([])
  })
})
