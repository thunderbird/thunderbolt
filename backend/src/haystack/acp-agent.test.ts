import { describe, expect, it, mock } from 'bun:test'
import { AgentSideConnection, ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import type { Client, Agent, SessionNotification } from '@agentclientprotocol/sdk'
import { createHaystackAcpAgent, formatDocumentResults } from './acp-agent'
import { HaystackClient } from './client'
import type { HaystackDocumentMeta, HaystackPipelineConfig, DeepsetResultPayload } from './types'

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

    const { handler: agentHandler } = createHaystackAcpAgent({ client, pipelineConfig: testPipelineConfig })
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

    const { handler: agentHandler } = createHaystackAcpAgent({ client, pipelineConfig: testPipelineConfig })
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

    const { handler: agentHandler } = createHaystackAcpAgent({ client, pipelineConfig: testPipelineConfig })
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

    const { handler: agentHandler } = createHaystackAcpAgent({ client, pipelineConfig: testPipelineConfig })
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

  it('should advertise loadSession capability', async () => {
    const mockFetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ search_session_id: 's1' }), { status: 201 })),
    )
    const client = new HaystackClient(testHaystackConfig, mockFetch as unknown as typeof fetch)
    const { clientStream, agentStream } = createInProcessStreams()

    const { handler: agentHandler } = createHaystackAcpAgent({ client, pipelineConfig: testPipelineConfig })
    new AgentSideConnection(agentHandler, agentStream)

    const clientHandler: (agent: Agent) => Client = () => ({
      sessionUpdate: async () => {},
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
    })
    const conn = new ClientSideConnection(clientHandler, clientStream)

    const initResult = await conn.initialize({
      clientInfo: { name: 'Test', version: '1.0.0' },
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })

    expect(initResult.agentCapabilities?.loadSession).toBe(true)
  })

  it('should store session mapping and restore via loadSession', async () => {
    const persistentSessions = new Map<string, string>()
    const mockFetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ search_session_id: 'haystack-abc' }), { status: 201 })),
    )
    const client = new HaystackClient(testHaystackConfig, mockFetch as unknown as typeof fetch)

    // First connection: create session
    const streams1 = createInProcessStreams()
    const { handler: handler1 } = createHaystackAcpAgent({
      client,
      pipelineConfig: testPipelineConfig,
      persistentSessions,
    })
    new AgentSideConnection(handler1, streams1.agentStream)

    const clientHandler: (agent: Agent) => Client = () => ({
      sessionUpdate: async () => {},
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
    })
    const conn1 = new ClientSideConnection(clientHandler, streams1.clientStream)

    await conn1.initialize({
      clientInfo: { name: 'Test', version: '1.0.0' },
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    const session = await conn1.newSession({ cwd: '.', mcpServers: [] })

    // Verify persistent map was populated
    expect(persistentSessions.get(session.sessionId)).toBe('haystack-abc')

    // Second connection: load session (simulating reconnect)
    const streams2 = createInProcessStreams()
    const { handler: handler2 } = createHaystackAcpAgent({
      client,
      pipelineConfig: testPipelineConfig,
      persistentSessions,
    })
    new AgentSideConnection(handler2, streams2.agentStream)

    const conn2 = new ClientSideConnection(clientHandler, streams2.clientStream)
    await conn2.initialize({
      clientInfo: { name: 'Test', version: '1.0.0' },
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })

    // loadSession should succeed with the known sessionId
    const loadResult = await conn2.loadSession({ sessionId: session.sessionId, cwd: '.', mcpServers: [] })
    expect(loadResult).toBeDefined()
  })

  it('should reject loadSession for unknown session ID', async () => {
    const persistentSessions = new Map<string, string>()
    const mockFetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ search_session_id: 's1' }), { status: 201 })),
    )
    const client = new HaystackClient(testHaystackConfig, mockFetch as unknown as typeof fetch)
    const { clientStream, agentStream } = createInProcessStreams()

    const { handler: agentHandler } = createHaystackAcpAgent({
      client,
      pipelineConfig: testPipelineConfig,
      persistentSessions,
    })
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

    await expect(conn.loadSession({ sessionId: 'nonexistent', cwd: '.', mcpServers: [] })).rejects.toThrow()
  })

  it('should use search endpoint for DOCUMENT-type pipelines', async () => {
    const searchResult = {
      results: [
        {
          answers: [],
          documents: [
            {
              id: 'd1',
              content: 'EU regulation content',
              score: 0.95,
              file: { id: 'f1', name: 'regulation.pdf' },
              meta: { page_number: 1 },
            },
            {
              id: 'd2',
              content: 'Another document',
              score: 0.7,
              file: { id: 'f2', name: 'guide.pdf' },
              meta: {},
            },
          ],
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
      if (callCount === 2) {
        // getOutputType
        return Promise.resolve(new Response(JSON.stringify({ output_type: 'DOCUMENT' }), { status: 200 }))
      }
      // search
      return Promise.resolve(new Response(JSON.stringify(searchResult), { status: 200 }))
    })

    const client = new HaystackClient(testHaystackConfig, mockFetch as unknown as typeof fetch)
    const { clientStream, agentStream } = createInProcessStreams()

    const { handler: agentHandler } = createHaystackAcpAgent({ client, pipelineConfig: testPipelineConfig })
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
    const result = await conn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Find EU regulations' }],
    })

    expect(result.stopReason).toBe('end_turn')

    const meta = result._meta as Record<string, unknown>
    expect((meta.haystackDocuments as unknown[]).length).toBe(2)
    expect((meta.haystackReferences as unknown[]).length).toBe(2)

    // Should have sent formatted document results as session update
    const textUpdates = updates.filter((u) => {
      const update = u.update as { content?: { type: string; text: string } }
      return update.content?.type === 'text' && update.content.text.length > 0
    })
    expect(textUpdates.length).toBeGreaterThanOrEqual(1)

    const text = (textUpdates[0].update as { content: { text: string } }).content.text
    expect(text).toContain('Found 2 relevant documents')
    expect(text).toContain('[1] **regulation.pdf**')
    expect(text).toContain('[2] **guide.pdf**')

    // Should have sent _meta with references
    const metaUpdate = updates.find((u) => {
      const update = u.update as { _meta?: Record<string, unknown> }
      return update._meta?.haystackReferences
    })
    expect(metaUpdate).toBeTruthy()

    // search endpoint should have been called (not chatStream)
    const searchCall = mockFetch.mock.calls.find((call) => {
      const [url] = call as unknown as [string]
      return url.includes('/search')
    })
    expect(searchCall).toBeTruthy()

    const chatStreamCall = mockFetch.mock.calls.find((call) => {
      const [url] = call as unknown as [string]
      return url.includes('/chat-stream')
    })
    expect(chatStreamCall).toBeUndefined()
  })
})

const makeDoc = (overrides: Partial<HaystackDocumentMeta> & { name?: string } = {}): HaystackDocumentMeta => ({
  id: overrides.id ?? 'd1',
  content: overrides.content ?? 'Default document content for testing purposes.',
  score: overrides.score ?? 0.9,
  file: { id: 'f1', name: overrides.name ?? 'report.pdf' },
})

describe('formatDocumentResults', () => {
  it('should format a single document with citation marker', () => {
    const result = formatDocumentResults([makeDoc()])

    expect(result).toContain('Found 1 relevant documents:')
    expect(result).toContain('[1] **report.pdf**')
    expect(result).toContain('> Default document content for testing purposes.')
  })

  it('should format multiple documents with sequential markers', () => {
    const docs = [
      makeDoc({ name: 'a.pdf', content: 'First doc' }),
      makeDoc({ id: 'd2', name: 'b.pdf', content: 'Second doc' }),
      makeDoc({ id: 'd3', name: 'c.pdf', content: 'Third doc' }),
    ]
    const result = formatDocumentResults(docs)

    expect(result).toContain('Found 3 relevant documents:')
    expect(result).toContain('[1] **a.pdf**')
    expect(result).toContain('[2] **b.pdf**')
    expect(result).toContain('[3] **c.pdf**')
  })

  it('should truncate long content at 300 chars with ellipsis', () => {
    const longContent = 'A'.repeat(400)
    const result = formatDocumentResults([makeDoc({ content: longContent })])

    expect(result).toContain('A'.repeat(300) + '...')
    expect(result).not.toContain('A'.repeat(301))
  })

  it('should not add ellipsis when content is exactly 300 chars', () => {
    const exactContent = 'B'.repeat(300)
    const result = formatDocumentResults([makeDoc({ content: exactContent })])

    expect(result).toContain('B'.repeat(300))
    expect(result).not.toContain('...')
  })

  it('should not add ellipsis for short content', () => {
    const result = formatDocumentResults([makeDoc({ content: 'Short.' })])

    expect(result).toContain('> Short.')
    expect(result).not.toContain('...')
  })

  it('should normalize whitespace in content', () => {
    const content = 'Line one\n\nLine two\t\ttabbed   spaced'
    const result = formatDocumentResults([makeDoc({ content })])

    expect(result).toContain('> Line one Line two tabbed spaced')
  })

  it('should handle content that is long before normalization but short after', () => {
    // 400 chars of whitespace-heavy content that collapses to < 300
    const content = Array.from({ length: 50 }, () => 'word').join('     ')
    const normalized = content.replace(/\s+/g, ' ').trim()

    const result = formatDocumentResults([makeDoc({ content })])

    if (normalized.length <= 300) {
      expect(result).not.toContain('...')
    } else {
      expect(result).toContain('...')
    }
  })

  it('should return header for empty array', () => {
    const result = formatDocumentResults([])

    expect(result).toContain('Found 0 relevant documents:')
  })
})
